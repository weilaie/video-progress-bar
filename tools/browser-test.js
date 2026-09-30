'use strict';

/**
 * 真·浏览器端到端测试：用无头 Edge 打开页面，跑渲染自检、完整导出链路、
 * 以及主界面加载检查，并收集页面里的 JS 报错。
 *
 * 运行： node tools/browser-test.js
 */

const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8792;
const DBG_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;

function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error(`等待超时：${label}${lastErr ? ' (' + lastErr.message + ')' : ''}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 60000);
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description
        || 'evaluate 抛错');
    }
    return r.result ? r.result.value : undefined;
  }

  errors() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => {
        const d = e.params.exceptionDetails;
        return (d.exception && (d.exception.description || d.exception.value)) || d.text;
      });
  }
}

async function main() {
  const edge = findEdge();
  if (!edge) {
    console.error('没有找到 Edge，跳过浏览器测试。');
    process.exit(0);
  }
  console.log('== 浏览器端到端测试 ==\n');
  console.log('Edge: ' + edge + '\n');

  // 0. 准备测试素材（dev-export.html 需要）
  const fflib0 = require(path.join(ROOT, 'app', 'lib', 'ffmpeg.js'));
  const ffInfo = fflib0.locate();
  if (!ffInfo) { console.error('没有找到 ffmpeg'); process.exit(1); }
  // 每次从干净目录开始，避免上一次自检留下的文件干扰
  fs.rmSync(path.join(ROOT, '.selftest'), { recursive: true, force: true });
  const srcVideo = path.join(ROOT, '.selftest', 'source.mp4');
  if (!fs.existsSync(srcVideo)) {
    fs.mkdirSync(path.dirname(srcVideo), { recursive: true });
    spawnSync(ffInfo.path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=s=640x360:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-y', srcVideo], { windowsHide: true });
    console.log('[准备] 已生成测试视频 ' + srcVideo + '\n');
  }

  // 1. 启动本地服务
  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js')], {
    env: Object.assign({}, process.env, { VBAR_PORT: String(PORT), VBAR_NO_BROWSER: '1' }),
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (b) => { serverLog += b.toString(); });
  server.stderr.on('data', (b) => { serverLog += b.toString(); });

  const profile = path.join(ROOT, '.selftest', 'edge-cdp-profile');
  fs.mkdirSync(profile, { recursive: true });

  const browser = spawn(edge, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });

  let cdp = null;
  try {
    await waitFor(async () => {
      const r = await fetch(BASE + '/api/ping');
      return r.ok;
    }, 20000, '服务启动');
    console.log('[服务] 已启动');

    const target = await waitFor(async () => {
      const list = await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`).then((r) => r.json());
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }, 30000, '浏览器调试端口');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('无法连接浏览器调试端口')));
    });
    cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    console.log('[浏览器] 已连接\n');

    // ---------- A. 渲染器逐像素自检 ----------
    await cdp.send('Page.navigate', { url: BASE + '/dev-verify.html' });
    const verifyText = await waitFor(async () => {
      const t = await cdp.evaluate('document.getElementById("out") ? document.getElementById("out").textContent : ""');
      return t && t.includes('SUMMARY') ? t : null;
    }, 30000, '渲染自检完成');

    const vLines = verifyText.split('\n');
    const vFails = vLines.filter((l) => l.startsWith('FAIL'));
    const vSummary = vLines.find((l) => l.startsWith('SUMMARY'));
    console.log('[渲染自检] ' + vSummary);
    vFails.forEach((l) => console.log('   ' + l));
    if (vFails.length) failures += vFails.length;

    // ---------- B. 完整导出链路 ----------
    await cdp.send('Page.navigate', { url: BASE + '/dev-export.html' });
    const exportText = await waitFor(async () => {
      const t = await cdp.evaluate('document.getElementById("out") ? document.getElementById("out").textContent : ""');
      return t && (t.includes('SUMMARY done') || t.includes('FAIL')) ? t : null;
    }, 180000, '导出链路');
    console.log('\n[导出链路]');
    exportText.split('\n').forEach((l) => console.log('   ' + l));
    if (exportText.includes('FAIL') || !exportText.includes('SUMMARY done')) failures += 1;

    const outFile = (exportText.match(/encoding 完成：(.*)/) || exportText.match(/编码完成：(.*)/) || [])[1];
    if (outFile && fs.existsSync(outFile.trim())) {
      const f = outFile.trim();
      const fflib = require(path.join(ROOT, 'app', 'lib', 'ffmpeg.js'));
      const info = fflib.locate();
      const probe = spawnSync(info.path, ['-hide_banner', '-i', f], { encoding: 'utf8', windowsHide: true }).stderr;
      const isAlphaMov = /qtrle|prores \(4444\)/.test(probe);
      const isSize = /960x540/.test(probe);
      console.log('   文件: ' + f);
      console.log('   ' + (isAlphaMov ? 'PASS' : 'FAIL') + '  浏览器渲染产出为带透明通道的 mov');
      console.log('   ' + (isSize ? 'PASS' : 'FAIL') + '  分辨率 960x540 正确');
      if (!isAlphaMov) failures++;
      if (!isSize) failures++;

      // 抽查 alpha：第 1 帧 10% 处应仍是轨道（透明部分 alpha<255），90% 处应为填充色不透明
      const rawA = path.join(ROOT, '.selftest', 'browser-alpha.raw');
      spawnSync(info.path, ['-hide_banner', '-loglevel', 'error', '-i', f, '-frames:v', '1',
        '-vf', 'alphaextract,format=gray8', '-f', 'rawvideo', '-y', rawA], { windowsHide: true });
      const rawBytes = fs.readFileSync(rawA);
      const at = (x, y) => rawBytes[y * 960 + x];
      const aTop = at(480, 100);
      const aBar = at(480, 484);
      console.log('   ' + (aTop === 0 ? 'PASS' : 'FAIL') + '  画面上方完全透明 (alpha=' + aTop + ')');
      console.log('   ' + (aBar > 0 ? 'PASS' : 'FAIL') + '  进度条位置有像素 (alpha=' + aBar + ')');
      if (aTop !== 0) failures++;
      if (!(aBar > 0)) failures++;

      // 颜色：按 bt709 解回来，进度条必须是纯正的绿色（#00ff00）
      const rawColor = path.join(ROOT, '.selftest', 'browser-color.raw');
      spawnSync(info.path, ['-hide_banner', '-loglevel', 'error', '-ss', '1.9', '-i', f,
        '-frames:v', '1', '-vf', 'scale=in_color_matrix=bt709', '-pix_fmt', 'rgba',
        '-f', 'rawvideo', '-y', rawColor], { windowsHide: true });
      const cb = fs.readFileSync(rawColor);
      const co = (475 * 960 + 496) * 4;
      const rgb = [cb[co], cb[co + 1], cb[co + 2], cb[co + 3]];
      const colorOk = Math.abs(rgb[0] - 0) <= 2 && Math.abs(rgb[1] - 255) <= 2 && Math.abs(rgb[2] - 0) <= 2;
      console.log('   ' + (colorOk ? 'PASS' : 'FAIL') + '  颜色按 bt709 还原正确（应为纯绿 0,255,0，实际 ' +
        rgb[0] + ',' + rgb[1] + ',' + rgb[2] + '）');
      if (!colorOk) failures++;
    } else {
      console.log('   FAIL  没有找到导出文件');
      failures++;
    }

    // ---------- C. 主界面加载 ----------
    const jsErrorsBefore = cdp.errors().length;
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(3500);
    const ui = await cdp.evaluate(`JSON.stringify({
      formats: document.querySelectorAll('#format option').length,
      chapters: document.querySelectorAll('.chapter-row').length,
      canvas: document.getElementById('preview').width + 'x' + document.getElementById('preview').height,
      chipOk: /ok/.test(document.getElementById('ffmpegChip').className),
      estimate: document.getElementById('estimate').textContent.length > 0,
      segActive: document.querySelectorAll('.seg button.active').length,
      chapterInputs: document.querySelectorAll('#chapterList input').length,
      titleModeAll: !!document.querySelector('.seg[data-path="title.mode"] button.active[data-value="all"]'),
      titleAllRowsVisible: !document.getElementById('titleAllRows').hidden
    })`);
    const uiObj = JSON.parse(ui);
    console.log('\n[主界面]');
    const uiChecks = [
      ['导出格式下拉已填充', uiObj.formats >= 5],
      ['章节行已渲染', uiObj.chapters >= 1 && uiObj.chapterInputs >= 2],
      ['预览画布尺寸正确', uiObj.canvas === '1920x1080'],
      ['ffmpeg 状态显示为就绪', uiObj.chipOk === true],
      ['预计耗时已计算', uiObj.estimate === true],
      ['分段按钮状态已同步', uiObj.segActive >= 5],
      ['章节标题默认「全部并排显示」', uiObj.titleModeAll === true],
      ['全部并排的选项已展开', uiObj.titleAllRowsVisible === true],
    ];
    uiChecks.forEach(([name, cond]) => {
      console.log('   ' + (cond ? 'PASS' : 'FAIL') + '  ' + name);
      if (!cond) failures++;
    });

    const jsErrors = cdp.errors().slice(jsErrorsBefore);
    console.log('   ' + (jsErrors.length === 0 ? 'PASS' : 'FAIL') + '  页面无 JS 报错' +
      (jsErrors.length ? '：' + jsErrors.join(' | ').slice(0, 300) : ''));
    if (jsErrors.length) failures++;

    // ---------- C2. 内置素材浏览器 ----------
    const browse = JSON.parse(await cdp.evaluate(`(async () => {
      const testDir = ${JSON.stringify(path.join(ROOT, '.selftest'))};
      document.getElementById('videoPath').value = testDir + '\\\\source.mp4';
      document.getElementById('btnPickVideo').click();
      await new Promise((r) => setTimeout(r, 1500));
      const modal = document.getElementById('browseModal');
      const opened = !modal.hidden;
      const rows = document.querySelectorAll('#browseList .browse-row').length;
      const driveOptions = document.querySelectorAll('#browseDrive option').length;
      const pathValue = document.getElementById('browsePath').value;
      const fileRow = document.querySelector('#browseList .browse-row.file');
      let picked = '';
      let canConfirm = false;
      if (fileRow) {
        fileRow.click();
        await new Promise((r) => setTimeout(r, 300));
        picked = document.getElementById('browsePicked').textContent;
        canConfirm = !document.getElementById('browseOk').disabled;
      }
      const up = document.querySelector('#browseList .browse-row.up');
      let entered = null;
      if (up) {
        const before = document.getElementById('browsePath').value;
        up.click();
        await new Promise((r) => setTimeout(r, 1200));
        entered = document.getElementById('browsePath').value !== before;
      }
      modal.hidden = true;
      return JSON.stringify({ opened, rows, driveOptions, pathValue, entered, picked, canConfirm });
    })()`));
    console.log('\\n[素材浏览器]');
    const browseChecks = [
      ['点「选择视频」会弹出浏览器', browse.opened === true],
      ['列出了磁盘分区', browse.driveOptions >= 1],
      ['定位到素材所在文件夹', browse.pathValue.indexOf('.selftest') >= 0, browse.pathValue],
      ['列出了文件夹内容', browse.rows >= 1, String(browse.rows)],
      ['能选中视频文件', browse.canConfirm === true && browse.picked.indexOf('.mp4') >= 0, browse.picked],
      ['能跳到上一级目录', browse.entered === true],
    ];
    browseChecks.forEach(([name, cond, extra]) => {
      console.log('   ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  →  ' + (extra || '')));
      if (!cond) failures++;
    });

    // ---------- D. 1080p 单帧渲染耗时基准 ----------
    // 端到端速度由 ui-flow.js 负责测（它走真实界面，数字才有意义）
    // ---------- D. 1080p 单帧渲染耗时基准 ----------
    const bench = await cdp.evaluate(`(async () => {
      const cv = document.createElement('canvas');
      cv.width = 1920; cv.height = 1080;
      const ctx = cv.getContext('2d');
      const cfg = VBarScene.defaultConfig();
      cfg.canvas = { width: 1920, height: 1080, fps: 30, duration: 90 };
      cfg.chapters = [{start:0,title:'第一章 开场'},{start:30,title:'第二章'},{start:60,title:'第三章'}];
      cfg.title.mode = 'always'; cfg.time.mode = 'currentTotal';
      const toBlob = () => new Promise((r) => cv.toBlob(r, 'image/png'));
      const N = 30;
      // 预热
      for (let i = 0; i < 3; i++) { VBarScene.renderScene(ctx, cfg, i, {clear:true}); await toBlob(); }
      const t0 = performance.now();
      let bytes = 0;
      for (let i = 0; i < N; i++) {
        VBarScene.renderScene(ctx, cfg, (i / N) * 90, { clear: true });
        const b = await toBlob();
        bytes += b.size;
      }
      const ms = (performance.now() - t0) / N;
      return JSON.stringify({ msPerFrame: Math.round(ms * 10) / 10, avgKB: Math.round(bytes / N / 1024) });
    })()`);
    const b = JSON.parse(bench);
    console.log('\\n[性能基准 1920x1080]');
    console.log('   单帧渲染 + PNG 编码：' + b.msPerFrame + ' ms  平均帧体积 ' + b.avgKB + ' KB');
    console.log('   推算：1 分钟 30fps 视频约需 ' + Math.round(b.msPerFrame * 1800 / 1000) + ' 秒');

  } catch (e) {
    console.error('\n测试中断：' + (e && e.message));
    failures++;
  } finally {
    try { browser.kill(); } catch (_) {}
    try { server.kill(); } catch (_) {}
  }

  console.log('\n== ' + (failures ? `失败 ${failures} 项` : '全部通过') + ' ==');
  if (failures && serverLog) console.log('\n服务端日志：\n' + serverLog.slice(-1500));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
