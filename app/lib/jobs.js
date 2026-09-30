'use strict';

/**
 * 导出任务：把浏览器逐帧渲染出来的 PNG 直接管道进 ffmpeg，
 * 一次性编码成带透明通道的成品。全程不落临时帧文件。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/** 编码线程数：留一个核给界面和浏览器渲染，其余全给编码 */
const THREADS = Math.max(1, Math.min(16, (os.cpus() || []).length - 1 || 1));

let seq = 0;
const jobs = new Map();

const FORMATS = {
  alpha_prores: {
    label: 'ProRes 4444（.mov，带透明通道）',
    ext: 'mov',
    alpha: true,
    note: '剪辑软件首选，透明通道最稳，颜色按 bt709 标准写入。',
  },
  alpha_qtpng: {
    label: 'QuickTime PNG（.mov，带透明通道，无损）',
    ext: 'mov',
    alpha: true,
    note: '逐像素完美无损，而且比 ProRes 更快，代价是文件略大。',
  },
  png_seq: {
    label: 'PNG 序列（文件夹，带透明通道）',
    ext: '',
    alpha: true,
    note: '万能兜底，任何软件都能导入序列帧。',
  },
  preview_mp4: {
    label: 'MP4 预览版（深色底，方便快速查看）',
    ext: 'mp4',
    alpha: false,
    note: '没有透明通道，适合自己确认效果或发给别人。',
  },
  key_mov: {
    label: '纯色底 MOV（便于抠像）',
    ext: 'mov',
    alpha: false,
    note: '整块纯色背景，适合在剪辑软件里抠掉背景。',
  },
};

/** 由画布尺寸/帧率/总帧数生成 ffmpeg 参数 */
function buildCommand(job) {
  const { cfg } = job;
  const W = job.canvas.width;
  const H = job.canvas.height;
  const fps = job.canvas.fps;
  const out = job.outputPath;

  const input = ['-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', '-'];

  // 统一按 bt709 做 RGB→YUV 转换并写进文件。
  // 不指定的话 swscale 默认用 bt601，而 1080p 剪辑软件一律按 bt709 解释，
  // 结果就是颜色整体偏掉（红发橙、蓝发紫）。
  const bt709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  const toBt709 = 'scale=out_color_matrix=bt709:out_range=tv';

  let args;
  switch (cfg.format) {
    case 'alpha_prores':
      args = [...input,
        '-vf', toBt709,
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
        '-qscale:v', '4', '-vendor', 'apl0', '-threads', String(THREADS),
        ...bt709,
        '-y', out];
      break;

    case 'alpha_qtpng':
      args = [...input,
        '-c:v', 'png', '-pix_fmt', 'rgba', '-compression_level', '3',
        '-threads', String(THREADS),
        '-y', out];
      break;

    case 'png_seq':
      args = [...input,
        '-c:v', 'png', '-pix_fmt', 'rgba', '-compression_level', '3',
        '-threads', String(THREADS),
        '-start_number', '1', '-y', path.join(out, 'frame_%05d.png')];
      break;

    case 'preview_mp4':
      args = [
        '-f', 'lavfi', '-i', `color=c=${shade(cfg.previewBg || '#14141a')}:s=${W}x${H}:r=${fps}`,
        ...input,
        '-filter_complex', `[0:v][1:v]overlay=format=auto,${toBt709},format=yuv420p`,
        '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-threads', String(THREADS),
        ...bt709,
        '-movflags', '+faststart', '-t', String(job.frameCount / fps),
        '-y', out];
      break;

    case 'key_mov':
      args = [
        '-f', 'lavfi', '-i', `color=c=${shade(cfg.keyColor || '#00FF00')}:s=${W}x${H}:r=${fps}`,
        ...input,
        '-filter_complex', `[0:v][1:v]overlay=format=auto,${toBt709},format=yuv444p10le`,
        '-c:v', 'prores_ks', '-profile:v', '4444', '-qscale:v', '4', '-threads', String(THREADS),
        ...bt709,
        '-t', String(job.frameCount / fps),
        '-y', out];
      break;

    default:
      throw new Error('未知的导出格式：' + cfg.format);
  }

  if (cfg.faststart && cfg.format === 'alpha_prores') {
    args.splice(args.length - 2, 0, '-movflags', '+faststart');
  }
  return args;
}

function shade(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return '0x14141a';
  return '0x' + m[1];
}

function startJob(cfg) {
  const ffmpegPath = cfg.ffmpegPath;
  if (!ffmpegPath) throw new Error('没有可用的 ffmpeg。');

  const canvas = cfg.canvas || {};
  const fps = Number(canvas.fps) || 30;
  const duration = Number(canvas.duration) || 0;
  const frameCount = Math.max(1, Math.round(duration * fps));

  const outPath = resolveOutput(cfg);
  if (cfg.format !== 'png_seq') {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
  } else {
    fs.mkdirSync(outPath, { recursive: true });
  }

  const id = String(++seq);
  const job = {
    id,
    cfg,
    canvas: { width: Math.round(canvas.width), height: Math.round(canvas.height), fps },
    frameCount,
    outputPath: outPath,
    frames: 0,
    phase: 'rendering',
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    progressText: '',
    stdin: null,
    child: null,
    stderrTail: '',
    cancelled: false,
  };

  const args = buildCommand(job);
  job.args = args;

  const child = spawn(ffmpegPath, args, { windowsHide: true });
  job.child = child;
  job.stdin = child.stdin;

  child.stdout.on('data', () => {});
  child.stderr.on('data', (buf) => {
    const text = buf.toString();
    job.stderrTail = (job.stderrTail + text).slice(-4000);
    const m = /frame=\s*(\d+)/.exec(text);
    if (m) job.progressText = `frame=${m[1]}`;
  });

  job.done = new Promise((resolve) => {
    child.on('error', (err) => {
      job.error = job.error || String(err && err.message || err);
      resolve();
    });
    child.on('close', (code) => {
      job.finishedAt = Date.now();
      if (code !== 0 && !job.cancelled) {
        job.error = job.error ||
          (job.stderrTail.trim().split(/\r?\n/).slice(-3).join('\n') || `ffmpeg 退出码 ${code}`);
        job.phase = 'failed';
      } else if (job.cancelled) {
        job.phase = 'cancelled';
      } else {
        job.phase = 'done';
      }
      resolve();
    });
  });

  child.stdin.on('error', () => { /* 关闭时可能报错，忽略 */ });

  jobs.set(id, job);
  return job;
}

function resolveOutput(cfg) {
  const dir = cfg.outputDir || path.join(require('os').homedir(), 'Videos', '进度条输出');
  let base = (cfg.outputName || '进度条').replace(/[\\/:*?"<>|]/g, '_').trim() || '进度条';
  if (cfg.format === 'png_seq') {
    return path.join(dir, base);
  }
  const ext = FORMATS[cfg.format] ? FORMATS[cfg.format].ext : 'mov';
  let full = path.join(dir, `${base}.${ext}`);
  let i = 1;
  while (fs.existsSync(full) && !cfg.overwrite) {
    full = path.join(dir, `${base}_${i}.${ext}`);
    i++;
  }
  return full;
}

function getJob(id) {
  return jobs.get(String(id)) || null;
}

function statusOf(job) {
  const elapsed = (job.finishedAt || Date.now()) - job.startedAt;
  const pct = job.frameCount ? Math.min(1, job.frames / job.frameCount) : 0;
  return {
    id: job.id,
    phase: job.phase,
    frames: job.frames,
    frameCount: job.frameCount,
    percent: Math.round(pct * 1000) / 10,
    elapsedMs: elapsed,
    etaMs: pct > 0.02 && job.phase === 'rendering'
      ? Math.max(0, Math.round(elapsed / pct * (1 - pct)))
      : null,
    outputPath: job.outputPath,
    error: job.error,
    detail: job.progressText,
  };
}

async function cancelJob(id) {
  const job = getJob(id);
  if (!job) return false;
  job.cancelled = true;
  job.phase = 'cancelled';
  try { job.stdin.end(); } catch (_) {}
  try { job.child.kill(); } catch (_) {}
  return true;
}

async function finishJob(id) {
  const job = getJob(id);
  if (!job) throw new Error('任务不存在');
  job.phase = 'encoding';
  try { job.stdin.end(); } catch (_) {}
  await job.done;
  return statusOf(job);
}

function cleanupOldJobs(maxAgeMs) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > (maxAgeMs || 6 * 3600 * 1000)) {
      jobs.delete(id);
    }
  }
}

module.exports = {
  FORMATS,
  startJob,
  getJob,
  statusOf,
  finishJob,
  cancelJob,
  cleanupOldJobs,
};
