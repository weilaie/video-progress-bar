'use strict';

/**
 * 进度条渲染引擎。
 * 预览和导出共用这里的逻辑，所以「看到什么，导出就是什么」。
 */

const FONT_STACK = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Segoe UI", system-ui, sans-serif';

function defaultConfig() {
  return {
    canvas: { width: 1920, height: 1080, fps: 30, duration: 60 },
    bar: {
      position: 'bottom',
      thickness: 10,
      radiusMode: 'capsule',
      radius: 5,
      marginX: 96,
      offsetY: 60,
      trackColor: '#ffffff',
      trackAlpha: 0.3,
      fillColor: '#ffffff',
      fillColor2: '#c9e2ff',
      gradient: false,
      capStyle: 'flat',
      glow: true,
    },
    dot: {
      show: true,
      size: 2.2,
      color: '#ffffff',
      ring: false,
      innerColor: '#7fb4ff',
      glow: true,
    },
    ticks: {
      style: 'line',
      color: '#ffffff',
      alpha: 0.6,
      width: 2,
    },
    time: {
      mode: 'currentTotal',
      position: 'belowRight',
      fontSize: 24,
      color: '#ffffff',
      alpha: 0.9,
      weight: 600,
      offset: 16,
      letterSpacing: 0.5,
      shadow: true,
    },
    title: {
      mode: 'all',
      position: 'aboveLeft',
      fontSize: 44,
      color: '#ffffff',
      alpha: 0.98,
      weight: 700,
      offset: 22,
      hold: 3,
      fadeIn: 0.35,
      fadeOut: 0.4,
      shadow: true,
      letterSpacing: 1,
      highlight: true,
      dimAlpha: 0.45,
      gap: 14,
    },
    backdrop: {
      enabled: false,
      color: '#000000',
      alpha: 0.3,
      padding: 20,
      radius: 18,
    },
    chapters: [{ start: 0, title: '第一章' }],
    fontFamily: FONT_STACK,
  };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function hexToRgba(hex, alpha) {
  let h = String(hex || '#ffffff').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) h = 'ffffff';
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha == null ? 1 : alpha})`;
}

function hexToRgb(hex) {
  let h = String(hex || '#ffffff').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) h = 'ffffff';
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
  const f = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}

/** 把颜色按比例朝目标色混合 */
function mix(hexA, hexB, ratio) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex(a.r + (b.r - a.r) * ratio, a.g + (b.g - a.g) * ratio, a.b + (b.b - a.b) * ratio);
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 秒 → 0:00 / 0:00:00 */
function formatClock(seconds, forceHours) {
  const sec = Math.max(0, Number(seconds) || 0);
  const total = Math.floor(sec + 1e-6);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0 || forceHours) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** 秒 → 00:00.000 */
function formatTimecode(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const whole = Math.floor(s);
  const ms = Math.round((s - whole) * 1000);
  return `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function parseTimecode(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const parts = t.split(':').map((s) => s.trim());
  let sec = 0;
  if (parts.length === 1) sec = Number(parts[0]);
  else if (parts.length === 2) sec = Number(parts[0]) * 60 + Number(parts[1]);
  else if (parts.length === 3) sec = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  else return null;
  if (!isFinite(sec)) return null;
  return Math.max(0, sec);
}

/** 归一化章节：排序、去重叠、补首段 */
function normalizeChapters(cfg) {
  const duration = Math.max(0.001, Number(cfg.canvas.duration) || 1);
  let list = Array.isArray(cfg.chapters) ? cfg.chapters.slice() : [];
  list = list
    .map((c) => ({
      start: clamp(Number(c.start) || 0, 0, duration),
      title: String(c.title == null ? '' : c.title),
    }))
    .sort((a, b) => a.start - b.start);

  const out = [];
  for (const c of list) {
    if (out.length && c.start <= out[out.length - 1].start + 1e-3) continue;
    out.push(c);
  }
  if (!out.length || out[0].start > 1e-3) {
    out.unshift({ start: 0, title: out.length ? '' : '第一章' });
  }
  return out;
}

function segmentsOf(cfg) {
  const duration = Math.max(0.001, Number(cfg.canvas.duration) || 1);
  const chapters = normalizeChapters(cfg);
  return chapters.map((c, i) => ({
    index: i,
    title: c.title,
    start: c.start,
    end: i + 1 < chapters.length ? chapters[i + 1].start : duration,
  }));
}

/** 几何布局（纯数值） */
function computeGeometry(cfg) {
  const W = Math.max(2, Math.round(cfg.canvas.width));
  const H = Math.max(2, Math.round(cfg.canvas.height));
  const h = Math.max(2, Number(cfg.bar.thickness) || 8);
  const marginX = clamp(Number(cfg.bar.marginX) || 0, 0, Math.max(0, Math.floor(W / 2 - 2)));
  const trackW = Math.max(4, W - marginX * 2);
  const offsetY = clamp(Number(cfg.bar.offsetY) || 0, 0, Math.max(0, H - h));
  const y = cfg.bar.position === 'top' ? offsetY : H - offsetY - h;
  const radius = cfg.bar.radiusMode === 'capsule'
    ? h / 2
    : clamp(Number(cfg.bar.radius) || 0, 0, h / 2);

  const track = { x: marginX, y, w: trackW, h, r: radius };
  const duration = Math.max(0.001, Number(cfg.canvas.duration) || 1);
  const segs = segmentsOf(cfg).map((s) => ({
    index: s.index,
    title: s.title,
    start: s.start,
    end: s.end,
    x: track.x + (s.start / duration) * trackW,
    w: ((s.end - s.start) / duration) * trackW,
  }));

  return { W, H, track, segs, duration };
}

function roundRect(target, x, y, w, h, r) {
  const rr = clamp(r, 0, Math.min(w, h) / 2);
  if (typeof target.roundRect === 'function') {
    target.roundRect(x, y, w, h, rr);
    return;
  }
  target.moveTo(x + rr, y);
  target.lineTo(x + w - rr, y);
  target.quadraticCurveTo(x + w, y, x + w, y + rr);
  target.lineTo(x + w, y + h - rr);
  target.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  target.lineTo(x + rr, y + h);
  target.quadraticCurveTo(x, y + h, x, y + h - rr);
  target.lineTo(x, y + rr);
  target.quadraticCurveTo(x, y, x + rr, y);
}

/** 轨道路径：分段留白时是多段胶囊，否则是整条 */
function buildTrackPath(geo, cfg) {
  const p = new Path2D();
  const gap = cfg.ticks.style === 'gap'
    ? Math.max(2, (Number(cfg.ticks.width) || 2) * 3)
    : 0;
  for (const s of geo.segs) {
    let x = s.x, w = s.w;
    if (gap > 0 && geo.segs.length > 1) {
      const isFirst = s.index === 0;
      const isLast = s.index === geo.segs.length - 1;
      if (!isFirst) { x += gap / 2; w -= gap / 2; }
      if (!isLast) { w -= gap / 2; }
      const minW = Math.min(Math.max(2, w), geo.track.h * 0.8);
      if (w < minW) { const c = x + w / 2; x = c - minW / 2; w = minW; }
    }
    roundRect(p, x, geo.track.y, Math.max(0.5, w), geo.track.h, geo.track.r);
  }
  return p;
}

function fontString(size, weight, family) {
  return `${weight || 400} ${Math.max(1, Math.round(size))}px ${family || FONT_STACK}`;
}

function measureText(ctx, text, size, weight, family, letterSpacing) {
  ctx.save();
  ctx.font = fontString(size, weight, family);
  const base = ctx.measureText(text).width;
  ctx.restore();
  return base + (letterSpacing || 0) * Math.max(0, text.length - 1);
}

function fillTextSpaced(ctx, text, x, y, letterSpacing, align) {
  const ls = letterSpacing || 0;
  if (!ls) {
    ctx.textAlign = align || 'left';
    ctx.fillText(text, x, y);
    return;
  }
  ctx.textAlign = 'left';
  const chars = Array.from(text);
  const widths = chars.map((ch) => ctx.measureText(ch).width + ls);
  const total = widths.reduce((a, b) => a + b, 0) - ls;
  let cx = x;
  if (align === 'right') cx = x - total;
  else if (align === 'center') cx = x - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], cx, y);
    cx += widths[i];
  }
}

function ellipsize(ctx, text, maxWidth, size, weight, family, letterSpacing) {
  if (!text) return '';
  if (measureText(ctx, text, size, weight, family, letterSpacing) <= maxWidth) return text;
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join('') + '…';
    if (measureText(ctx, candidate, size, weight, family, letterSpacing) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, Math.max(1, lo)).join('') + '…';
}

function chapterAt(segs, t) {
  let cur = segs[0];
  for (const s of segs) {
    if (t >= s.start - 1e-6) cur = s;
  }
  return cur;
}

function titleAlphaAt(cfg, seg, t) {
  const mode = cfg.title.mode;
  if (mode === 'none') return 0;
  if (mode === 'always') return 1;
  const local = t - seg.start;
  const hold = Math.max(0, Number(cfg.title.hold) || 0);
  const fin = Math.max(0.001, Number(cfg.title.fadeIn) || 0.001);
  const fout = Math.max(0.001, Number(cfg.title.fadeOut) || 0.001);
  if (local < 0) return 0;
  if (local < fin) return local / fin;
  if (local <= fin + hold) return 1;
  const after = local - fin - hold;
  if (after < fout) return 1 - after / fout;
  return 0;
}

function timeTextFor(cfg, t) {
  const mode = cfg.time.mode;
  if (mode === 'none') return '';
  const duration = Math.max(0, Number(cfg.canvas.duration) || 0);
  const forceHours = duration >= 3600;
  const cur = formatClock(t, forceHours);
  const total = formatClock(duration, forceHours);
  if (mode === 'current') return cur;
  if (mode === 'currentTotal') return `${cur} / ${total}`;
  if (mode === 'remaining') return '-' + formatClock(Math.max(0, duration - t), forceHours);
  return cur;
}

function textAnchor(position, track, fontSize, offset) {
  const belowTop = track.y + track.h + offset;
  const aboveBottom = track.y - offset;
  switch (position) {
    case 'belowLeft':
      return { x: track.x, y: belowTop, baseline: 'top', align: 'left', top: belowTop };
    case 'belowCenter':
      return { x: track.x + track.w / 2, y: belowTop, baseline: 'top', align: 'center', top: belowTop };
    case 'belowRight':
      return { x: track.x + track.w, y: belowTop, baseline: 'top', align: 'right', top: belowTop };
    case 'aboveLeft':
      return { x: track.x, y: aboveBottom, baseline: 'bottom', align: 'left', top: aboveBottom - fontSize * 1.3 };
    case 'aboveCenter':
      return { x: track.x + track.w / 2, y: aboveBottom, baseline: 'bottom', align: 'center', top: aboveBottom - fontSize * 1.3 };
    case 'aboveRight':
      return { x: track.x + track.w, y: aboveBottom, baseline: 'bottom', align: 'right', top: aboveBottom - fontSize * 1.3 };
    case 'insideLeft':
      return { x: track.x + offset, y: track.y + track.h / 2, baseline: 'middle', align: 'left', top: track.y + track.h / 2 - fontSize * 0.65 };
    case 'insideRight':
      return { x: track.x + track.w - offset, y: track.y + track.h / 2, baseline: 'middle', align: 'right', top: track.y + track.h / 2 - fontSize * 0.65 };
    default:
      return { x: track.x + track.w, y: belowTop, baseline: 'top', align: 'right', top: belowTop };
  }
}

/** 把「条内」位置转成「条上方」，用于全程并排显示的章节标题 */
function forceOuter(position) {
  const p = String(position || '');
  if (p.indexOf('inside') === 0) return 'above' + p.slice(6);
  return p || 'aboveLeft';
}

/**
 * 渲染一帧。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} cfg
 * @param {number} t 当前时间（秒）
 * @param {{clear?:boolean}} [opts]
 */
function renderScene(ctx, cfg, t, opts) {
  const options = opts || {};
  const geo = computeGeometry(cfg);
  const duration = geo.duration;
  const p = clamp(duration > 0 ? t / duration : 0, 0, 1);

  if (options.clear !== false) ctx.clearRect(0, 0, geo.W, geo.H);

  const family = cfg.fontFamily || FONT_STACK;
  const trackPath = buildTrackPath(geo, cfg);
  const seg = chapterAt(geo.segs, t);

  const timeText = timeTextFor(cfg, t);
  const showTime = !!timeText;
  const timeFs = Math.max(1, Number(cfg.time.fontSize) || 20);
  const timeOff = Number(cfg.time.offset) || 12;
  const timeW = showTime
    ? measureText(ctx, timeText, timeFs, cfg.time.weight, family, cfg.time.letterSpacing)
    : 0;

  const titleFs = Math.max(1, Number(cfg.title.fontSize) || 36);
  const titleOff = Number(cfg.title.offset) || 20;
  const timePos = textAnchor(cfg.time.position, geo.track, timeFs, timeOff);
  const titlePos = textAnchor(cfg.title.mode === 'all' ? forceOuter(cfg.title.position) : cfg.title.position,
    geo.track, titleFs, titleOff);

  // ---- 章节标题：算出这一帧要画哪几条 ----
  const titleItems = [];
  if (cfg.title.mode === 'all') {
    const dim = clamp(cfg.title.dimAlpha == null ? 0.45 : Number(cfg.title.dimAlpha), 0, 1);
    const gap = Math.max(0, Number(cfg.title.gap) || 0);
    const segPad = Math.max(4, gap);
    for (const s of geo.segs) {
      const raw = String(s.title || '').trim();
      if (!raw) continue;
      const avail = Math.max(28, s.w - segPad * 2);
      const text = ellipsize(ctx, raw, avail, titleFs, cfg.title.weight, family, cfg.title.letterSpacing);
      const x = titlePos.align === 'left' ? s.x + segPad
        : titlePos.align === 'right' ? s.x + s.w - segPad
          : s.x + s.w / 2;
      const isCurrent = s.index === seg.index;
      const alpha = cfg.title.highlight ? (isCurrent ? 1 : dim) : 1;
      titleItems.push({ text, x, y: titlePos.y, baseline: titlePos.baseline, align: titlePos.align, alpha });
    }
  } else if (cfg.title.mode !== 'none') {
    const raw = String((seg && seg.title) || '').trim();
    const a = titleAlphaAt(cfg, seg, t);
    if (raw && a > 0.005) {
      const text = ellipsize(ctx, raw, Math.max(40, geo.W - geo.track.x * 2),
        titleFs, cfg.title.weight, family, cfg.title.letterSpacing);
      titleItems.push({
        text, x: titlePos.x, y: titlePos.y,
        baseline: titlePos.baseline, align: titlePos.align, alpha: a,
      });
    }
  }

  // ---- 背景板 ----
  if (cfg.backdrop.enabled) {
    const boxes = [{ x: geo.track.x, y: geo.track.y, w: geo.track.w, h: geo.track.h }];
    if (showTime) {
      boxes.push({
        x: timePos.x - (timePos.align === 'right' ? timeW : timePos.align === 'center' ? timeW / 2 : 0) - 4,
        y: timePos.top, w: timeW + 8, h: timeFs * 1.3,
      });
    }
    for (const it of titleItems) {
      const w = measureText(ctx, it.text, titleFs, cfg.title.weight, family, cfg.title.letterSpacing);
      const bx = it.align === 'right' ? it.x - w : it.align === 'center' ? it.x - w / 2 : it.x;
      boxes.push({ x: bx - 4, y: titlePos.top, w: w + 8, h: titleFs * 1.3 });
    }
    const pad = Math.max(0, Number(cfg.backdrop.padding) || 0);
    const bx = Math.min(...boxes.map((b) => b.x)) - pad;
    const by = Math.min(...boxes.map((b) => b.y)) - pad;
    const bx2 = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
    const by2 = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
    ctx.save();
    ctx.fillStyle = hexToRgba(cfg.backdrop.color, cfg.backdrop.alpha);
    const bp = new Path2D();
    roundRect(bp, bx, by, bx2 - bx, by2 - by, cfg.backdrop.radius);
    ctx.fill(bp);
    ctx.restore();
  }

  // ---- 轨道 ----
  ctx.save();
  if (cfg.bar.glow) {
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = Math.max(3, geo.track.h * 0.7);
    ctx.shadowOffsetY = Math.max(1, geo.track.h * 0.12);
  }
  ctx.fillStyle = hexToRgba(cfg.bar.trackColor, cfg.bar.trackAlpha);
  ctx.fill(trackPath);
  ctx.restore();

  // ---- 已播放部分 ----
  if (p > 0) {
    ctx.save();
    ctx.clip(trackPath);
    const grad = ctx.createLinearGradient(geo.track.x, 0, geo.track.x + geo.track.w, 0);
    grad.addColorStop(0, cfg.bar.fillColor);
    grad.addColorStop(1, cfg.bar.gradient ? cfg.bar.fillColor2 : cfg.bar.fillColor);
    ctx.fillStyle = grad;
    ctx.fillRect(geo.track.x, geo.track.y, geo.track.w * p, geo.track.h);
    if (cfg.bar.capStyle === 'round' && p < 1) {
      ctx.beginPath();
      ctx.arc(geo.track.x + geo.track.w * p - geo.track.h / 2, geo.track.y + geo.track.h / 2, geo.track.h / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- 章节刻度 ----
  if (cfg.ticks.style === 'line' && geo.segs.length > 1) {
    ctx.save();
    ctx.strokeStyle = hexToRgba(cfg.ticks.color, cfg.ticks.alpha);
    ctx.lineWidth = Math.max(1, Number(cfg.ticks.width) || 2);
    ctx.lineCap = 'round';
    const over = geo.track.h * 0.55;
    for (let i = 1; i < geo.segs.length; i++) {
      const x = geo.segs[i].x;
      ctx.beginPath();
      ctx.moveTo(x, geo.track.y - over);
      ctx.lineTo(x, geo.track.y + geo.track.h + over);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- 进度圆点 ----
  if (cfg.dot.show) {
    const cx = geo.track.x + geo.track.w * p;
    const cy = geo.track.y + geo.track.h / 2;
    const r = Math.max(2, geo.track.h * (Number(cfg.dot.size) || 2.2) / 2);
    ctx.save();
    if (cfg.dot.glow) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = r * 1.4;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = cfg.dot.color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    if (cfg.dot.ring) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = cfg.dot.innerColor;
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- 章节标题 ----
  for (const it of titleItems) {
    if (it.alpha <= 0.005) continue;
    ctx.save();
    ctx.globalAlpha = clamp(it.alpha, 0, 1);
    ctx.font = fontString(titleFs, cfg.title.weight, family);
    ctx.textBaseline = it.baseline;
    ctx.fillStyle = hexToRgba(cfg.title.color, cfg.title.alpha);
    if (cfg.title.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = Math.max(4, titleFs * 0.22);
      ctx.shadowOffsetY = Math.max(1, titleFs * 0.05);
    }
    fillTextSpaced(ctx, it.text, it.x, it.y, cfg.title.letterSpacing, it.align);
    ctx.restore();
  }

  // ---- 时间数字 ----
  if (showTime) {
    ctx.save();
    ctx.font = fontString(timeFs, cfg.time.weight, family);
    ctx.textBaseline = timePos.baseline;
    ctx.fillStyle = hexToRgba(cfg.time.color, cfg.time.alpha);
    if (cfg.time.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = Math.max(3, timeFs * 0.2);
      ctx.shadowOffsetY = Math.max(1, timeFs * 0.05);
    }
    fillTextSpaced(ctx, timeText, timePos.x, timePos.y, cfg.time.letterSpacing, timePos.align);
    ctx.restore();
  }

  return { geo, seg, p };
}

/**
 * 估算导出耗时（毫秒）。
 * 实测 1920×1080：浏览器绘制 + PNG 编码约 8ms，ffmpeg 编码约 12ms，
 * 两者流水线并行，所以按每帧约 14ms 估，再按画布像素数等比放大。
 */
function estimateRenderMs(frameCount, width, height) {
  const px = (width || 1920) * (height || 1080);
  const perFrame = Math.max(4, 14 * (px / (1920 * 1080)));
  return Math.round(frameCount * perFrame + 4000);
}

window.VBarScene = {
  FONT_STACK,
  defaultConfig,
  computeGeometry,
  normalizeChapters,
  segmentsOf,
  renderScene,
  formatClock,
  formatTimecode,
  parseTimecode,
  hexToRgba,
  mix,
  luminance,
  clamp,
  estimateRenderMs,
};
