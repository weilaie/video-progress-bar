'use strict';

/**
 * 完整界面流程测试：真的往界面里填视频路径 → 点导出 → 检查成品时长是否和素材一致。
 * 这是为了抓「导出时长不对」这类只有走界面才会出现的问题。
 *
 * 运行： node tools/ui-flow.js
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.ui-flow');
const PORT = 8793;
const DBG_PORT = 9334;
const BASE = `http://127.0.0.1:${PORT}`;
const fflib = require(path.join(ROOT, 'app', 'lib', 'ffmpeg.js'));

let failures = 0;
function ok(name, cond, extra) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   >>> ' + (extra === undefined ? '' : extra)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    await sleep(400);
  }
  throw new Error('超时：' + label);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); }
      }, 600000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || '页面脚本报错');
    return r.result ? r.result.value : undefined;
  }
}

function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

async function main() {
  const ff = fflib.locate();
  if (!ff) { console.error('没有 ffmpeg'); process.exit(1); }
  const edge = findEdge();
  if (!edge) { console.error('没有 Edge'); process.exit(1); }

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // 造一段「像真的」的素材：20 秒、1280x720、30fps、带音轨
  const video = path.join(TMP, 'source.mp4');
  console.log('生成素材（20 秒 1080p 30fps 带音轨）…');
  spawnSync(ff.path, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-y', video], { windowsHide: true });
  const srcProbe = fflib.probeMedia(ff.path, video);
  console.log(`素材：${srcProbe.width}x${srcProbe.height} ${srcProbe.fps}fps ${srcProbe.duration}s\n`);

  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js')], {
    env: Object.assign({}, process.env, { VBAR_PORT: String(PORT), VBAR_NO_BROWSER: '1' }),
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (b) => { serverLog += b.toString(); });
  server.stderr.on('data', (b) => { serverLog += b.toString(); });

  const profile = path.join(TMP, 'edge-profile');
  const browser = spawn(edge, ['--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${DBG_PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });

  try {
    await waitFor(async () => (await fetch(BASE + '/api/ping')).ok, 20000, '服务启动');
    const target = await waitFor(async () => {
      const list = await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`).then((r) => r.json());
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }, 30000, '浏览器调试端口');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('连接失败')));
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('[1] 打开界面并填入视频路径');
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(2500);
    await cdp.evaluate(`(() => {
      const el = document.getElementById('videoPath');
      el.value = ${JSON.stringify(video)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const meta = await waitFor(async () => {
      const t = await cdp.evaluate('document.getElementById("videoMeta").textContent');
      return t && t.indexOf('时长') >= 0 ? t : null;
    }, 30000, '读取素材信息');
    console.log('    界面显示：' + meta.replace(/\s+/g, ' ').trim());

    const stateInfo = JSON.parse(await cdp.evaluate(`JSON.stringify({
      canvasW: document.getElementById('canvasW').value,
      canvasH: document.getElementById('canvasH').value,
      fps: document.getElementById('fps').value,
      estimate: document.getElementById('estimate').textContent
    })`));
    console.log('    画布 ' + stateInfo.canvasW + 'x' + stateInfo.canvasH + ' 帧率 ' + stateInfo.fps);
    console.log('    ' + stateInfo.estimate.replace(/\s+/g, ' ').trim());
    ok('界面读到的帧率是 30', String(stateInfo.fps) === '30', stateInfo.fps);
    ok('界面读到的画布是 1920x1080',
      stateInfo.canvasW === '1920' && stateInfo.canvasH === '1080',
      stateInfo.canvasW + 'x' + stateInfo.canvasH);

    // 界面上显示的预计帧数应该等于 时长 x 帧率
    const estFrames = Number((/将导出\s*(\d+)\s*帧/.exec(stateInfo.estimate) || [])[1]);
    ok('预计帧数 = 20 秒 × 30 帧 = 600', Math.abs(estFrames - 600) <= 2, String(estFrames));

    console.log('\n[2] 在界面上点「开始导出」');
    // 导出前、同一页面、同样内容：先量一次基准，用来和导出过程中的耗时对比
    const pre = JSON.parse(await cdp.evaluate(`(async () => {
      const cfg = window.__vbar.state.cfg;
      const toBlob = (cv) => new Promise((r) => cv.toBlob(r, 'image/png'));
      async function bench(w, h, label) {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        const scene = JSON.parse(JSON.stringify(cfg));
        scene.canvas.width = w; scene.canvas.height = h;
        for (let i = 0; i < 3; i++) { VBarScene.renderScene(ctx, scene, i, { clear: true }); await toBlob(cv); }
        const t0 = performance.now();
        for (let i = 0; i < 12; i++) { VBarScene.renderScene(ctx, scene, i, { clear: true }); await toBlob(cv); }
        return { label, ms: (performance.now() - t0) / 12 };
      }
      const a = await bench(cfg.canvas.width, cfg.canvas.height, '整帧');
      const b = await bench(cfg.canvas.width, 240, '只内容带(高240)');
      const steps = [a, b];
      // 逐项排除：看是什么把每次 toBlob 拖到了 16ms
      // 用 OffscreenCanvas 编码（不参与页面合成，应该不受帧同步影响）
      const off = new OffscreenCanvas(cfg.canvas.width, cfg.canvas.height);
      const octx = off.getContext('2d');
      const scene = JSON.parse(JSON.stringify(cfg));
      for (let i = 0; i < 3; i++) { VBarScene.renderScene(octx, scene, i, { clear: true }); await off.convertToBlob({ type: 'image/png' }); }
      const t1 = performance.now();
      for (let i = 0; i < 12; i++) { VBarScene.renderScene(octx, scene, i, { clear: true }); await off.convertToBlob({ type: 'image/png' }); }
      steps.push({ label: 'OffscreenCanvas 编码', ms: (performance.now() - t1) / 12 });
      // 停掉常驻 rAF 循环后再用普通 canvas 编码
      window.__vbar.pauseRAF(true);
      await new Promise((r) => setTimeout(r, 200));
      steps.push(await bench(cfg.canvas.width, cfg.canvas.height, '停掉 rAF 后普通 canvas'));
      window.__vbar.pauseRAF(false);
      return JSON.stringify(steps);
    })()`));
    pre.forEach((r) => console.log(`    导出前基准 ${r.label}：${r.ms.toFixed(1)} ms/帧`));
    const exportT0 = Date.now();
    await cdp.evaluate(`(() => {
      document.getElementById('outputName').value = 'uiflow';
      document.getElementById('outputName').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('outputDir').value = ${JSON.stringify(TMP)};
      document.getElementById('outputDir').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('overwrite').checked = true;
      document.getElementById('btnExport').click();
      return true;
    })()`);

    const status = await waitFor(async () => {
      const t = await cdp.evaluate('document.getElementById("exportStatus").textContent');
      if (!t) return null;
      if (t.indexOf('完成') >= 0 || t.indexOf('失败') >= 0) return t;
      return null;
    }, 600000, '导出完成');
    const exportSec = (Date.now() - exportT0) / 1000;
    console.log('    ' + status.replace(/\s+/g, ' ').trim());
    console.log(`    导出耗时 ${exportSec.toFixed(1)} 秒 / 600 帧 = ${(exportSec * 1000 / 600).toFixed(1)} ms/帧`);
    console.log(`    （1080p 一分钟 30 帧的视频约需 ${Math.round(exportSec * 1000 / 600 * 1800 / 1000)} 秒）`);
    ok('导出成功完成', status.indexOf('完成') >= 0 && status.indexOf('失败') < 0, status);

    const dbg = JSON.parse(await cdp.evaluate(`(async () => {
      const id = window.__vbar.jobId();
      const r = await fetch('/api/status?job=' + id).then((x) => x.json());
      return JSON.stringify({ clientSent: window.__vbar.sentFrames(), jobId: id, server: r.status, stderr: r.stderr, timing: window.__vbar.timing() });
    })()`));
    console.log('    客户端记录已发送 ' + dbg.clientSent + ' 帧');
    console.log('    服务端记录收到   ' + dbg.server.frames + ' 帧 / 共 ' + dbg.server.frameCount + ' 帧');
    if (dbg.timing) {
      const n = dbg.timing.total;
      console.log(`    时间拆解（每帧）：绘制 ${(dbg.timing.renderMs / n).toFixed(1)}ms + ` +
        `PNG编码 ${(dbg.timing.blobMs / n).toFixed(1)}ms + 等后台 ${(dbg.timing.waitMs / n).toFixed(1)}ms`);
    }
    // 导出结束后（后台已空闲）再测一次同样的 PNG 编码，用来分辨「编码本身慢」还是「被后台抢了 CPU」
    const micro = JSON.parse(await cdp.evaluate(`(async () => {
      const cv = document.createElement('canvas');
      cv.width = 1280; cv.height = 720;
      const c2 = cv.getContext('2d');
      const cfg = window.__vbar.state.cfg;
      const toBlob = () => new Promise((r) => cv.toBlob(r, 'image/png'));
      for (let i = 0; i < 3; i++) { VBarScene.renderScene(c2, cfg, i, { clear: true }); await toBlob(); }
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) { VBarScene.renderScene(c2, cfg, i, { clear: true }); await toBlob(); }
      return JSON.stringify({ ms: (performance.now() - t0) / 20 });
    })()`));
    console.log(`    对照：后台空闲时同样画布 PNG 编码 ${micro.ms.toFixed(1)} ms/帧`);
    if (dbg.stderr) console.log('    ffmpeg 输出：\n' + dbg.stderr.split('\n').slice(-6).map((l) => '      ' + l).join('\n'));
    ok('服务端收到的帧数 = 客户端发送的帧数',
      dbg.server.frames === dbg.clientSent, `${dbg.server.frames} vs ${dbg.clientSent}`);

    const out = await cdp.evaluate('document.getElementById("afterExport").dataset.path');
    console.log('    输出文件：' + out);
    ok('输出文件存在', out && fs.existsSync(out), String(out));

    console.log('\n[3] 检查成品时长');
    const outProbe = fflib.probeMedia(ff.path, out);
    console.log(`    成品：${outProbe.width}x${outProbe.height} ${outProbe.fps}fps ${outProbe.duration}s`);
    ok('成品时长 = 素材时长（20 秒）',
      Math.abs(outProbe.duration - srcProbe.duration) < 0.3,
      `素材 ${srcProbe.duration}s vs 成品 ${outProbe.duration}s`);
    ok('成品分辨率 = 素材分辨率',
      outProbe.width === srcProbe.width && outProbe.height === srcProbe.height,
      `${outProbe.width}x${outProbe.height}`);
    ok('成品帧率 = 素材帧率', Math.abs(outProbe.fps - srcProbe.fps) < 0.1,
      `${outProbe.fps} vs ${srcProbe.fps}`);

    // 用 ffmpeg 直接数帧数，最可靠
    const countFrames = (file) => {
      const r = spawnSync(ff.path, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'],
        { encoding: 'utf8', windowsHide: true });
      const m = /frame=\s*(\d+)/.exec((r.stderr || '') + (r.stdout || ''));
      return m ? Number(m[1]) : -1;
    };
    const srcFrames = countFrames(video);
    const outFrames = countFrames(out);
    console.log(`    帧数：素材 ${srcFrames} 帧，成品 ${outFrames} 帧`);
    ok('成品帧数和素材一致', Math.abs(outFrames - srcFrames) <= 2, `${outFrames} vs ${srcFrames}`);

  } catch (e) {
    console.error('\n测试中断：' + (e && e.message));
    failures++;
  } finally {
    try { browser.kill(); } catch (_) {}
    try { server.kill(); } catch (_) {}
  }

  if (failures && serverLog) console.log('\n服务端日志：\n' + serverLog.slice(-1200));
  console.log('\n== ' + (failures ? `失败 ${failures} 项` : '全部通过') + ' ==');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
