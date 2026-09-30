'use strict';

/**
 * 专门检查「视频信息解析」在各种分辨率下的正确性。
 * ffmpeg 输出长行时会自动折行（管道下默认 80 列），如果解析按单行取，
 * 分辨率或帧率被折到第二行就会读不到，进而用错画布尺寸/帧率。
 *
 * 运行： node tools/probe-check.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.probe-check');
const fflib = require(path.join(ROOT, 'app', 'lib', 'ffmpeg.js'));

const cases = [
  { name: '标清 640x360', args: ['-s', '640x360', '-r', '30'] },
  { name: '1080p 30fps', args: ['-s', '1920x1080', '-r', '30'] },
  { name: '1080p 25fps', args: ['-s', '1920x1080', '-r', '25'] },
  { name: '4K 3840x2160 30fps', args: ['-s', '3840x2160', '-r', '30'] },
  { name: '竖屏 1080x1920 60fps', args: ['-s', '1080x1920', '-r', '60'] },
  { name: '非常规 1440x1080 23.976', args: ['-s', '1440x1080', '-r', '23.976'] },
];

let fails = 0;

function main() {
  const info = fflib.locate();
  if (!info) { console.error('没有找到 ffmpeg'); process.exit(1); }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  console.log('== 视频信息解析自检 ==\n');

  for (const c of cases) {
    const file = path.join(TMP, c.name.replace(/[^\w]+/g, '_') + '.mp4');
    spawnSync(info.path, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=${c.args[1]}:r=${c.args[3]}:d=1`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', file],
      { windowsHide: true });

    const want = /(\d+)x(\d+)/.exec(c.args[1]);
    const wantFps = Number(c.args[3]);
    const got = fflib.probeMedia(info.path, file);

    const wOk = got.width === Number(want[1]);
    const hOk = got.height === Number(want[2]);
    const fOk = got.fps != null && Math.abs(got.fps - wantFps) < 0.1;
    const dOk = got.duration != null && Math.abs(got.duration - 1) < 0.2;

    const pass = wOk && hOk && fOk && dOk;
    if (!pass) fails++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      期望 ${want[1]}x${want[2]} ${wantFps}fps | 读到 ` +
      `${got.width}x${got.height} ${got.fps}fps 时长=${got.duration}`);
    if (!pass) {
      const raw = spawnSync(info.path, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true }).stderr;
      console.log('      ffmpeg 原始输出片段：');
      raw.split(/\r?\n/).filter((l) => /Stream|Duration/.test(l)).forEach((l) => console.log('        |' + l));
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n== ${fails ? '失败 ' + fails + ' 项' : '全部通过'} ==`);
  process.exit(fails ? 1 : 0);
}

main();
