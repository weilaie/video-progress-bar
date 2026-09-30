'use strict';

(function () {
  const S = window.VBarScene;
  const $ = (id) => document.getElementById(id);

  const state = {
    cfg: S.defaultConfig(),
    video: null,
    touched: new Set(),
    ui: {
      bgMode: 'video',
      canvasMode: 'follow',
      playing: false,
      time: 0,
      thumb: null,
      thumbTime: -99,
      thumbBusy: false,
    },
    env: null,
    exporting: false,
    cancelRequested: false,
    jobId: null,
    lastOutput: null,
  };

  const preview = $('preview');
  const ctx = preview.getContext('2d');
  let dirty = true;
  let lastTick = performance.now();

  /* ---------------------------------------------------------------- */
  /* 工具                                                              */
  /* ---------------------------------------------------------------- */

  function setPath(path, value) {
    const parts = path.split('.');
    let obj = state.cfg;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = value;
    state.touched.add(path);
    invalidate();
  }

  function setPathSilent(path, value) {
    const parts = path.split('.');
    let obj = state.cfg;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = value;
  }

  function getPath(path) {
    const parts = path.split('.');
    let obj = state.cfg;
    for (const p of parts) {
      if (obj == null) return undefined;
      obj = obj[p];
    }
    return obj;
  }

  function invalidate() {
    dirty = true;
    updateOutputs();
    updateConditional();
    updateEstimate();
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json());
  }

  function getJson(url) {
    return fetch(url).then((r) => r.json());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------------------------------------------------------------- */
  /* 控件绑定                                                          */
  /* ---------------------------------------------------------------- */

  function bindControls() {
    document.querySelectorAll('[data-path]').forEach((host) => {
      const path = host.dataset.path;
      if (host.tagName === 'SELECT') {
        host.addEventListener('change', () => setPath(path, host.value));
      } else if (host.classList.contains('seg')) {
        host.querySelectorAll('button').forEach((btn) => {
          btn.addEventListener('click', () => {
            setPath(path, btn.dataset.value);
            syncSegments();
          });
        });
      } else if (host.type === 'checkbox') {
        host.addEventListener('change', () => setPath(path, host.checked));
      } else if (host.type === 'range' || host.type === 'number') {
        host.addEventListener('input', () => setPath(path, Number(host.value)));
      } else if (host.type === 'color' || host.type === 'text') {
        host.addEventListener('input', () => setPath(path, host.value));
      }
    });

    $('radiusMode').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.value;
        if (mode === 'capsule') {
          state.cfg.bar.radiusMode = 'capsule';
        } else {
          state.cfg.bar.radiusMode = 'custom';
          state.cfg.bar.radius = mode === 'square'
            ? 0
            : (Number($('radiusMode').dataset.lastRadius) || 6);
        }
        state.touched.add('bar.radiusMode');
        syncSegments();
        invalidate();
      });
    });

    $('bgMode').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.ui.bgMode = btn.dataset.value;
        syncSegments();
        maybeFetchThumb(true);
        invalidate();
      });
    });

    $('canvasMode').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.ui.canvasMode = btn.dataset.value;
        if (state.ui.canvasMode === 'follow' && state.video && state.video.width) {
          state.cfg.canvas.width = state.video.width;
          state.cfg.canvas.height = state.video.height;
          setPathSilent('bar.marginX', Math.round(state.cfg.canvas.width * 0.05));
          setPathSilent('bar.offsetY', Math.round(state.cfg.canvas.height * 0.055));
          syncControls();
        }
        syncSegments();
        invalidate();
      });
    });
  }

  function syncSegments() {
    document.querySelectorAll('.seg[data-path]').forEach((host) => {
      const cur = String(getPath(host.dataset.path));
      host.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b.dataset.value === cur);
      });
    });
    $('bgMode').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === state.ui.bgMode);
    });
    $('canvasMode').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === state.ui.canvasMode);
    });

    const bar = state.cfg.bar;
    let mode = 'square';
    if (bar.radiusMode === 'capsule') mode = 'capsule';
    else if (Number(bar.radius) > 0) mode = 'rounded';
    $('radiusMode').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === mode);
    });
    if (mode === 'rounded') $('radiusMode').dataset.lastRadius = String(bar.radius);
  }

  function syncControls() {
    document.querySelectorAll('[data-path]').forEach((host) => {
      const value = getPath(host.dataset.path);
      if (host.tagName === 'SELECT') {
        host.value = String(value);
      } else if (host.type === 'checkbox') {
        host.checked = !!value;
      } else if (value !== undefined && value !== null) {
        host.value = String(value);
      }
    });
    $('canvasW').value = state.cfg.canvas.width;
    $('canvasH').value = state.cfg.canvas.height;
    $('fps').value = String(state.cfg.canvas.fps);
    syncSegments();
    updateOutputs();
    updateConditional();
  }

  function updateOutputs() {
    document.querySelectorAll('output[data-for]').forEach((out) => {
      const v = getPath(out.dataset.for);
      if (typeof v === 'number') {
        out.textContent = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
      } else if (v !== undefined) {
        out.textContent = String(v);
      }
    });
  }

  function updateConditional() {
    $('radiusRow').hidden = state.cfg.bar.radiusMode === 'capsule';
    $('titleIntroRows').hidden = state.cfg.title.mode !== 'intro';
    $('titleAllRows').hidden = state.cfg.title.mode !== 'all';
  }

  /* ---------------------------------------------------------------- */
  /* 预览                                                              */
  /* ---------------------------------------------------------------- */

  function resizePreview() {
    const w = Math.max(64, Math.round(state.cfg.canvas.width));
    const h = Math.max(64, Math.round(state.cfg.canvas.height));
    if (preview.width !== w || preview.height !== h) {
      preview.width = w;
      preview.height = h;
    }
  }

  function drawBackground() {
    const W = preview.width, H = preview.height;
    const mode = state.ui.bgMode;
    if ((mode === 'video' || mode === 'photo') && state.ui.thumb && state.ui.thumb.width) {
      ctx.drawImage(state.ui.thumb, 0, 0, W, H);
      return;
    }
    if (mode === 'video' || mode === 'photo') {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#1d2438');
      g.addColorStop(0.5, '#3a2b4d');
      g.addColorStop(1, '#12233a');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (mode === 'dark') {
      ctx.fillStyle = '#111318';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (mode === 'light') {
      ctx.fillStyle = '#e9edf5';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const size = Math.max(12, Math.round(H / 40));
    ctx.fillStyle = '#2a2f3a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#20242d';
    for (let y = 0; y < H; y += size) {
      for (let x = 0; x < W; x += size) {
        if ((x / size + y / size) % 2 === 0) ctx.fillRect(x, y, size, size);
      }
    }
  }

  function drawPreview() {
    resizePreview();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, preview.width, preview.height);
    drawBackground();
    S.renderScene(ctx, state.cfg, state.ui.time, { clear: false });
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    if (state.ui.playing) {
      const dur = Math.max(0.1, state.cfg.canvas.duration);
      state.ui.time += dt;
      if (state.ui.time >= dur) state.ui.time = 0;
      dirty = true;
      syncScrub();
      maybeFetchThumb();
    }
    if (dirty) {
      dirty = false;
      drawPreview();
      updateTimeReadout();
    }
    requestAnimationFrame(frame);
  }

  function updateTimeReadout() {
    const hours = state.cfg.canvas.duration >= 3600;
    $('curTime').textContent = S.formatClock(state.ui.time, hours);
    $('totalTime').textContent = S.formatClock(state.cfg.canvas.duration, hours);
  }

  function syncScrub() {
    const dur = Math.max(0.001, state.cfg.canvas.duration);
    $('scrub').value = String(Math.round((state.ui.time / dur) * 1000));
  }

  function maybeFetchThumb(force) {
    if (state.ui.bgMode !== 'video' || !state.video) return;
    if (state.ui.thumbBusy) return;
    const w = Math.min(1280, Math.max(480, Math.round(state.cfg.canvas.width)));
    const want = Math.round(state.ui.time * 2) / 2;
    if (!force && Math.abs(want - state.ui.thumbTime) < 0.5) return;
    state.ui.thumbBusy = true;
    state.ui.thumbTime = want;
    const url = `/api/thumb?file=${encodeURIComponent(state.video.path)}&t=${want}&w=${w}`;
    fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob) return null;
        return createImageBitmap(blob).then((bmp) => {
          if (state.ui.thumb && state.ui.thumb.close) state.ui.thumb.close();
          state.ui.thumb = bmp;
          dirty = true;
        });
      })
      .catch(() => {})
      .finally(() => { state.ui.thumbBusy = false; });
  }

  /* ---------------------------------------------------------------- */
  /* 章节                                                              */
  /* ---------------------------------------------------------------- */

  function renderChapters() {
    const list = $('chapterList');
    list.innerHTML = '';
    const duration = Math.max(0.001, state.cfg.canvas.duration);
    state.cfg.chapters.forEach((ch, i) => {
      const row = document.createElement('div');
      row.className = 'chapter-row';

      const idx = document.createElement('div');
      idx.className = 'idx';
      idx.textContent = String(i + 1);

      const time = document.createElement('input');
      time.className = 'time';
      time.type = 'text';
      time.value = S.formatTimecode(ch.start);
      time.title = '开始时间，可填 1:23 或 83';
      time.addEventListener('change', () => {
        const parsed = S.parseTimecode(time.value);
        if (parsed == null || parsed > duration) {
          row.classList.add('invalid');
          setTimeout(() => row.classList.remove('invalid'), 1200);
          time.value = S.formatTimecode(ch.start);
          return;
        }
        ch.start = i === 0 ? 0 : parsed;
        state.touched.add('chapters');
        sortAndRefresh();
      });

      const title = document.createElement('input');
      title.className = 'title';
      title.type = 'text';
      title.value = ch.title;
      title.placeholder = '段落标题';
      title.addEventListener('input', () => {
        ch.title = title.value;
        state.touched.add('chapters');
        dirty = true;
      });

      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = '删除这一段';
      del.addEventListener('click', () => {
        if (state.cfg.chapters.length <= 1) {
          state.cfg.chapters = [{ start: 0, title: '' }];
        } else {
          state.cfg.chapters.splice(i, 1);
          state.cfg.chapters.sort((a, b) => a.start - b.start);
          state.cfg.chapters[0].start = 0;
        }
        state.touched.add('chapters');
        renderChapters();
        invalidate();
      });

      row.append(idx, time, title, del);
      list.appendChild(row);
    });
  }

  function sortAndRefresh() {
    state.cfg.chapters.sort((a, b) => a.start - b.start);
    if (state.cfg.chapters.length) state.cfg.chapters[0].start = 0;
    renderChapters();
    invalidate();
  }

  function evenSplit(count) {
    const duration = Math.max(0.1, state.cfg.canvas.duration);
    const n = Math.max(1, Math.min(60, Math.round(count)));
    const list = [];
    for (let i = 0; i < n; i++) {
      const prev = state.cfg.chapters[i];
      list.push({
        start: (duration * i) / n,
        title: (prev && prev.title) || `第${i + 1}段`,
      });
    }
    state.cfg.chapters = list;
    state.touched.add('chapters');
    renderChapters();
    invalidate();
  }

  function everySplit(seconds) {
    const duration = Math.max(0.1, state.cfg.canvas.duration);
    const step = Math.max(1, Number(seconds) || 10);
    const list = [];
    let i = 0;
    for (let t = 0; t < duration - 0.05; t += step) {
      const prev = state.cfg.chapters[i];
      list.push({ start: t, title: (prev && prev.title) || `第${i + 1}段` });
      i++;
    }
    if (!list.length) list.push({ start: 0, title: '' });
    state.cfg.chapters = list;
    state.touched.add('chapters');
    renderChapters();
    invalidate();
  }

  /* ---------------------------------------------------------------- */
  /* 素材                                                              */
  /* ---------------------------------------------------------------- */

  function snapshotTitles() {
    return state.cfg.chapters.map((c) => c.title);
  }

  function applyVideo(video) {
    const oldTitles = snapshotTitles();
    state.video = video;
    state.cfg.canvas.duration = video.duration;

    if (state.ui.canvasMode === 'follow' && video.width && video.height) {
      state.cfg.canvas.width = video.width;
      state.cfg.canvas.height = video.height;
    }

    const W = state.cfg.canvas.width;
    const H = state.cfg.canvas.height;
    const scale = H / 1080;
    const auto = {
      'bar.thickness': Math.max(4, Math.round(10 * scale)),
      'bar.marginX': Math.round(W * 0.05),
      'bar.offsetY': Math.round(H * 0.055),
      'bar.radius': Math.max(1, Math.round(5 * scale)),
      'title.fontSize': Math.max(14, Math.round(44 * scale)),
      'title.offset': Math.round(22 * scale),
      'time.fontSize': Math.max(11, Math.round(24 * scale)),
      'time.offset': Math.round(16 * scale),
      'ticks.width': Math.max(1, Math.round(2 * scale)),
    };
    Object.keys(auto).forEach((key) => {
      if (!state.touched.has(key)) setPathSilent(key, auto[key]);
    });

    if (video.fps) state.cfg.canvas.fps = snapFps(video.fps);

    if (!state.touched.has('chapters')) {
      const n = Math.max(1, oldTitles.length || 3);
      evenSplit(n);
    }

    if (!$('outputDir').dataset.touched) {
      $('outputDir').value = video.path.replace(/[\\/][^\\/]*$/, '');
    }
    if (!$('outputName').dataset.touched) {
      const base = (video.path.split(/[\\/]/).pop() || '视频').replace(/\.[^.]+$/, '');
      $('outputName').value = base + '_进度条';
    }

    updateMeta();
    syncControls();
    renderChapters();
    state.ui.time = Math.min(state.ui.time, state.cfg.canvas.duration);
    state.ui.thumbTime = -99;
    maybeFetchThumb(true);
    invalidate();
    $('canvasBadge').textContent =
      `${video.width}×${video.height} · ${S.formatClock(video.duration)} · ${video.fps || '?'} fps`;
  }

  function snapFps(fps) {
    const common = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
    for (const c of common) {
      if (Math.abs(c - fps) < 0.06) return c;
    }
    return Math.round(fps * 100) / 100;
  }

  function updateMeta() {
    const v = state.video;
    if (!v) { $('videoMeta').textContent = '未选择视频'; return; }
    $('videoMeta').innerHTML =
      `时长 <b>${S.formatClock(v.duration)}</b>（${v.duration.toFixed(2)} 秒） · ` +
      `分辨率 <b>${v.width}×${v.height}</b> · 帧率 <b>${v.fps || '未知'}</b>` +
      (v.hasAudio ? ' · 含音轨' : '');
  }

  async function pickVideo() {
    openBrowser();
  }

  async function pickVideoNative() {
    const hint = $('pickHint');
    hint.textContent = '已经打开系统选择窗口，请看任务栏或屏幕右下角…';
    hint.hidden = false;
    const res = await postJson('/api/pick-video', {
      initial: state.video ? state.video.path : ($('videoPath').value.trim() || ''),
    });
    if (res.ok && !res.cancelled && res.path) {
      hint.hidden = true;
      $('videoPath').value = res.path;
      await loadVideo(res.path);
      return;
    }
    if (res.cancelled) {
      hint.hidden = true;
      return;
    }
    hint.textContent = (res.error || '系统窗口没能打开。') + ' 可以直接用上面的「选择视频」，或者把路径粘贴进来。';
  }

  /* ---------------- 内置素材浏览器 ---------------- */

  function joinPath(dir, name) {
    if (!dir) return name;
    const sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / 1024 / 1024;
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    if (mb >= 10) return Math.round(mb) + ' MB';
    return mb.toFixed(1) + ' MB';
  }

  function openBrowser() {
    $('browseModal').hidden = false;
    state.ui.pickedFile = null;
    $('browsePicked').textContent = '选中一个视频文件';
    $('browsePicked').classList.remove('on');
    $('browseOk').disabled = true;
    loadDrives().then(() => {
      let start = state.video ? state.video.path.replace(/[\\/][^\\/]*$/, '') : '';
      if (!start) start = $('videoPath').value.trim().replace(/[\\/][^\\/]*$/, '');
      if (!start) start = state.ui.lastDir || '';
      const first = start || (state.env && state.env.home) || '';
      loadDir(first).then((good) => {
        if (good) return;
        // 起始位置打不开就退回到第一个磁盘根目录
        const opt = $('browseDrive').options[0];
        if (opt) loadDir(opt.value);
      });
    });
  }

  async function loadDrives() {
    try {
      const r = await getJson('/api/drives');
      const sel = $('browseDrive');
      sel.innerHTML = '';
      (r.drives || []).forEach((d) => {
        const o = document.createElement('option');
        o.value = d;
        o.textContent = d;
        sel.appendChild(o);
      });
    } catch (_) { /* 忽略 */ }
  }

  async function loadDir(dir) {
    const list = $('browseList');
    list.innerHTML = '<div class="browse-empty">读取中…</div>';
    if (!dir) {
      list.innerHTML = '<div class="browse-empty">请选择一个磁盘或输入文件夹路径</div>';
      return false;
    }
    let r;
    try {
      r = await getJson('/api/ls?dir=' + encodeURIComponent(dir));
    } catch (e) {
      list.innerHTML = '<div class="browse-empty">读取失败：' + escapeHtml(String(e.message || e)) + '</div>';
      return false;
    }
    if (!r.ok) {
      list.innerHTML = '<div class="browse-empty">' + escapeHtml(r.error || '打不开这个文件夹') +
        '（可以换一个磁盘，或把路径直接粘贴到下面的输入框）</div>';
      return false;
    }
    state.ui.lastDir = r.dir;
    $('browsePath').value = r.dir;
    const drive = (r.dir.match(/^([A-Za-z]:)/) || [])[1];
    if (drive) $('browseDrive').value = drive + '\\';

    list.innerHTML = '';
    if (r.parent) {
      list.appendChild(browseRow('↑', '..', 'up', () => loadDir(r.parent)));
    }
    (r.dirs || []).forEach((d) => {
      list.appendChild(browseRow('📁', d.name, 'dir', () => loadDir(d.path)));
    });
    (r.files || []).forEach((f) => {
      const row = browseRow('🎬', f.name, 'file', null, null, f.size);
      row.addEventListener('click', () => {
        state.ui.pickedFile = f.path;
        list.querySelectorAll('.browse-row').forEach((n) => n.classList.remove('sel'));
        row.classList.add('sel');
        $('browsePicked').textContent = f.path;
        $('browsePicked').classList.add('on');
        $('browseOk').disabled = false;
      });
      row.addEventListener('dblclick', () => {
        state.ui.pickedFile = f.path;
        confirmBrowse();
      });
      list.appendChild(row);
    });
    if (!r.dirs.length && !r.files.length && !r.parent) {
      list.innerHTML = '<div class="browse-empty">这个文件夹里没有视频文件</div>';
    }
    return true;
  }

  function browseRow(icon, name, cls, onClick, onDbl, size) {
    const row = document.createElement('div');
    row.className = 'browse-row ' + cls;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = icon;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    row.append(ic, nm);
    if (size) {
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = formatSize(size);
      row.appendChild(sz);
    }
    if (onClick) row.addEventListener('click', onClick);
    if (onDbl) row.addEventListener('dblclick', onDbl);
    return row;
  }

  function confirmBrowse() {
    const file = state.ui.pickedFile;
    if (!file) return;
    $('browseModal').hidden = true;
    $('videoPath').value = file;
    loadVideo(file);
  }

  /** file:///F:/a/b.mp4 → F:\a\b.mp4 */
  function uriToPath(uri) {
    const first = String(uri || '').split(/\r?\n/)[0].trim();
    if (!/^file:/i.test(first)) return '';
    let p = first.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
    try { p = decodeURIComponent(p); } catch (_) {}
    if (/^[a-z]:/i.test(p)) p = p.replace(/\//g, '\\');
    else if (p.indexOf('\\') < 0) p = '\\\\' + p.replace(/\//g, '\\');
    return p;
  }

  async function loadVideo(file) {
    if (!file) return;
    $('videoMeta').textContent = '正在读取视频信息…';
    const info = await postJson('/api/probe', { file });
    if (!info.ok) {
      $('videoMeta').innerHTML =
        `<span style="color:var(--danger)">读取失败：${escapeHtml(info.error || '未知错误')}</span>`;
      return;
    }
    applyVideo({
      path: info.file,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio,
    });
  }

  /* ---------------------------------------------------------------- */
  /* 导出                                                              */
  /* ---------------------------------------------------------------- */

  function currentFormat() {
    return $('format').value || 'alpha_prores';
  }

  function frameCount() {
    return Math.max(1, Math.round(state.cfg.canvas.duration * state.cfg.canvas.fps));
  }

  function updateEstimate() {
    if (state.exporting) return;
    const n = frameCount();
    const sec = Math.max(1, Math.round(
      S.estimateRenderMs(n, state.cfg.canvas.width, state.cfg.canvas.height) / 1000));
    $('estimate').innerHTML =
      `将导出 <b>${n}</b> 帧，${state.cfg.canvas.width}×${state.cfg.canvas.height} @ ${state.cfg.canvas.fps}fps，` +
      `预计约 <b>${sec >= 60 ? (sec / 60).toFixed(1) + ' 分钟' : sec + ' 秒'}</b>。` +
      (state.cfg.canvas.duration > 300 ? '<br>视频较长，建议先用短片段试一次。' : '');

    // 画布和素材分辨率不一致的话，进度条会被拉伸，画面会发虚
    const v = state.video;
    const hint = $('resHint');
    if (v && v.width && (v.width !== state.cfg.canvas.width || v.height !== state.cfg.canvas.height)) {
      hint.hidden = false;
      hint.style.color = 'var(--warn)';
      hint.textContent = `注意：素材是 ${v.width}×${v.height}，当前画布是 ` +
        `${state.cfg.canvas.width}×${state.cfg.canvas.height}，进度条会被放大或缩小，` +
        `边缘可能发虚。点「跟随视频」可以自动改回素材尺寸。`;
    } else {
      hint.hidden = true;
    }
  }

  function canvasToBlob(canvas) {
    if (canvas.convertToBlob) {
      return canvas.convertToBlob({ type: 'image/png' });
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
    });
  }

  function setProgress(pct, text) {
    $('progressWrap').hidden = false;
    $('progressBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (text != null) $('exportStatus').textContent = text;
  }

  async function startExport() {
    if (state.exporting) return;
    if (!state.env || !state.env.ffmpeg) {
      alert('没有找到可用的 ffmpeg。请点右上角「指定 ffmpeg」选择 ffmpeg.exe。');
      return;
    }
    const total = frameCount();
    if (total > 20000 && !confirm(`这次要渲染 ${total} 帧，可能比较久。确定继续吗？`)) return;

    state.exporting = true;
    state.cancelRequested = false;
    $('btnExport').disabled = true;
    $('btnCancel').hidden = false;
    $('afterExport').hidden = true;
    document.querySelector('.export-block').classList.add('running');
    setProgress(0, '准备中…');

    const work = document.createElement('canvas');
    work.width = Math.max(2, Math.round(state.cfg.canvas.width));
    work.height = Math.max(2, Math.round(state.cfg.canvas.height));
    const wctx = work.getContext('2d');

    try {
      const started = await postJson('/api/start', {
        format: currentFormat(),
        outputDir: $('outputDir').value.trim(),
        outputName: $('outputName').value.trim() || '进度条',
        overwrite: $('overwrite').checked,
        previewBg: '#14141a',
        keyColor: '#00FF00',
        canvas: {
          width: work.width,
          height: work.height,
          fps: state.cfg.canvas.fps,
          duration: state.cfg.canvas.duration,
        },
      });
      if (!started.ok) throw new Error(started.error || '无法启动导出');
      state.jobId = started.jobId;

      const t0 = performance.now();
      let lastUi = 0;
      // 攒够一小批再发，减少来回开销；同时最多两批在途，让渲染和编码重叠起来
      const BATCH = 8;
      const MAX_INFLIGHT = 2;
      let batch = [];
      const inflight = [];
      let sent = 0;

      const flush = async (isLast) => {
        if (!batch.length) return;
        const parts = batch;
        const n = parts.length;
        batch = [];
        const p = fetch(`/api/frame?job=${state.jobId}&n=${n}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Blob(parts, { type: 'application/octet-stream' }),
        }).then(async (res) => {
          if (!res.ok) {
            const info = await res.json().catch(() => ({}));
            throw new Error(info.error || `发送 ${n} 帧失败`);
          }
          sent += n;
          const now = performance.now();
          if (now - lastUi > 150 || isLast) {
            lastUi = now;
            const elapsed = (now - t0) / 1000;
            const eta = sent > 0 ? (elapsed / sent) * (total - sent) : 0;
            setProgress(
              (sent / total) * 88,
              `渲染中 ${sent}/${total} 帧 · 已用 ${Math.round(elapsed)}s · 预计还需 ${Math.round(eta)}s`
            );
          }
        });
        inflight.push(p);
        if (inflight.length >= MAX_INFLIGHT) {
          await inflight.shift();
        }
      };

      for (let i = 0; i < total; i++) {
        if (state.cancelRequested) break;
        const t = total > 1
          ? (i / (total - 1)) * state.cfg.canvas.duration
          : state.cfg.canvas.duration;
        S.renderScene(wctx, state.cfg, t, { clear: true });
        const blob = await canvasToBlob(work);
        batch.push(blob);
        if (batch.length >= BATCH) await flush(i === total - 1);
      }
      await flush(true);
      await Promise.all(inflight);

      if (state.cancelRequested) {
        await postJson('/api/cancel', { jobId: state.jobId });
        setProgress(0, '');
        $('exportStatus').textContent = '已取消。';
        return;
      }

      setProgress(92, '编码中，正在封装文件…');
      const poller = setInterval(() => {
        getJson(`/api/status?job=${state.jobId}`).then((st) => {
          if (st.ok && st.status && st.status.phase === 'encoding') {
            setProgress(96, '编码收尾中…');
          }
        }).catch(() => {});
      }, 800);

      const fin = await postJson('/api/finish', { jobId: state.jobId });
      clearInterval(poller);
      if (!fin.ok) throw new Error((fin.status && fin.status.error) || fin.error || '编码失败');

      state.lastOutput = fin.status.outputPath;
      $('afterExport').hidden = false;
      $('afterExport').dataset.path = fin.status.outputPath;
      setProgress(100, '');
      $('exportStatus').innerHTML = `完成：<b>${escapeHtml(fin.status.outputPath)}</b>`;
    } catch (e) {
      $('exportStatus').innerHTML =
        `<span style="color:var(--danger)">导出失败：${escapeHtml(String(e.message || e))}</span>`;
      setProgress(0, '');
    } finally {
      state.exporting = false;
      $('btnExport').disabled = false;
      $('btnCancel').hidden = true;
      document.querySelector('.export-block').classList.remove('running');
      updateEstimate();
    }
  }

  /* ---------------------------------------------------------------- */
  /* 初始化                                                            */
  /* ---------------------------------------------------------------- */

  function updateFormatNote() {
    const env = state.env;
    const f = env && (env.formats || []).find((x) => x.key === currentFormat());
    $('formatNote').textContent = f ? f.note : '';
  }

  async function initEnv() {
    try {
      const env = await getJson('/api/env');
      state.env = env;
      const chip = $('ffmpegChip');
      if (env.ffmpeg && env.capabilities && env.capabilities.ok) {
        chip.className = 'chip ok';
        chip.textContent = 'ffmpeg ' + env.ffmpeg.version + ' 就绪';
        chip.title = env.ffmpeg.path;
      } else {
        chip.className = 'chip bad';
        chip.textContent = '未找到 ffmpeg，请手动指定';
        chip.title = (env.capabilities && env.capabilities.error) || '';
      }
      const sel = $('format');
      sel.innerHTML = '';
      (env.formats || []).forEach((f, i) => {
        const opt = document.createElement('option');
        opt.value = f.key;
        opt.textContent = f.label;
        if (i === 0) opt.selected = true;
        sel.appendChild(opt);
      });
      updateFormatNote();
    } catch (e) {
      $('ffmpegChip').className = 'chip bad';
      $('ffmpegChip').textContent = '后台未连接';
    }
  }

  function wire() {
    $('btnPickVideo').addEventListener('click', pickVideo);
    $('videoPath').addEventListener('change', () => loadVideo($('videoPath').value.trim()));

    // 内置素材浏览器
    $('browseGo').addEventListener('click', () => loadDir($('browsePath').value.trim()));
    $('browsePath').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadDir($('browsePath').value.trim());
    });
    $('browseDrive').addEventListener('change', () => loadDir($('browseDrive').value));
    $('browseOk').addEventListener('click', confirmBrowse);
    $('browseCancel').addEventListener('click', () => { $('browseModal').hidden = true; });
    $('browseNative').addEventListener('click', () => {
      $('browseModal').hidden = true;
      pickVideoNative();
    });
    $('browseModal').addEventListener('click', (e) => {
      if (e.target === $('browseModal')) $('browseModal').hidden = true;
    });

    // 拖拽视频文件进窗口
    const dropHint = document.createElement('div');
    dropHint.className = 'drop-hint';
    dropHint.textContent = '松手就加载这个视频';
    dropHint.hidden = true;
    document.body.appendChild(dropHint);

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropHint.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) dropHint.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dropHint.hidden = true;
      const dt = e.dataTransfer;
      let path = '';
      try {
        const uri = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
        path = uriToPath(uri);
      } catch (_) {}
      if (!path && dt.files && dt.files.length && dt.files[0].path) path = dt.files[0].path;
      if (path) {
        $('videoPath').value = path;
        loadVideo(path);
      } else {
        openBrowser();
      }
    });

    $('btnPickFfmpeg').addEventListener('click', async () => {
      const res = await postJson('/api/pick-ffmpeg', {});
      if (res.ok && res.path) {
        alert('已切换 ffmpeg：\n' + res.path);
        initEnv();
      } else if (!res.ok || !res.cancelled) {
        alert(res.error || '设置失败');
      }
    });

    $('btnPickDir').addEventListener('click', async () => {
      const res = await postJson('/api/pick-folder', { initial: $('outputDir').value.trim() });
      if (res.ok && res.path) $('outputDir').value = res.path;
    });

    $('outputName').addEventListener('input', () => { $('outputName').dataset.touched = '1'; });
    $('outputDir').addEventListener('input', () => { $('outputDir').dataset.touched = '1'; });
    $('format').addEventListener('change', () => { updateFormatNote(); updateEstimate(); });

    $('btnPlay').addEventListener('click', () => {
      state.ui.playing = !state.ui.playing;
      $('btnPlay').classList.toggle('playing', state.ui.playing);
      $('playLabel').textContent = state.ui.playing ? '暂停' : '播放';
      lastTick = performance.now();
      if (state.ui.playing) maybeFetchThumb(true);
    });

    $('scrub').addEventListener('input', () => {
      state.ui.time = (Number($('scrub').value) / 1000) * state.cfg.canvas.duration;
      invalidate();
      maybeFetchThumb();
    });

    $('btnSplitEven').addEventListener('click', () => evenSplit(Number($('splitCount').value) || 3));
    $('btnSplitEvery').addEventListener('click', () => everySplit(Number($('splitEvery').value) || 10));

    $('btnAddChapter').addEventListener('click', () => {
      const last = state.cfg.chapters[state.cfg.chapters.length - 1] || { start: 0 };
      const dur = state.cfg.canvas.duration;
      const next = Math.min(dur, (last.start + dur) / 2);
      state.cfg.chapters.push({ start: Math.max(0.001, next), title: '' });
      state.touched.add('chapters');
      sortAndRefresh();
    });

    $('btnClearChapters').addEventListener('click', () => {
      state.cfg.chapters = [{ start: 0, title: '' }];
      state.touched.add('chapters');
      renderChapters();
      invalidate();
    });

    $('canvasW').addEventListener('input', () => {
      state.cfg.canvas.width = Math.max(64, Number($('canvasW').value) || 1920);
      if (!state.touched.has('bar.marginX')) {
        setPathSilent('bar.marginX', Math.round(state.cfg.canvas.width * 0.05));
      }
      state.ui.canvasMode = 'custom';
      syncControls();
      invalidate();
    });
    $('canvasH').addEventListener('input', () => {
      state.cfg.canvas.height = Math.max(64, Number($('canvasH').value) || 1080);
      state.ui.canvasMode = 'custom';
      syncControls();
      invalidate();
    });
    $('fps').addEventListener('change', () => {
      state.cfg.canvas.fps = Number($('fps').value) || 30;
      invalidate();
    });

    $('btnExport').addEventListener('click', startExport);
    $('btnCancel').addEventListener('click', () => {
      state.cancelRequested = true;
      $('exportStatus').textContent = '正在取消…';
    });
    $('btnReveal').addEventListener('click', () => {
      const p = $('afterExport').dataset.path;
      if (p) postJson('/api/reveal', { path: p });
    });

    $('btnHelp').addEventListener('click', () => { $('helpModal').hidden = false; });
    $('btnCloseHelp').addEventListener('click', () => { $('helpModal').hidden = true; });
    $('helpModal').addEventListener('click', (e) => {
      if (e.target === $('helpModal')) $('helpModal').hidden = true;
    });

    $('btnQuit').addEventListener('click', async () => {
      await postJson('/api/quit', {});
      window.close();
    });

    setInterval(() => { fetch('/api/ping').catch(() => {}); }, 15000);

    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toUpperCase();
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        $('btnPlay').click();
      }
    });

    window.addEventListener('resize', () => { dirty = true; });
  }

  bindControls();
  wire();
  renderChapters();
  syncControls();
  updateEstimate();
  initEnv();
  requestAnimationFrame(frame);
  setTimeout(() => maybeFetchThumb(true), 300);
})();
