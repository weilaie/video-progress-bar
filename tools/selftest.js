'use strict';

/**
 * 端到端自检：
 * 造一个测试视频 → 启动本地服务 → 探测素材 → 逐帧推送 → ffmpeg 编码
 * → 验证输出确实带透明通道、分辨率与帧数正确。
 *
 * 运行： node tools/selftest.js
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.selftest');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const fflib = require(path.join(ROOT, 'app', 'lib', 'ffmpeg.js'));

let failures = 0;
let checks = 0;

function ok(name, cond, extra) {
  checks++;
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? '  →  ' + extra : ''}`);
  }
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function ff(args) {
  const info = fflib.locate();
  const r = spawnSync(info.path, ['-hide_banner', ...args], { encoding: 'utf8', windowsHide: true });
  return r;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('等待超时：' + label);
}

async function postJson(url, body) {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

/** 读取 raw 灰度图里某个像素 */
function grayPixel(file, width, x, y) {
  const buf = fs.readFileSync(file);
  return buf[y * width + x];
}

async function main() {
  console.log('== 视频进度条工具 · 自检 ==\n');

  const info = fflib.locate();
  if (!info) throw new Error('没有找到 ffmpeg');
  console.log(`ffmpeg: ${info.path}\n        version ${info.version}\n`);

  rmrf(TMP);
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(path.join(TMP, 'preview'), { recursive: true });

  // ---------- 1. 造测试视频 ----------
  console.log('[1] 生成测试视频');
  const srcVideo = path.join(TMP, 'source.mp4');
  let r = ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', srcVideo]);
  ok('测试视频生成成功', fs.existsSync(srcVideo), r.stderr.slice(-300));

  // ---------- 2. 启动服务 ----------
  console.log('\n[2] 启动本地服务');
  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js')], {
    env: Object.assign({}, process.env, { VBAR_PORT: String(PORT), VBAR_NO_BROWSER: '1' }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (b) => { serverLog += b.toString(); });
  server.stderr.on('data', (b) => { serverLog += b.toString(); });

  try {
    await waitFor(async () => {
      const r2 = await fetch(BASE + '/api/ping');
      return r2.ok;
    }, 20000, '服务启动');
    ok('本地服务已响应', true);

    const env = await fetch(BASE + '/api/env').then((x) => x.json());
    ok('接口返回可用导出格式', Array.isArray(env.formats) && env.formats.length >= 5);

    // ---------- 3. 探测视频 ----------
    console.log('\n[3] 探测素材信息');
    const probe = await postJson('/api/probe', { file: srcVideo });
    ok('识别时长 3 秒', probe.ok && Math.abs(probe.duration - 3) < 0.2, JSON.stringify(probe));
    ok('识别分辨率 640x360', probe.width === 640 && probe.height === 360, `${probe.width}x${probe.height}`);
    ok('识别帧率 30', Math.abs(probe.fps - 30) < 0.1, String(probe.fps));

    // 探测一个不存在的文件，应该优雅报错
    const badProbe = await postJson('/api/probe', { file: path.join(TMP, 'nope.mp4') });
    ok('不存在的文件返回友好错误', badProbe.ok === false && !!badProbe.error);

    // ---------- 4. 造带透明通道的帧 ----------
    console.log('\n[4] 生成带透明通道的测试帧');
    const frameDir = path.join(TMP, 'frames');
    fs.mkdirSync(frameDir, { recursive: true });
    r = ff(['-f', 'lavfi', '-i', 'color=c=white:s=640x360,format=rgba',
      '-vf', "geq=r='255':g='255':b='255':a='255*(X/639)'",
      '-frames:v', '20', '-y', path.join(frameDir, 'f_%03d.png')]);
    const frameFiles = fs.readdirSync(frameDir).sort();
    ok('生成了 20 张 RGBA 帧', frameFiles.length === 20, String(frameFiles.length));
    const frameBufs = frameFiles.map((f) => fs.readFileSync(path.join(frameDir, f)));
    ok('帧携带透明通道（RGBA png）',
      ff(['-i', path.join(frameDir, 'f_001.png')]).stderr.includes('rgba'));

    // ---------- 5. 导出 ProRes 4444 ----------
    console.log('\n[5] 导出 ProRes 4444（透明通道）');
    const outDir = path.join(TMP, 'out');
    const started = await postJson('/api/start', {
      format: 'alpha_prores',
      outputDir: outDir,
      outputName: 'selftest',
      overwrite: true,
      canvas: { width: 640, height: 360, fps: 30, duration: 20 / 30 },
    });
    ok('导出任务创建成功', started.ok, JSON.stringify(started));
    ok('总帧数为 20', started.frameCount === 20, String(started.frameCount));

    for (let i = 0; i < frameBufs.length; i++) {
      const res = await fetch(`${BASE}/api/frame?job=${started.jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: frameBufs[i],
      });
      if (!res.ok) { ok(`第 ${i + 1} 帧推送`, false, await res.text()); break; }
    }
    const status1 = await fetch(`${BASE}/api/status?job=${started.jobId}`).then((x) => x.json());
    ok('20 帧全部送达', status1.status && status1.status.frames === 20,
      String(status1.status && status1.status.frames));

    const finished = await postJson('/api/finish', { jobId: started.jobId });
    ok('编码完成且无错误', finished.ok, JSON.stringify(finished).slice(0, 400));

    const outFile = finished.status && finished.status.outputPath;
    ok('输出文件存在', outFile && fs.existsSync(outFile), String(outFile));

    const outStat = fs.statSync(outFile);
    ok('输出文件不是空文件', outStat.size > 1000, outStat.size + ' bytes');

    const probeOut = ff(['-i', outFile]).stderr;
    ok('输出为 ProRes 4444', /prores \(4444\)/i.test(probeOut), probeOut.match(/Video: [^\n]*/)?.[0]);
    ok('输出为 640x360', /640x360/.test(probeOut));
    ok('输出时长约 0.67 秒', /Duration: 00:00:00\.6/.test(probeOut), probeOut.match(/Duration: [^,]*/)?.[0]);

    // 验证 alpha 真的存在且数值正确
    const alphaRaw = path.join(TMP, 'alpha.raw');
    ff(['-i', outFile, '-frames:v', '1', '-vf', 'alphaextract,format=gray8',
      '-f', 'rawvideo', '-y', alphaRaw]);
    const a0 = grayPixel(alphaRaw, 640, 0, 180);
    const aMid = grayPixel(alphaRaw, 640, 320, 180);
    const aEnd = grayPixel(alphaRaw, 640, 639, 180);
    ok('透明区域 alpha = 0', a0 === 0, `alpha=${a0}`);
    ok('中间 alpha 约为 128', Math.abs(aMid - 128) <= 3, `alpha=${aMid}`);
    ok('不透明区域 alpha = 255', aEnd === 255, `alpha=${aEnd}`);

    // ---------- 6. 导出 MP4 预览版 ----------
    console.log('\n[6] 导出 MP4 预览版（深色底）');
    const started2 = await postJson('/api/start', {
      format: 'preview_mp4',
      outputDir: path.join(TMP, 'out'),
      outputName: 'preview',
      overwrite: true,
      previewBg: '#14141a',
      canvas: { width: 640, height: 360, fps: 30, duration: 20 / 30 },
    });
    ok('预览版任务创建成功', started2.ok, JSON.stringify(started2));
    for (let i = 0; i < frameBufs.length; i++) {
      await fetch(`${BASE}/api/frame?job=${started2.jobId}`, {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: frameBufs[i],
      });
    }
    const finished2 = await postJson('/api/finish', { jobId: started2.jobId });
    ok('预览版编码完成', finished2.ok, JSON.stringify(finished2).slice(0, 300));
    const p2 = ff(['-i', finished2.status.outputPath]).stderr;
    ok('预览版是 h264 的 mp4', /h264/.test(p2) && /mp4/i.test(finished2.status.outputPath));

    // ---------- 6b. QuickTime PNG 与纯色底 MOV ----------
    console.log('\n[6b] 导出 QuickTime PNG（透明）与纯色底 MOV');
    const startedQ = await postJson('/api/start', {
      format: 'alpha_qtpng',
      outputDir: path.join(TMP, 'out'),
      outputName: 'qtpng',
      overwrite: true,
      canvas: { width: 640, height: 360, fps: 30, duration: 20 / 30 },
    });
    for (let i = 0; i < frameBufs.length; i++) {
      await fetch(`${BASE}/api/frame?job=${startedQ.jobId}`, {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: frameBufs[i],
      });
    }
    const finishedQ = await postJson('/api/finish', { jobId: startedQ.jobId });
    ok('QuickTime PNG 编码完成', finishedQ.ok, JSON.stringify(finishedQ).slice(0, 300));
    const rawQ = path.join(TMP, 'qt-alpha.raw');
    ff(['-i', finishedQ.status.outputPath, '-frames:v', '1', '-vf', 'alphaextract,format=gray8',
      '-f', 'rawvideo', '-y', rawQ]);
    ok('QuickTime PNG 保留透明通道',
      grayPixel(rawQ, 640, 0, 180) === 0 && grayPixel(rawQ, 640, 639, 180) === 255,
      `left=${grayPixel(rawQ, 640, 0, 180)} right=${grayPixel(rawQ, 640, 639, 180)}`);

    const startedK = await postJson('/api/start', {
      format: 'key_mov',
      outputDir: path.join(TMP, 'out'),
      outputName: 'key',
      overwrite: true,
      keyColor: '#00FF00',
      canvas: { width: 640, height: 360, fps: 30, duration: 20 / 30 },
    });
    for (let i = 0; i < frameBufs.length; i++) {
      await fetch(`${BASE}/api/frame?job=${startedK.jobId}`, {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: frameBufs[i],
      });
    }
    const finishedK = await postJson('/api/finish', { jobId: startedK.jobId });
    ok('纯色底 MOV 编码完成', finishedK.ok, JSON.stringify(finishedK).slice(0, 300));
    const keyProbe = ff(['-i', finishedK.status.outputPath]).stderr;
    ok('纯色底 MOV 不含透明通道（便于抠像）', !/yuva/.test(keyProbe),
      keyProbe.match(/Video: [^\n]*/)?.[0]);
    const rawK = path.join(TMP, 'key-rgb.raw');
    ff(['-i', finishedK.status.outputPath, '-frames:v', '1', '-vf', 'format=rgb24',
      '-f', 'rawvideo', '-y', rawK]);
    const kb = fs.readFileSync(rawK);
    const kOff = (180 * 640 + 0) * 3;
    ok('纯色底背景为绿色',
      kb[kOff] < 40 && kb[kOff + 1] > 200 && kb[kOff + 2] < 40,
      `rgb=${kb[kOff]},${kb[kOff + 1]},${kb[kOff + 2]}`);

    // ---------- 7. PNG 序列 ----------
    console.log('\n[7] 导出 PNG 序列');
    const started3 = await postJson('/api/start', {
      format: 'png_seq',
      outputDir: path.join(TMP, 'out'),
      outputName: 'seq',
      overwrite: true,
      canvas: { width: 640, height: 360, fps: 30, duration: 20 / 30 },
    });
    for (let i = 0; i < frameBufs.length; i++) {
      await fetch(`${BASE}/api/frame?job=${started3.jobId}`, {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: frameBufs[i],
      });
    }
    const finished3 = await postJson('/api/finish', { jobId: started3.jobId });
    const seqFiles = fs.existsSync(finished3.status.outputPath)
      ? fs.readdirSync(finished3.status.outputPath).filter((f) => f.endsWith('.png'))
      : [];
    ok('PNG 序列写出了 20 张图', seqFiles.length === 20, String(seqFiles.length));

    // ---------- 8. 异常处理 ----------
    console.log('\n[8] 异常处理');
    const badFormat = await postJson('/api/start', {
      format: 'nope', canvas: { width: 64, height: 64, fps: 30, duration: 1 },
    });
    ok('未知格式被拒绝', badFormat.ok === false && !!badFormat.error, JSON.stringify(badFormat));

    // ---------- 9. 素材浏览器接口 ----------
    console.log('\n[9] 内置素材浏览器接口');
    const drives = await fetch(BASE + '/api/drives').then((x) => x.json());
    ok('能列出磁盘分区', drives.ok && drives.drives.length >= 1, JSON.stringify(drives.drives));

    const ls = await fetch(BASE + '/api/ls?dir=' + encodeURIComponent(TMP)).then((x) => x.json());
    ok('能列目录', ls.ok && Array.isArray(ls.dirs) && Array.isArray(ls.files), JSON.stringify(ls).slice(0, 200));
    ok('目录列表里能认出自家的视频文件',
      ls.files.some((f) => f.name === 'source.mp4'),
      JSON.stringify(ls.files.map((f) => f.name)));
    ok('非视频文件被过滤掉',
      !ls.files.some((f) => f.name.endsWith('.raw') || f.name.endsWith('.mov')),
      JSON.stringify(ls.files.map((f) => f.name)));
    ok('上级目录可用', typeof ls.parent === 'string' && ls.parent.length > 0);

    const badLs = await fetch(BASE + '/api/ls?dir=' + encodeURIComponent(path.join(TMP, 'no-such-dir')))
      .then((x) => x.json());
    ok('不存在的目录返回友好错误', badLs.ok === false && !!badLs.error);

    // ---------- 10. 颜色准确性（bt709） ----------
    console.log('\n[10] 颜色准确性：导出后按 bt709 解回来，颜色必须和原图一致');
    const barsPng = path.join(TMP, 'bars.png');
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=640x360,format=rgba',
      '-vf', 'drawbox=x=0:y=0:w=160:h=360:color=red:t=fill:replace=1,' +
        'drawbox=x=160:y=0:w=160:h=360:color=lime:t=fill:replace=1,' +
        'drawbox=x=320:y=0:w=160:h=360:color=blue:t=fill:replace=1,' +
        'drawbox=x=480:y=0:w=160:h=360:color=white:t=fill:replace=1',
      '-frames:v', '1', '-y', barsPng]);
    const barsStarted = await postJson('/api/start', {
      format: 'alpha_prores',
      outputDir: path.join(TMP, 'out'),
      outputName: 'bars',
      overwrite: true,
      canvas: { width: 640, height: 360, fps: 30, duration: 3 / 30 },
    });
    const barsBuf = fs.readFileSync(barsPng);
    for (let i = 0; i < 3; i++) {
      await fetch(`${BASE}/api/frame?job=${barsStarted.jobId}&n=1`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: barsBuf,
      });
    }
    const barsDone = await postJson('/api/finish', { jobId: barsStarted.jobId });
    ok('颜色测试片导出成功', barsDone.ok, JSON.stringify(barsDone).slice(0, 200));

    const sampleAt = (file, x, y, vf) => {
      const raw = path.join(TMP, 'sample.raw');
      const a = ['-i', file, '-frames:v', '1'];
      if (vf) a.push('-vf', vf);
      a.push('-pix_fmt', 'rgba', '-f', 'rawvideo', '-y', raw);
      ff(a);
      const b = fs.readFileSync(raw);
      const o = (y * 640 + x) * 4;
      return [b[o], b[o + 1], b[o + 2], b[o + 3]];
    };
    const patches = [[80, '红'], [240, '绿'], [400, '蓝'], [560, '白']];
    const expect = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
    let colorOk = true;
    const seen = [];
    patches.forEach(([x, name], i) => {
      const p = sampleAt(barsDone.status.outputPath, x, 180, 'scale=in_color_matrix=bt709');
      seen.push(`${name}=${p[0]},${p[1]},${p[2]}`);
      const e = expect[i];
      if (Math.abs(p[0] - e[0]) > 2 || Math.abs(p[1] - e[1]) > 2 || Math.abs(p[2] - e[2]) > 2) colorOk = false;
    });
    ok('按 bt709 解回来颜色完全正确（剪辑软件就是这么解的）', colorOk, seen.join('  '));

    let differs = false;
    patches.forEach(([x], i) => {
      const p = sampleAt(barsDone.status.outputPath, x, 180, 'scale=in_color_matrix=bt601');
      const e = expect[i];
      if (Math.abs(p[0] - e[0]) > 3 || Math.abs(p[1] - e[1]) > 3 || Math.abs(p[2] - e[2]) > 3) differs = true;
    });
    ok('文件确实是 bt709（按 bt601 解会明显偏色）', differs);

    // ---------- 11. 批量推送 ----------
    console.log('\n[11] 批量推送帧');
    const batchJob = await postJson('/api/start', {
      format: 'alpha_qtpng',
      outputDir: path.join(TMP, 'out'),
      outputName: 'batch',
      overwrite: true,
      canvas: { width: 640, height: 360, fps: 30, duration: 6 / 30 },
    });
    const batchBody = Buffer.concat(Array.from({ length: 3 }, () => barsBuf));
    const batchRes = await fetch(`${BASE}/api/frame?job=${batchJob.jobId}&n=3`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: batchBody,
    }).then((x) => x.json());
    ok('一次请求推送 3 帧被正确计数', batchRes.ok && batchRes.frames === 3, JSON.stringify(batchRes));
    const batchStatus = await fetch(`${BASE}/api/status?job=${batchJob.jobId}`).then((x) => x.json());
    ok('任务状态里的帧数正确', batchStatus.status.frames === 3, String(batchStatus.status.frames));
    const batchFin = await postJson('/api/finish', { jobId: batchJob.jobId });
    ok('批量推送的内容编码成 3 帧视频', batchFin.ok, JSON.stringify(batchFin).slice(0, 200));
    const batchProbe = ff(['-i', batchFin.status.outputPath]).stderr;
    ok('批量帧没有丢帧（时长 0.1 秒）', /Duration: 00:00:00\.10/.test(batchProbe),
      batchProbe.match(/Duration: [^,]*/)?.[0]);
  } finally {
    server.kill();
  }

  console.log(`\n== 结果：${checks - failures}/${checks} 项通过 ==`);
  if (failures) {
    console.log('失败项需要修复。');
    if (serverLog) console.log('\n服务端日志：\n' + serverLog.slice(-2000));
    process.exit(1);
  }
  console.log('全部通过。');
}

main().catch((e) => {
  console.error('\n自检异常中断：', e);
  process.exit(1);
});
