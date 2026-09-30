'use strict';

/**
 * 导出速度 + 质量基准。
 * 造两张测试帧：一张「接近真实」（99% 透明 + 一条进度条），一张「最坏情况」（满屏细节）。
 * 用真实管道喂给 ffmpeg，比不同编码参数的速度和画质。
 *
 * 运行： node tools/bench.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.bench');
const fflib = require(path.join(ROOT, 'app', 'lib', 'ffmpeg.js'));
const FF = fflib.locate().path;

function ff(args, opts) {
  return spawnSync(FF, ['-hide_banner', ...args],
    Object.assign({ encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024 }, opts || {}));
}

function compareRGBA(a, b, w, h) {
  let sumR = 0, sumG = 0, sumB = 0, sumA = 0, seR = 0, seG = 0, seB = 0, seA = 0;
  let opaque = 0, maxErr = 0, alphaMax = 0;
  const total = w * h;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const dA = a[o + 3] - b[o + 3];
    sumA += Math.abs(dA); seA += dA * dA;
    alphaMax = Math.max(alphaMax, Math.abs(dA));
    if (a[o + 3] > 8) {
      const dR = b[o] - a[o], dG = b[o + 1] - a[o + 1], dB = b[o + 2] - a[o + 2];
      sumR += Math.abs(dR); sumG += Math.abs(dG); sumB += Math.abs(dB);
      seR += dR * dR; seG += dG * dG; seB += dB * dB;
      maxErr = Math.max(maxErr, Math.abs(dR), Math.abs(dG), Math.abs(dB));
      opaque++;
    }
  }
  const psnr = (se, n) => (n && se > 0) ? 10 * Math.log10(255 * 255 / (se / n)) : 99;
  return {
    bias: opaque ? [sumR / opaque, sumG / opaque, sumB / opaque] : [0, 0, 0],
    psnr: [psnr(seR, opaque), psnr(seG, opaque), psnr(seB, opaque)],
    maxErr, alphaMae: sumA / total, alphaPsnr: psnr(seA, total), alphaMax,
  };
}

function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const W = 1920, H = 1080;
  console.log(`ffmpeg : ${FF}`);
  console.log(`CPU    : ${os.cpus().length} 核\n`);

  // ---- 测试帧 A：接近真实（透明底 + 条 + 若干小块模拟文字） ----
  ff(['-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H},format=rgba`,
    '-vf', `drawbox=x=96:y=1010:w=1728:h=10:color=white@0.3:t=fill:replace=1,` +
      `drawbox=x=96:y=1010:w=700:h=10:color=white@1:t=fill:replace=1,` +
      `drawbox=x=96:y=940:w=420:h=44:color=white@1:t=fill:replace=1,` +
      `drawbox=x=1400:y=1040:w=200:h=26:color=white@0.9:t=fill:replace=1`,
    '-frames:v', '1', '-y', path.join(TMP, 'overlay.png')]);
  ff(['-i', path.join(TMP, 'overlay.png'), '-pix_fmt', 'rgba', '-f', 'rawvideo', '-y', path.join(TMP, 'overlay.raw')]);

  // ---- 测试帧 B：最坏情况（满屏细条纹 + 渐变 + alpha 渐变） ----
  ff(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H},format=rgba`,
    '-vf', `geq=r='255*bitand(X,1)':g='128*bitand(Y,2)':b='255*X/${W - 1}':a='255*Y/${H - 1}'`,
    '-frames:v', '1', '-y', path.join(TMP, 'detail.png')]);
  ff(['-i', path.join(TMP, 'detail.png'), '-pix_fmt', 'rgba', '-f', 'rawvideo', '-y', path.join(TMP, 'detail.raw')]);

  const overlayPng = fs.readFileSync(path.join(TMP, 'overlay.png'));
  const detailPng = fs.readFileSync(path.join(TMP, 'detail.png'));
  console.log(`测试帧 A（接近真实）：PNG ${(overlayPng.length / 1024).toFixed(0)} KB`);
  console.log(`测试帧 B（满屏细节）：PNG ${(detailPng.length / 1024).toFixed(0)} KB\n`);

  const variants = [
    {
      name: '现在用的（4444 + alpha16 + vendor）',
      args: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', '-alpha_bits', '16'],
    },
    {
      name: '4444（去掉 alpha_bits）',
      args: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le'],
    },
    {
      name: '4444 + qscale 6',
      args: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '6'],
    },
    {
      name: '4444 + qscale 4',
      args: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '4'],
    },
    {
      name: 'QuickTime PNG（无损 alpha）',
      args: ['-c:v', 'png', '-pix_fmt', 'rgba', '-compression_level', '3'],
    },
  ];

  console.log('== 编码速度（60 帧连续编码，1080p）==');
  const N = 60;
  const speeds = [];
  for (const v of variants) {
    const out = path.join(TMP, 'speed.mov');
    const t0 = Date.now();
    const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-vcodec', 'png', '-framerate', '30', '-i', '-',
      ...v.args, '-y', out],
      { input: Buffer.concat(Array.from({ length: N }, () => overlayPng)), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const ms = (Date.now() - t0) / N;
    if (r.status !== 0 || !fs.existsSync(out)) {
      console.log(`  ${v.name}: 失败 ${String(r.stderr).slice(-200)}`);
      continue;
    }
    const size = fs.statSync(out).size / N / 1024;
    speeds.push({ name: v.name, ms, size });
    console.log(`  ${ms.toFixed(1).padStart(6)} ms/帧   ${size.toFixed(0).padStart(6)} KB/帧   ${v.name}`);
  }
  if (speeds.length) {
    const base = speeds[0].ms;
    console.log('\n  相对现在的提速：');
    speeds.forEach((s) => console.log(`    ${(base / s.ms).toFixed(2)}×  ${s.name}`));
  }

  console.log('\n\n== 画质（最坏情况满屏细节，解码回来逐像素比）==');
  console.log('  参考：PSNR > 50dB 肉眼完全看不出差别；最大误差 ≤1 等于无损\n');
  const detailRaw = fs.readFileSync(path.join(TMP, 'detail.raw'));
  for (const v of variants) {
    const out = path.join(TMP, 'q.mov');
    const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-vcodec', 'png', '-framerate', '30', '-i', '-',
      ...v.args, '-y', out],
      { input: Buffer.concat([detailPng, detailPng, detailPng]), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !fs.existsSync(out)) continue;
    ff(['-i', out, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-y', path.join(TMP, 'dec.raw')]);
    if (!fs.existsSync(path.join(TMP, 'dec.raw'))) continue;
    const cmp = compareRGBA(detailRaw, fs.readFileSync(path.join(TMP, 'dec.raw')), W, H);
    console.log(`  ${v.name}`);
    console.log(`    RGB PSNR ${cmp.psnr.map((x) => x.toFixed(1)).join(' / ')} dB   最大误差 ${cmp.maxErr}   ` +
      `色偏 ${cmp.bias.map((x) => x.toFixed(2)).join('/')}`);
    console.log(`    Alpha MAE ${cmp.alphaMae.toFixed(2)}  最大误差 ${cmp.alphaMax}`);
  }

  console.log('\n\n== 3. ffmpeg 内部开销拆解（1080p）==');
  const N2 = 40;
  const overlayRaw = fs.readFileSync(path.join(TMP, 'overlay.raw'));
  const prores = ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '4'];

  let t1 = Date.now();
  spawnSync(FF, ['-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', '30', '-i', '-',
    ...prores, '-y', path.join(TMP, 'a.mov')],
    { input: Buffer.concat(Array.from({ length: N2 }, () => overlayPng)), windowsHide: true });
  const pngIn = (Date.now() - t1) / N2;

  t1 = Date.now();
  spawnSync(FF, ['-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', '30', '-i', '-',
    ...prores, '-y', path.join(TMP, 'b.mov')],
    { input: Buffer.concat(Array.from({ length: N2 }, () => overlayRaw)), windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  const rawIn = (Date.now() - t1) / N2;

  const bandH2 = 260;
  ff(['-i', path.join(TMP, 'overlay.png'), '-vf', `crop=${W}:${bandH2}:0:${H - bandH2}`,
    '-frames:v', '1', '-y', path.join(TMP, 'band.png')]);
  const bandPng = fs.readFileSync(path.join(TMP, 'band.png'));
  t1 = Date.now();
  spawnSync(FF, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H}:r=30`,
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', '30', '-i', '-',
    '-filter_complex', `[0][1]overlay=0:${H - bandH2},scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le`,
    ...prores, '-t', String(N2 / 30), '-y', path.join(TMP, 'c.mov')],
    { input: Buffer.concat(Array.from({ length: N2 }, () => bandPng)), windowsHide: true });
  const bandIn = (Date.now() - t1) / N2;

  console.log(`  PNG 整帧输入     ${pngIn.toFixed(1)} ms/帧   （当前方案）`);
  console.log(`  原始 RGBA 输入   ${rawIn.toFixed(1)} ms/帧   → PNG 解码约占 ${(pngIn - rawIn).toFixed(1)} ms`);
  console.log(`  只送内容带       ${bandIn.toFixed(1)} ms/帧   带高 ${bandH2}px，PNG 仅 ${(bandPng.length / 1024).toFixed(0)} KB`);
  console.log(`\n  浏览器侧：整帧 ≈ 8.7 ms/帧，只渲染内容带 ≈ 2~3 ms/帧`);
  console.log(`  结论：流水线并行，总耗时 ≈ 帧数 × max(浏览器, ffmpeg)`);

  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
