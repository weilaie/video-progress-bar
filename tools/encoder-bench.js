'use strict';

/**
 * 带透明通道的编码器横评：速度 / 体积 / 透明通道是否保留。
 * 用一张「接近真实」的 1080p 叠加层画面（99% 透明 + 一条进度条 + 标题块）。
 *
 * 运行： node tools/encoder-bench.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.enc-bench');
const fflib = require(path.join(ROOT, 'app', 'lib', 'ffmpeg.js'));
const FF = fflib.locate().path;
const N = 60;            // 测 60 帧

function ff(args, opts) {
  return spawnSync(FF, ['-hide_banner', ...args],
    Object.assign({ encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, opts || {}));
}

function makeFrame(W, H, file) {
  ff(['-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H},format=rgba`,
    '-vf', [
      `drawbox=x=96:y=${H - 70}:w=${W - 192}:h=10:color=white@0.3:t=fill:replace=1`,
      `drawbox=x=96:y=${H - 70}:w=${Math.round((W - 192) * 0.42)}:h=10:color=white@1:t=fill:replace=1`,
      `drawbox=x=96:y=${H - 140}:w=420:h=44:color=white@1:t=fill:replace=1`,
      `drawbox=x=${W - 520}:y=${H - 110}:w=200:h=26:color=white@0.9:t=fill:replace=1`,
      `drawbox=x=${W - 700}:y=${H - 108}:w=160:h=26:color=white@0.9:t=fill:replace=1`,
    ].join(','),
    '-frames:v', '1', '-y', file]);
  return fs.readFileSync(file);
}

function countFrames(file) {
  const r = ff(['-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']);
  const m = /frame=\s*(\d+)/.exec(String(r.stderr || ''));
  return m ? Number(m[1]) : -1;
}

/** 解码第一帧，检查是不是真的还有透明通道 */
function alphaProfile(file) {
  const raw = path.join(TMP, 'a.raw');
  const r = ff(['-i', file, '-frames:v', '1', '-vf', 'alphaextract,format=gray8', '-f', 'rawvideo', '-y', raw]);
  if (r.status !== 0 || !fs.existsSync(raw)) return null;
  const b = fs.readFileSync(raw);
  let zero = 0, full = 0, mid = 0;
  for (let i = 0; i < b.length; i += 7) {
    if (b[i] === 0) zero++; else if (b[i] > 250) full++; else mid++;
  }
  return { zero, full, mid };
}

function run(name, ext, args) {
  const src = fs.readFileSync(path.join(TMP, 'frame.png'));
  const out = path.join(TMP, 'out' + ext);
  const input = Buffer.concat(Array.from({ length: N }, () => src));
  const rgb = args.filter((a) => a !== '-c:v');
  const t0 = Date.now();
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', '30', '-i', '-',
    ...args, '-y', out],
    { input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const ms = (Date.now() - t0) / N;
  if (r.status !== 0 || !fs.existsSync(out)) {
    console.log(`  ${name}: 失败 ${String(r.stderr).slice(0, 120)}`);
    return null;
  }
  const kb = fs.statSync(out).size / N / 1024;
  const frames = countFrames(out);
  const ap = alphaProfile(out);
  const hasAlpha = ap && ap.mid > 0 && ap.zero > ap.full;
  console.log(`  ${ms.toFixed(1).padStart(6)} ms/帧  ${kb.toFixed(0).padStart(5)} KB/帧  ` +
    `${frames}/${N} 帧  alpha=${hasAlpha ? '有' : '无'}  ${name}`);
  return { ms, kb, hasAlpha };
}

function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const W = 1920, H = 1080;
  console.log(`ffmpeg: ${FF}`);
  console.log(`CPU   : ${os.cpus().length} 核`);
  console.log(`测试  : ${W}x${H} 叠加层（99% 透明），连续编码 ${N} 帧\n`);
  makeFrame(W, H, path.join(TMP, 'frame.png'));
  console.log(`单帧 PNG 参考大小：${(fs.statSync(path.join(TMP, 'frame.png')).size / 1024).toFixed(0)} KB\n`);

  console.log('=== 当前默认 ===');
  run('ProRes 4444（当前 qscale 4）', '.mov',
    ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '4', '-threads', '7']);

  console.log('\n=== ProRes 4444 不同质量档 ===');
  run('ProRes 4444 qscale 8', '.mov',
    ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '8', '-threads', '7']);
  run('ProRes 4444 qscale 16', '.mov',
    ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '16', '-threads', '7']);
  run('ProRes 4444 qscale 24', '.mov',
    ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '24', '-threads', '7']);

  console.log('\n=== 其它能带透明通道的编码器 ===');
  run('QuickTime 动画 qtrle（经典带 alpha 的 mov）', '.mov',
    ['-c:v', 'qtrle', '-pix_fmt', 'argb']);
  run('QuickTime PNG compression 1', '.mov',
    ['-c:v', 'png', '-pix_fmt', 'rgba', '-compression_level', '1', '-threads', '7']);
  run('QuickTime PNG compression 0（不压缩）', '.mov',
    ['-c:v', 'png', '-pix_fmt', 'rgba', '-compression_level', '0', '-threads', '7']);
  run('FFV1（无损，mov）', '.mov',
    ['-c:v', 'ffv1', '-level', '1', '-pix_fmt', 'yuva444p10le', '-threads', '7']);

  console.log('\n=== 参考：不带透明通道 ===');
  run('H.264 crf 16 fast（无 alpha）', '.mp4', ['-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-threads', '7']);
  run('H.264 crf 20 ultrafast（无 alpha）', '.mp4', ['-c:v', 'libx264', '-crf', '20', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '7']);

  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
