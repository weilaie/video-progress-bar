'use strict';

/**
 * 视频进度条工具 —— 本地服务
 * 纯 Node 内置模块实现：托管界面、探测视频、接收逐帧画面、调用 ffmpeg 编码。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const fflib = require('./lib/ffmpeg');
const jobs = require('./lib/jobs');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TOOLS_DIR = path.join(fflib.ROOT, 'tools');
const PICK_PS1 = path.join(TOOLS_DIR, 'pick.ps1');
const PICK_LOG = path.join(fflib.CONFIG_DIR, 'pick.log');

const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.webm', '.wmv', '.flv', '.ts', '.mpg', '.mpeg'];

function logLine(text) {
  try {
    fs.mkdirSync(fflib.CONFIG_DIR, { recursive: true });
    fs.appendFileSync(PICK_LOG,
      `${new Date().toISOString()}  ${text}\r\n`, 'utf8');
  } catch (_) { /* 忽略 */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const VIDEO_FILTER = '视频文件|*.mp4;*.mov;*.mkv;*.m4v;*.avi;*.webm;*.wmv|所有文件|*.*';

let lastHeartbeat = Date.now();
let serverStartedAt = Date.now();

function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 2 * 1024 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req) {
  return readBody(req).then((buf) => {
    if (!buf.length) return {};
    return JSON.parse(buf.toString('utf8'));
  });
}

function pickWithDialog({ mode, filter, title, initial }) {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', PICK_PS1,
      '-Mode', mode || 'file',
      '-Filter', filter || VIDEO_FILTER,
      '-Title', title || '请选择',
      '-Log', PICK_LOG,
    ];
    if (initial) args.push('-Initial', initial);

    logLine(`pick request mode=${mode || 'file'} title=${title || ''} initial=${initial || ''}`);

    const child = spawn('powershell.exe', args, { windowsHide: true });
    const out = [];
    const err = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logLine('pick result: ' + JSON.stringify(value));
      resolve(value);
    };
    // 安全阀：万一对话框没能弹出来，也不要把界面永久卡住
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish({ ok: false, error: '选择窗口没有响应。可以先把路径直接粘贴到输入框里。' });
    }, 8 * 60 * 1000);

    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', () => finish({ ok: false, error: '无法打开系统对话框。' }));
    child.on('close', () => {
      const text = Buffer.concat(out).toString('utf8').trim();
      const errText = Buffer.concat(err).toString('utf8').trim();
      if (errText) logLine('pick stderr: ' + errText);
      if (!text) {
        finish({ ok: true, cancelled: true });
      } else {
        const list = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        finish({ ok: true, cancelled: false, paths: list, path: list[0] });
      }
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    return json(res, 403, { error: '禁止访问' });
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\//, '');

  if (req.method === 'GET' && route === 'ping') {
    lastHeartbeat = Date.now();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && route === 'env') {
    const info = fflib.locate();
    const caps = info ? fflib.capabilities(info.path) : { ok: false, error: '没有找到 ffmpeg' };
    return json(res, 200, {
      ok: true,
      ffmpeg: info ? { path: info.path, version: info.version } : null,
      capabilities: caps,
      platforms: process.platform,
      home: os.homedir(),
      root: path.join(__dirname, '..'),
      formats: Object.keys(jobs.FORMATS).map((k) => Object.assign({ key: k }, jobs.FORMATS[k])),
    });
  }

  if (req.method === 'POST' && route === 'pick-ffmpeg') {
    const picked = await pickWithDialog({
      mode: 'file',
      filter: 'ffmpeg|ffmpeg.exe|所有文件|*.*',
      title: '请选择 ffmpeg.exe',
    });
    if (!picked.ok || picked.cancelled) return json(res, 200, picked);
    const info = fflib.verify(picked.path);
    if (!info) return json(res, 200, { ok: false, error: '这个文件不是可用的 ffmpeg。' });
    fflib.writeSettings({ ffmpegPath: picked.path });
    fflib.locate(true);
    return json(res, 200, { ok: true, path: picked.path, capabilities: fflib.capabilities(picked.path) });
  }

  if (req.method === 'POST' && route === 'pick-video') {
    const body = await readJson(req);
    const picked = await pickWithDialog({
      mode: 'files',
      filter: VIDEO_FILTER,
      title: '选择视频素材',
      initial: body.initial || '',
    });
    return json(res, 200, picked);
  }

  if (req.method === 'POST' && route === 'pick-folder') {
    const body = await readJson(req);
    const picked = await pickWithDialog({
      mode: 'folder',
      title: '选择保存位置',
      initial: body.initial || '',
    });
    if (picked.ok && !picked.cancelled) {
      fflib.writeSettings({ lastOutputDir: picked.path });
    }
    return json(res, 200, picked);
  }

  if (req.method === 'POST' && route === 'probe') {
    const body = await readJson(req);
    const info = fflib.locate();
    if (!info) return json(res, 200, { ok: false, error: '没有找到 ffmpeg。' });
    const media = fflib.probeMedia(info.path, body.file);
    return json(res, 200, media);
  }

  if (req.method === 'GET' && route === 'drives') {
    const drives = [];
    for (let i = 67; i <= 90; i++) {          // C: ~ Z:
      const letter = String.fromCharCode(i) + ':\\';
      try {
        if (fs.existsSync(letter)) drives.push(letter);
      } catch (_) { /* 忽略无权限的盘 */ }
    }
    return json(res, 200, { ok: true, drives, home: os.homedir() });
  }

  if (req.method === 'GET' && route === 'ls') {
    let dir = url.searchParams.get('dir') || os.homedir();
    let stat = null;
    try { stat = fs.statSync(dir); } catch (_) { stat = null; }
    if (!stat || !stat.isDirectory()) {
      return json(res, 200, { ok: false, error: '文件夹不存在或不可访问。', dir });
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: '没有权限读取这个文件夹。', dir });
    }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('$') || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          dirs.push({ name: e.name, path: full });
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (VIDEO_EXT.indexOf(ext) >= 0) {
            let size = 0;
            try { size = fs.statSync(full).size; } catch (_) {}
            files.push({ name: e.name, path: full, size, ext: ext.slice(1) });
          }
        }
      } catch (_) { /* 忽略单个条目 */ }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const parent = path.dirname(dir);
    return json(res, 200, {
      ok: true,
      dir,
      parent: parent === dir ? null : parent,
      dirs,
      files,
    });
  }

  if (req.method === 'POST' && route === 'start') {
    const body = await readJson(req);
    const info = fflib.locate();
    if (!info) return json(res, 400, { ok: false, error: '没有可用的 ffmpeg。' });
    const cfg = Object.assign({}, body, { ffmpegPath: info.path });
    try {
      const job = jobs.startJob(cfg);
      return json(res, 200, {
        ok: true,
        jobId: job.id,
        frameCount: job.frameCount,
        outputPath: job.outputPath,
      });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && route === 'frame') {
    const jobId = url.searchParams.get('job');
    const job = jobs.getJob(jobId);
    if (!job) return json(res, 404, { ok: false, error: '任务不存在' });
    if (job.cancelled) return json(res, 200, { ok: false, cancelled: true });
    if (!job.stdin || !job.stdin.writable) {
      return json(res, 200, { ok: false, error: '编码器已关闭' });
    }
    const n = Math.max(1, Math.min(64, Number(url.searchParams.get('n') || 1)));
    // 带 seq 的按序号排队；没带的（简单客户端）按到达顺序自动编号
    const seqParam = url.searchParams.get('seq');
    const seq = seqParam === null ? job.freeSeq++ : Number(seqParam);

    // 关键：同一个任务必须按序号一笔一笔写进 ffmpeg 的 stdin。
    // 两个请求同时 pipe 到同一个管道，字节流会交叉，PNG 会被截断，
    // ffmpeg 就会大面积丢帧（这正是「导出时长变短」的原因）。
    return new Promise((resolve) => {
      let finished = false;
      const complete = () => {
        if (finished) return;
        finished = true;
        job.frames += n;
        job.nextSeq = seq + 1;
        json(res, 200, { ok: true, frames: job.frames });
        const next = job.pendingFrames.get(job.nextSeq);
        if (next) {
          job.pendingFrames.delete(job.nextSeq);
          next.release();
        }
        resolve();
      };

      const writeThrough = () => {
        if (!job.stdin || !job.stdin.writable) {
          finished = true;
          json(res, 200, { ok: false, error: '编码器已关闭' });
          resolve();
          return;
        }
        req.on('error', complete);
        req.on('aborted', complete);
        req.on('end', complete);
        req.pipe(job.stdin, { end: false });
      };

      if (seq === job.nextSeq) {
        writeThrough();
      } else if (seq > job.nextSeq) {
        // 还没轮到自己：先暂停这个请求，等前面的批次写完再放行
        req.pause();
        job.pendingFrames.set(seq, {
          res,
          release: () => {
            req.resume();
            writeThrough();
          },
        });
      } else {
        // 重复请求，直接忽略
        finished = true;
        json(res, 200, { ok: true, duplicate: true, frames: job.frames });
        resolve();
      }
    });
  }

  if (req.method === 'GET' && route === 'status') {
    const job = jobs.getJob(url.searchParams.get('job'));
    if (!job) return json(res, 404, { ok: false, error: '任务不存在' });
    return json(res, 200, {
      ok: true,
      status: jobs.statusOf(job),
      stderr: String(job.stderrTail || '').slice(-1500),
    });
  }

  if (req.method === 'POST' && route === 'finish') {
    const body = await readJson(req);
    try {
      const status = await jobs.finishJob(body.jobId);
      return json(res, 200, { ok: !status.error, status });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && route === 'cancel') {
    const body = await readJson(req);
    const job = jobs.getJob(body.jobId);
    if (job && job.pendingFrames) {
      for (const [, p] of job.pendingFrames) {
        try { json(p.res, 200, { ok: false, cancelled: true }); } catch (_) {}
      }
      job.pendingFrames.clear();
    }
    await jobs.cancelJob(body.jobId);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && route === 'thumb') {
    const info = fflib.locate();
    const file = url.searchParams.get('file');
    const t = Number(url.searchParams.get('t') || 0);
    const w = Number(url.searchParams.get('w') || 960);
    if (!info || !file || !fs.existsSync(file)) {
      res.writeHead(404); res.end(); return;
    }
    const buf = fflib.extractPreviewFrame(info.path, file, t, w);
    if (!buf) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    res.end(buf);
    return;
  }

  if (req.method === 'POST' && route === 'reveal') {
    const body = await readJson(req);
    const target = body.path;
    if (target && fs.existsSync(target)) {
      try {
        if (fs.statSync(target).isDirectory()) {
          spawn('explorer.exe', [target], { detached: true, windowsHide: false }).unref();
        } else {
          spawn('explorer.exe', ['/select,' + target], { detached: true, windowsHide: false }).unref();
        }
      } catch (_) { /* 忽略 */ }
    }
    return json(res, 200, { ok: true });
  }

  // 把导出的透明视频再合成一份「能直接双击播放」的 MP4。
  // 透明通道的 mov 在 Windows 自带播放器里一律打不开，这是用户最容易误判「文件损坏」的地方。
  if (req.method === 'POST' && route === 'make-preview') {
    const body = await readJson(req);
    const info = fflib.locate();
    const src = body.file;
    if (!info) return json(res, 200, { ok: false, error: '没有可用的 ffmpeg。' });
    if (!src || !fs.existsSync(src)) return json(res, 200, { ok: false, error: '找不到源文件。' });

    const meta = fflib.probeMedia(info.path, src);
    if (!meta.ok) return json(res, 200, { ok: false, error: '读不出这个文件的视频信息。' });

    const out = src.replace(/\.[^.\\/]+$/, '') + '_预览版.mp4';
    const bg = '0x14141a';
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${bg}:s=${meta.width}x${meta.height}:r=${meta.fps || 30}`,
      '-i', src,
      '-filter_complex', '[0:v][1:v]overlay=format=auto,format=yuv420p',
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart',
      // 注意：色块源是无限长的，用 -shortest 收不住（滤镜图不会结束），必须显式限时
      '-t', String(Math.max(0.1, meta.duration + 0.05)),
      '-y', out,
    ];
    const result = await new Promise((resolve) => {
      const child = spawn(info.path, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (b) => { err += b.toString(); });
      child.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
      child.on('close', (code) => resolve(code === 0
        ? { ok: true, path: out }
        : { ok: false, error: err.slice(-400) || `退出码 ${code}` }));
    });
    return json(res, 200, result);
  }

  if (req.method === 'GET' && route === 'open-in-editor-hint') {
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === 'quit') {
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 300);
    return;
  }

  return json(res, 404, { ok: false, error: '接口不存在：' + route });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      try { json(res, 500, { ok: false, error: String(e.message || e) }); } catch (_) {}
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    onReady(port);
  });
}

function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function onReady(port) {
  const url = `http://127.0.0.1:${port}/`;
  console.log('进度条工具已就绪：' + url);

  if (process.env.VBAR_NO_BROWSER === '1') return;

  const edge = findEdge();
  const profile = path.join(os.tmpdir(), 'vbar-edge-profile');
  if (edge) {
    spawn(edge, [
      `--app=${url}`,
      '--window-size=1560,980',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeSidebarV2',
    ], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, windowsHide: true }).unref();
  }
}

// 浏览器窗口关掉后自动退出
setInterval(() => {
  if (Date.now() - serverStartedAt < 120000) return;
  if (jobs.hasActiveJob()) return;          // 正在导出时绝不退出
  if (Date.now() - lastHeartbeat > 90000) {
    console.log('界面已关闭，工具退出。');
    process.exit(0);
  }
}, 5000);

setInterval(() => jobs.cleanupOldJobs(), 10 * 60 * 1000);

serverStartedAt = Date.now();
lastHeartbeat = Date.now();
listen(Number(process.env.VBAR_PORT || 8790), 20);
