'use strict';

/**
 * 浏览器端「渲染 + PNG 编码」拆解：
 * 逐个打开/关闭阴影、圆点、文字等，找出真正拖慢的地方。
 *
 * 运行： node tools\render-bench.js
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.render-bench');
const PORT = 8798;
const DBG_PORT = 9335;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    await sleep(300);
  }
  throw new Error('超时：' + label);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout')); } }, 300000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'err');
    return r.result ? r.result.value : undefined;
  }
}

function findEdge() {
  for (const c of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function main() {
  const edge = findEdge();
  if (!edge) { console.error('没有 Edge'); process.exit(1); }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js')], {
    env: Object.assign({}, process.env, { VBAR_PORT: String(PORT), VBAR_NO_BROWSER: '1' }),
    windowsHide: true, stdio: 'ignore',
  });
  const browser = spawn(edge, ['--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${DBG_PORT}`, `--user-data-dir=${path.join(TMP, 'prof')}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });

  try {
    await waitFor(async () => (await fetch(BASE + '/api/ping')).ok, 20000, '服务');
    const target = await waitFor(async () => {
      const list = await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`).then((r) => r.json());
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }, 30000, '浏览器');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: BASE + '/dev-verify.html' });
    await waitFor(async () => {
      const t = await cdp.evaluate('document.getElementById("out") ? document.getElementById("out").textContent : ""');
      return t && t.includes('SUMMARY');
    }, 30000, '页面');

    const result = await cdp.evaluate(`(async () => {
      const W = 1280, H = 720;
      const out = [];
      const toBlob = (cv) => new Promise((r) => cv.toBlob(r, 'image/png'));
      async function bench(label, mutate) {
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const ctx = cv.getContext('2d');
        const cfg = VBarScene.defaultConfig();
        cfg.canvas = { width: W, height: H, fps: 30, duration: 20 };
        cfg.chapters = [{start:0,title:'第一段'},{start:7,title:'第二段'},{start:14,title:'第三段'}];
        if (mutate) mutate(cfg);
        for (let i = 0; i < 3; i++) { VBarScene.renderScene(ctx, cfg, i, {clear:true}); await toBlob(cv); }
        const N = 15;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          VBarScene.renderScene(ctx, cfg, (i / N) * 20, { clear: true });
          await toBlob(cv);
        }
        const ms = (performance.now() - t0) / N;
        out.push(label.padEnd(30) + ms.toFixed(1).padStart(6) + ' ms/帧');
      }
      // 1. 全关：只有一条实心条
      await bench('全关（无阴影/无文字/无圆点）', (c) => {
        c.bar.glow = false; c.dot.show = false; c.title.mode = 'none'; c.time.mode = 'none';
      });
      // 2. 只加条阴影
      await bench('只开「进度条阴影」', (c) => {
        c.bar.glow = true; c.dot.show = false; c.title.mode = 'none'; c.time.mode = 'none';
      });
      // 3. 只加圆点
      await bench('只开「圆点」（带发光）', (c) => {
        c.bar.glow = false; c.dot.show = true; c.dot.glow = true; c.title.mode='none'; c.time.mode='none';
      });
      // 4. 只加文字
      await bench('只开「时间数字」', (c) => {
        c.bar.glow = false; c.dot.show = false; c.title.mode='none'; c.time.mode='currentTotal';
      });
      // 5. 只加章节标题
      await bench('只开「章节标题」', (c) => {
        c.bar.glow = false; c.dot.show = false; c.title.mode='all'; c.time.mode='none';
      });
      // 6. 全都开（默认外观）
      await bench('默认外观（全部打开）', null);
      // 7. 全开但关掉所有阴影
      await bench('全部打开但关闭所有阴影', (c) => {
        c.bar.glow = false; c.dot.glow = false; c.title.shadow = false; c.time.shadow = false;
      });
      return JSON.stringify(out);
    })()`);
    console.log('1280x720，每项 15 帧取平均：\n');
    JSON.parse(result).forEach((l) => console.log('  ' + l));
  } catch (e) {
    console.error('失败：' + e.message);
  } finally {
    try { browser.kill(); } catch (_) {}
    try { server.kill(); } catch (_) {}
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
