'use strict';

/**
 * ffmpeg 定位、能力探测与媒体信息解析。
 * 不依赖任何第三方包，仅使用 Node 内置模块。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

const REQUIRED_ENCODERS = ['prores_ks', 'png', 'libx264'];

/** 常见安装位置，按优先级排列 */
function candidatePaths() {
  const list = [];

  // 0) 工具自带目录
  list.push(path.join(ROOT, 'bin', 'ffmpeg.exe'));

  // 1) 用户上次手动指定的位置
  const saved = readSettings().ffmpegPath;
  if (saved) list.push(saved);

  // 2) 系统 PATH
  list.push('ffmpeg');
  list.push('ffmpeg.exe');

  // 3) 与具体用户无关的常见安装位置
  list.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  list.push('C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe');
  list.push(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));

  // 4) 用户在本机额外指定的位置（只读本机 config/settings.json，不会进代码仓库）
  for (const p of extraCandidates()) list.push(p);

  return list;
}

/**
 * 本机自定义的 ffmpeg 查找位置，两种写法任选其一：
 *   · config/settings.json 里的 ffmpegCandidates 数组
 *   · 环境变量 VIDEOBAR_FFMPEG（多个路径用 ; 分隔）
 * 每一项既可以写成 ffmpeg.exe 本身，也可以写成软件目录——
 * 写成目录时会自动再看该目录本身、以及它下一层的 ffmpeg.exe（适合剪映这类按版本号建子目录的软件）。
 */
function extraCandidates() {
  const out = [];
  const fromSettings = readSettings().ffmpegCandidates;
  const items = Array.isArray(fromSettings) ? fromSettings.slice() : [];
  items.push(...String(process.env.VIDEOBAR_FFMPEG || '').split(path.delimiter));
  for (const raw of items) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const p = raw.trim();
    out.push(p);
    out.push(path.join(p, 'ffmpeg.exe'));
    try {
      for (const dir of fs.readdirSync(p, { withFileTypes: true })) {
        if (dir.isDirectory()) out.push(path.join(p, dir.name, 'ffmpeg.exe'));
      }
    } catch (_) { /* 不是目录就跳过 */ }
  }
  return out;
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeSettings(patch) {
  const next = Object.assign(readSettings(), patch);
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (_) { /* 忽略写入失败 */ }
  return next;
}

/** 判断一个可执行文件能否正常作为 ffmpeg 使用 */
function verify(exe) {
  if (!exe) return null;
  if (exe !== 'ffmpeg' && exe !== 'ffmpeg.exe' && !fs.existsSync(exe)) return null;
  try {
    const r = spawnSync(exe, ['-hide_banner', '-version'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    const text = String(r.stdout || '') + String(r.stderr || '');
    if (!/ffmpeg version/i.test(text)) return null;
    const version = (text.match(/ffmpeg version\s+([^\s]+)/i) || [])[1] || '未知';
    return { path: exe, version, configuration: text };
  } catch (_) {
    return null;
  }
}

let cached = null;

/** 找到第一个可用的 ffmpeg */
function locate(force) {
  if (cached && !force) return cached;
  for (const cand of candidatePaths()) {
    const info = verify(cand);
    if (info) {
      cached = info;
      return info;
    }
  }
  cached = null;
  return null;
}

/** 检查关键编码器是否可用 */
function capabilities(ffmpegPath) {
  const info = verify(ffmpegPath);
  if (!info) return { ok: false, error: '无法运行该 ffmpeg', encoders: [] };
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  const text = String(r.stdout || '');
  const encoders = [];
  const missing = [];
  for (const name of REQUIRED_ENCODERS) {
    const has = new RegExp('\\s' + name + '\\s').test(text);
    if (has) encoders.push(name); else missing.push(name);
  }
  return {
    ok: missing.length === 0,
    version: info.version,
    path: ffmpegPath,
    encoders,
    missing,
    error: missing.length ? `该 ffmpeg 缺少编码器：${missing.join('、')}` : null,
  };
}

function hhmmssToSeconds(text) {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 用 `ffmpeg -i` 的输出解析媒体信息（无需 ffprobe）。
 * 返回 { duration, width, height, fps, rotation, hasAudio, format }
 */
function probeMedia(ffmpegPath, file) {
  if (!fs.existsSync(file)) {
    return { ok: false, error: '文件不存在：' + file };
  }
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const text = String(r.stderr || '') + String(r.stdout || '');

  const durMatch = /Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/.exec(text);
  const duration = durMatch ? hhmmssToSeconds(durMatch[1]) : null;

  // 找第一条视频流
  const lines = text.split(/\r?\n/);
  let videoLine = null;
  let hasAudio = false;
  for (const line of lines) {
    if (/Stream #\d+:\d+.*: Video:/.test(line) && !videoLine) videoLine = line;
    if (/Stream #\d+:\d+.*: Audio:/.test(line)) hasAudio = true;
  }

  if (!videoLine) {
    return { ok: false, error: '没有找到视频轨，请确认这是有效的视频文件。' };
  }
  if (!duration) {
    return { ok: false, error: '无法读取视频时长。' };
  }

  const dimMatch = /(\d{2,5})x(\d{2,5})/.exec(videoLine);
  let width = dimMatch ? Number(dimMatch[1]) : null;
  let height = dimMatch ? Number(dimMatch[2]) : null;

  const fpsMatch = /(\d+(?:\.\d+)?)\s*fps/.exec(videoLine);
  const fps = fpsMatch ? Number(fpsMatch[1]) : null;

  const rotMatch = /rotation of\s*(-?\d+(?:\.\d+)?)/.exec(text);
  let rotation = rotMatch ? Number(rotMatch[1]) : 0;
  rotation = ((rotation % 360) + 360) % 360;

  // 竖屏素材常见：容器里是 1920x1080 + 旋转 90 度，显示时其实是 1080x1920
  if ((rotation === 90 || rotation === 270) && width && height) {
    const t = width; width = height; height = t;
  }

  const fmtMatch = /Input #0,\s*([^,]+),/.exec(text);

  return {
    ok: true,
    file,
    duration,
    width,
    height,
    fps,
    rotation,
    hasAudio,
    format: fmtMatch ? fmtMatch[1].trim() : null,
  };
}

/** 抽一帧用于预览，返回 JPEG 二进制 */
function extractPreviewFrame(ffmpegPath, file, time, width) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, time)),
    '-i', file,
    '-frames:v', '1',
  ];
  if (width) args.push('-vf', `scale=${Math.round(width)}:-2`);
  args.push('-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', '-');

  const r = spawnSync(ffmpegPath, args, {
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) {
    return null;
  }
  return r.stdout;
}

function tempDir(name) {
  const dir = path.join(os.tmpdir(), 'vbar-' + name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  ROOT,
  CONFIG_DIR,
  SETTINGS_FILE,
  locate,
  verify,
  capabilities,
  probeMedia,
  extractPreviewFrame,
  tempDir,
  readSettings,
  writeSettings,
  candidatePaths,
};
