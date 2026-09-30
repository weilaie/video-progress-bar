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
  alpha_qtrle: {
    label: '透明视频 · QuickTime 动画（.mov，推荐）',
    ext: 'mov',
    alpha: true,
    note: '带透明通道、逐像素无损，速度最快、文件最小（大约只有 ProRes 的五分之一）。',
  },
  alpha_prores: {
    label: '透明视频 · ProRes 4444（.mov，兼容性最保险）',
    ext: 'mov',
    alpha: true,
    note: '如果上面那个在某些软件里导不进去，就用这个。文件大约大 5 倍、慢一倍。',
  },
  alpha_qtpng: {
    label: '透明视频 · QuickTime PNG（.mov，逐像素无损）',
    ext: 'mov',
    alpha: true,
    note: '逐像素完美无损，速度也快，代价是文件比「动画」大一些。',
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

  // 客户端只送了「有内容的横条」，这里贴回整帧。
  // pad 会把带子以外的区域补成完全透明。
  const band = cfg.band;
  const padFilter = (band && Number(band.h) < H)
    ? `pad=${W}:${H}:0:${Math.max(0, Math.round(band.y))}:color=black@0`
    : null;
  const vfChain = (extra) => {
    const parts = [];
    if (padFilter) parts.push(padFilter);
    if (extra) parts.push(extra);
    return parts.length ? parts.join(',') : null;
  };

  let args;
  switch (cfg.format) {
    case 'alpha_qtrle':
      // QuickTime 动画：纯 RGB 存储（argb），不做 YUV 转换，
      // 因此既逐像素无损，又不存在色彩矩阵问题。
      args = [...input,
        ...(vfChain(null) ? ['-vf', vfChain(null)] : []),
        '-c:v', 'qtrle', '-pix_fmt', 'argb',
        '-y', out];
      break;

    case 'alpha_prores':
      args = [...input,
        ...(vfChain(toBt709) ? ['-vf', vfChain(toBt709)] : []),
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
        '-qscale:v', '4', '-vendor', 'apl0', '-threads', String(THREADS),
        ...bt709,
        '-y', out];
      break;

    case 'alpha_qtpng':
      args = [...input,
        ...(vfChain(null) ? ['-vf', vfChain(null)] : []),
        '-c:v', 'png', '-pix_fmt', 'rgba', '-compression_level', '3',
        '-threads', String(THREADS),
        '-y', out];
      break;

    case 'png_seq':
      args = [...input,
        ...(vfChain(null) ? ['-vf', vfChain(null)] : []),
        '-c:v', 'png', '-pix_fmt', 'rgba', '-compression_level', '3',
        '-threads', String(THREADS),
        '-start_number', '1', '-y', path.join(out, 'frame_%05d.png')];
      break;

    case 'preview_mp4':
      args = [
        '-f', 'lavfi', '-i', `color=c=${shade(cfg.previewBg || '#14141a')}:s=${W}x${H}:r=${fps}`,
        ...input,
        '-filter_complex', `[0:v][1:v]overlay=format=auto,${padFilter ? padFilter + ',' : ''}${toBt709},format=yuv420p`,
        '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-threads', String(THREADS),
        ...bt709,
        '-movflags', '+faststart', '-t', String(job.frameCount / fps),
        '-y', out];
      break;

    case 'key_mov':
      args = [
        '-f', 'lavfi', '-i', `color=c=${shade(cfg.keyColor || '#00FF00')}:s=${W}x${H}:r=${fps}`,
        ...input,
        '-filter_complex', `[0:v][1:v]overlay=format=auto,${padFilter ? padFilter + ',' : ''}${toBt709},format=yuv444p10le`,
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
    nextSeq: 0,          // 下一批应该写入的序号，保证多批并发时顺序不乱
    freeSeq: 0,          // 没带序号的请求按到达顺序自动编号
    pendingFrames: new Map(),
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
        discardOutput(job);          // 半成品会显示成「已损坏」，直接清掉
      } else if (job.cancelled) {
        job.phase = 'cancelled';
        discardOutput(job);
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

/**
 * 删掉没写完的成品。
 * ffmpeg 的索引（moov）是最后才写的，中途被打断会留下一个「文件在、但打不开」
 * 的残片，用户会以为是工具坏了。所以失败或取消时直接清掉。
 */
function discardOutput(job) {
  if (!job || !job.outputPath || job.outputDiscarded) return;
  try {
    if (job.cfg.format === 'png_seq') {
      fs.rmSync(job.outputPath, { recursive: true, force: true });
    } else {
      fs.rmSync(job.outputPath, { force: true });
    }
    job.outputDiscarded = true;
  } catch (_) { /* 忽略 */ }
}

/** 导出完成后校验成品：时长和分辨率是否和预期一致 */
function verifyOutput(job) {
  const fflib = require('./ffmpeg');
  if (job.cfg.format === 'png_seq') {
    let n = 0;
    try { n = fs.readdirSync(job.outputPath).filter((f) => f.endsWith('.png')).length; } catch (_) {}
    return { ok: n >= job.frameCount, kind: 'sequence', frames: n, expectedFrames: job.frameCount };
  }
  const info = fflib.probeMedia(job.cfg.ffmpegPath, job.outputPath);
  if (!info.ok) return { ok: false, error: info.error };
  const expected = job.frameCount / job.canvas.fps;
  const okDuration = Math.abs(info.duration - expected) < 0.5;
  const okSize = info.width === job.canvas.width && info.height === job.canvas.height;
  return {
    ok: okDuration && okSize,
    duration: info.duration,
    expectedDuration: Math.round(expected * 100) / 100,
    width: info.width,
    height: info.height,
    expectedWidth: job.canvas.width,
    expectedHeight: job.canvas.height,
    okDuration,
    okSize,
  };
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
    outputDiscarded: !!job.outputDiscarded,
    verify: job.verify || null,
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
  // 等 ffmpeg 真正退出，再把没写完的成品删掉
  try { await job.done; } catch (_) {}
  discardOutput(job);
  return true;
}

async function finishJob(id) {
  const job = getJob(id);
  if (!job) throw new Error('任务不存在');
  job.phase = 'encoding';
  try { job.stdin.end(); } catch (_) {}
  await job.done;
  if (job.phase === 'failed' || job.error) {
    discardOutput(job);
    job.verify = { ok: false, error: job.error || '编码失败' };
  } else {
    job.verify = verifyOutput(job);
  }
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

/** 是否还有正在跑的导出任务（有的话后台不许自动退出） */
function hasActiveJob() {
  for (const [, job] of jobs) {
    if (job.phase === 'rendering' || job.phase === 'encoding') return true;
  }
  return false;
}

module.exports = {
  FORMATS,
  startJob,
  getJob,
  statusOf,
  finishJob,
  cancelJob,
  cleanupOldJobs,
  hasActiveJob,
};
