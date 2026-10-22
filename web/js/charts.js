// Small, dependency-free chart helpers (HTML bars + SVG columns/lines/sparklines).
// Every chart is paired with a table view so no value is only reachable by hover.

import { esc, int, compact } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];
export const seriesColor = (i) => `var(${SERIES[i % SERIES.length]})`;

/* ---------- tooltip ---------- */
const tip = () => document.getElementById('tooltip');
export function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  let left = x + 14;
  if (left + r.width > vw - 8) left = Math.max(8, x - r.width - 14);
  let top = y + 14;
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height - 14);
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}
export function hideTip() { tip().hidden = true; }

/* ---------- card with optional table view ---------- */
/**
 * card({ title, sub, span, body: Element|string, table: {columns, rows} })
 * columns: [{ key, label, num?, fmt? }]
 */
export function card({ title, sub = '', span = 6, body, table, actions = '', id }) {
  const el = document.createElement('article');
  el.className = `card span-${span}`;
  if (id) el.id = id;
  const tableId = `t-${Math.random().toString(36).slice(2, 9)}`;
  el.innerHTML = `
    <div class="card-head">
      <div><h2>${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</div>
      <div class="card-actions">${actions}${table ? `<button class="btn" type="button" aria-pressed="false" aria-controls="${tableId}">Table</button>` : ''}</div>
    </div>
    <div class="card-body"></div>
    ${table ? `<div class="data-table table-wrap" id="${tableId}" hidden></div>` : ''}`;
  const bodyEl = el.querySelector('.card-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  if (table) {
    const btn = el.querySelector(`button[aria-controls="${tableId}"]`);
    const wrap = el.querySelector(`#${tableId}`);
    btn.addEventListener('click', () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      if (on && !wrap.firstChild) wrap.innerHTML = tableHtml(table.columns, table.rows, title);
      wrap.hidden = !on;
    });
  }
  return el;
}

export function tableHtml(columns, rows, caption = '') {
  const head = columns.map((c) => `<th scope="col"${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${columns.map((c) => {
    const v = r[c.key];
    const txt = c.html ? c.html(v, r) : esc(c.fmt ? c.fmt(v, r) : v ?? '–');
    return `<td data-label="${esc(c.label)}"${c.num ? ' class="num"' : ''}>${txt}</td>`;
  }).join('')}</tr>`).join('');
  return `<table>${caption ? `<caption class="visually-hidden">${esc(caption)}</caption>` : ''}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---------- stat tiles ---------- */
export function stats(items) {
  const el = document.createElement('div');
  el.className = 'stats';
  el.innerHTML = items.map((s) => `
    <div class="stat${s.hero ? ' hero' : ''}">
      <div class="stat-label">${esc(s.label)}</div>
      <div class="stat-value">${esc(s.value)}</div>
      ${s.sub ? `<div class="stat-sub">${s.sub}</div>` : ''}
    </div>`).join('');
  return el;
}

/* ---------- horizontal bar list ---------- */
/** items: [{label, value, href?, title?, display?}] — single series, value at the tip. */
export function barList(items, { fmt = compact, alt = false, max } = {}) {
  const ul = document.createElement('ul');
  ul.className = 'bars';
  const top = max ?? Math.max(1, ...items.map((d) => d.value || 0));
  ul.innerHTML = items.map((d) => {
    const w = Math.max(0.4, ((d.value || 0) / top) * 100);
    const label = d.href ? `<a href="${esc(d.href)}"${d.external ? ' rel="noopener"' : ''}>${esc(d.label)}</a>` : esc(d.label);
    return `<li class="bar-row" title="${esc(d.title || `${d.label}: ${int(d.value)}`)}">
      <span class="bar-label">${label}</span>
      <span class="bar-track"><span class="bar-fill${alt ? ' alt' : ''}" style="width:calc((100% - 4.5em) * ${(w / 100).toFixed(4)})"></span><span class="bar-value">${esc(d.display ?? fmt(d.value))}</span></span>
    </li>`;
  }).join('');
  return ul;
}

/* ---------- part-to-whole share bar ---------- */
export function shareBar(parts, { fmt = int } = {}) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="share" role="img" aria-label="${esc(parts.map((p) => `${p.label}: ${((p.value / total) * 100).toFixed(1)}%`).join(', '))}">
      ${parts.map((p, i) => `<span style="flex:${p.value} 0 0;background:${p.color || seriesColor(i)}" data-i="${i}"></span>`).join('')}
    </div>
    <ul class="legend">${parts.map((p, i) => `<li><span class="swatch" style="background:${p.color || seriesColor(i)}"></span>${esc(p.label)} · ${fmt(p.value)} (${((p.value / total) * 100).toFixed(1)}%)</li>`).join('')}</ul>`;
  el.querySelectorAll('.share span').forEach((s) => {
    const p = parts[+s.dataset.i];
    s.addEventListener('mousemove', (e) => showTip(`<strong>${esc(p.label)}</strong>${fmt(p.value)} · ${((p.value / total) * 100).toFixed(1)}%`, e.clientX, e.clientY));
    s.addEventListener('mouseleave', hideTip);
  });
  return el;
}

/* ---------- helpers ---------- */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
}
/** Responsive SVG: re-render on width change. */
function responsive(container, draw) {
  let lastW = 0;
  const render = () => {
    const w = Math.round(container.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    container.innerHTML = '';
    draw(w);
  };
  const ro = new ResizeObserver(render);
  ro.observe(container);
  requestAnimationFrame(render);
}
const roundedTop = (x, y, w, h, r) => {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

/* ---------- column chart (time buckets, optional 2-part stack) ---------- */
/**
 * data: [{x: label, values: [a, b?]}], series: [{label}], xFmt: label formatter for ticks
 */
export function columnChart(data, { series = [{ label: 'Value' }], xFmt = (x) => x, tipTitle = (d) => d.x, height = 220, fmt = int } = {}) {
  const container = document.createElement('div');
  container.className = 'chart-box';
  const legend = series.length > 1
    ? `<ul class="legend">${series.map((s, i) => `<li><span class="swatch" style="background:${seriesColor(i)}"></span>${esc(s.label)}</li>`).join('')}</ul>` : '';
  responsive(container, (W) => {
    const m = { t: 10, r: 6, b: 24, l: 40 };
    const H = height;
    const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': series.map((s) => s.label).join(', ') + ' per period' });
    const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
    const ymax = niceMax(Math.max(...totals));
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const y = (v) => m.t + ih - (v / ymax) * ih;
    for (let i = 0; i <= 4; i++) {
      const v = (ymax / 4) * i;
      el('line', { class: i ? 'gridline' : 'baseline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, svg);
      const t = el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg);
      t.textContent = compact(v);
    }
    const band = iw / data.length;
    const bw = Math.min(24, Math.max(2, band - 2));
    const tickEvery = Math.ceil(data.length / Math.max(2, Math.floor(iw / 70)));
    data.forEach((d, i) => {
      const x = m.l + i * band + (band - bw) / 2;
      let acc = 0;
      // Stack from the baseline: series[0] at the bottom; the top segment gets the rounded end.
      const lastNonZero = d.values.reduce((li, v, k) => (v > 0 ? k : li), -1);
      d.values.forEach((v, k) => {
        if (v <= 0) return;
        const y0 = y(acc), y1 = y(acc + v);
        const top = k < lastNonZero ? y1 + 2 : y1; // 2px surface gap between stacked segments
        const h = Math.max(1, y0 - top);
        el('path', { class: `col${k ? ' stack-2' : ''}`, d: k === lastNonZero ? roundedTop(x, top, bw, h, 4) : `M${x},${top}h${bw}v${h}h${-bw}Z` }, svg);
        acc += v;
      });
      if (i % tickEvery === 0) {
        const t = el('text', { x: m.l + i * band + band / 2, y: H - 6, 'text-anchor': 'middle' }, svg);
        t.textContent = xFmt(d.x);
      }
      // generous hit target for the whole column band
      const hit = el('rect', { x: m.l + i * band, y: m.t, width: band, height: ih, fill: 'transparent' }, svg);
      hit.addEventListener('mousemove', (e) => {
        showTip(`<strong>${esc(tipTitle(d))}</strong>${series.map((s, k) => `<div class="row"><span><span class="swatch" style="background:${seriesColor(k)}"></span> ${esc(s.label)}</span><span>${fmt(d.values[k] || 0)}</span></div>`).join('')}`, e.clientX, e.clientY);
      });
      hit.addEventListener('mouseleave', hideTip);
    });
    container.append(svg);
  });
  const wrap = document.createElement('div');
  wrap.append(container);
  if (legend) wrap.insertAdjacentHTML('beforeend', legend);
  return wrap;
}

/* ---------- multi-series line chart with crosshair ---------- */
/**
 * xs: [Date|string], series: [{label, values:[number|null], color?}]
 */
export function lineChart(xs, series, { height = 260, fmt = compact, xFmt = (x) => x, tipTitle = (x) => x, yLabel = '', time = false, yMax, log = false } = {}) {
  const container = document.createElement('div');
  const legendHtml = series.length > 1
    ? `<ul class="legend">${series.map((s, i) => `<li><span class="swatch line" style="background:${s.color || seriesColor(i)}"></span>${esc(s.label)}</li>`).join('')}</ul>` : '';
  responsive(container, (W) => {
    const m = { t: 12, r: 12, b: 24, l: 46 };
    const H = height;
    const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${yLabel || 'Values'} for ${series.map((s) => s.label).join(', ')}` });
    const all = series.flatMap((s) => s.values).filter((v) => v != null);
    const ymax = yMax ?? niceMax(Math.max(Number.EPSILON, ...all));
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    // x by index, or proportional to time when snapshots are irregularly spaced
    const tx = time ? xs.map((d) => Date.parse(d)) : xs.map((_, i) => i);
    const t0 = tx[0], t1 = tx[tx.length - 1];
    const x = (i) => m.l + (t1 === t0 ? iw / 2 : ((tx[i] - t0) / (t1 - t0)) * iw);
    // log scale: one gridline per power of ten between the smallest and largest value
    const lo = log ? 10 ** Math.floor(Math.log10(Math.max(1, Math.min(...all.filter((v) => v > 0))))) : 0;
    const hi = log ? 10 ** Math.ceil(Math.log10(Math.max(10, ...all))) : ymax;
    const y = log
      ? (v) => m.t + ih - ((Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * ih
      : (v) => m.t + ih - (v / ymax) * ih;
    const ticks = log
      ? Array.from({ length: Math.round(Math.log10(hi / lo)) + 1 }, (_, i) => lo * 10 ** i)
      : [0, 1, 2, 3, 4].map((i) => (ymax / 4) * i);
    ticks.forEach((v, i) => {
      el('line', { class: i ? 'gridline' : 'baseline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, svg);
      const t = el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg);
      t.textContent = fmt(v);
    });
    // x ticks: greedy, at least 80px apart, always including the last point
    let lastTick = Infinity;
    for (let i = xs.length - 1; i >= 0; i--) {
      if (lastTick - x(i) < 80) continue;
      lastTick = x(i);
      const t = el('text', { x: x(i), y: H - 6, 'text-anchor': i === xs.length - 1 ? 'end' : x(i) - m.l < 30 ? 'start' : 'middle' }, svg);
      t.textContent = xFmt(xs[i]);
    }
    series.forEach((s, k) => {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      el('path', { class: 'series', d, stroke: s.color || seriesColor(k) }, svg);
      const li = s.values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop();
      if (li != null && li >= 0) el('circle', { class: 'dot', cx: x(li), cy: y(s.values[li]), r: 4, fill: s.color || seriesColor(k) }, svg);
    });
    const cross = el('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, x1: -10, x2: -10 }, svg);
    const hover = el('g', {}, svg);
    const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      let i = 0;
      for (let k = 1; k < xs.length; k++) if (Math.abs(x(k) - px) < Math.abs(x(i) - px)) i = k;
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      hover.innerHTML = '';
      const rowsHtml = series.map((s, k) => ({ s, k, v: s.values[i] }))
        .filter((r) => r.v != null)
        .sort((a, b) => b.v - a.v)
        .map(({ s, k, v }) => {
          el('circle', { class: 'dot', cx: x(i), cy: y(v), r: 4, fill: s.color || seriesColor(k) }, hover);
          return `<div class="row"><span><span class="swatch" style="background:${s.color || seriesColor(k)}"></span> ${esc(s.label)}</span><span>${fmt(v)}</span></div>`;
        }).join('');
      showTip(`<strong>${esc(tipTitle(xs[i]))}</strong>${rowsHtml}`, e.clientX, e.clientY);
    });
    hit.addEventListener('mouseleave', () => { hideTip(); hover.innerHTML = ''; cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); });
    container.append(svg);
  });
  const wrap = document.createElement('div');
  wrap.append(container);
  if (legendHtml) wrap.insertAdjacentHTML('beforeend', legendHtml);
  return wrap;
}

/* ---------- sparkline ---------- */
export function sparkline(values, { label = '' } = {}) {
  const vals = values.map((v) => (v == null ? null : v));
  const known = vals.filter((v) => v != null);
  if (known.length < 2) return '<svg class="spark" aria-hidden="true"></svg>';
  const W = 96, H = 26, p = 3;
  const min = Math.min(...known), max = Math.max(...known);
  const x = (i) => p + (i / (vals.length - 1)) * (W - 2 * p);
  const y = (v) => (max === min ? H / 2 : H - p - ((v - min) / (max - min)) * (H - 2 * p));
  let d = '', pen = false;
  vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
  const li = vals.length - 1 - [...vals].reverse().findIndex((v) => v != null);
  const first = known[0], last = known[known.length - 1];
  const dir = last > first * 1.02 ? 'up' : last < first * 0.98 ? 'down' : 'flat';
  return `<svg class="spark ${dir}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label || `Trend from ${compact(first)} to ${compact(last)}`)}"><path d="${d}"/><circle cx="${x(li)}" cy="${y(vals[li])}" r="3"/></svg>`;
}

/* ---------- stacked horizontal bar list (part-to-whole per row) ---------- */
/**
 * items: [{label, parts: number[], href?, key?}], series: [{label, color}]
 * Rows can be made clickable with onSelect(item).
 */
export function stackedBarList(items, series, { fmt = int, onSelect } = {}) {
  const wrap = document.createElement('div');
  const max = Math.max(1, ...items.map((d) => d.parts.reduce((a, b) => a + b, 0)));
  const ul = document.createElement('ul');
  ul.className = 'bars';
  ul.innerHTML = items.map((d, i) => {
    const total = d.parts.reduce((a, b) => a + b, 0);
    const segs = d.parts.map((v, k) => (v > 0 ? `<span class="seg" data-k="${k}" style="flex:${v} 0 0;background:${series[k].color}"></span>` : '')).join('');
    const label = onSelect
      ? `<button type="button" class="link-btn" data-i="${i}">${esc(d.label)}</button>`
      : d.href ? `<a href="${esc(d.href)}" rel="noopener">${esc(d.label)}</a>` : esc(d.label);
    return `<li class="bar-row" data-i="${i}">
      <span class="bar-label" title="${esc(d.label)}">${label}</span>
      <span class="bar-track"><span class="stack" style="width:calc((100% - 4.5em) * ${(total / max).toFixed(4)})">${segs}</span><span class="bar-value">${esc(fmt(total))}</span></span>
    </li>`;
  }).join('');
  ul.querySelectorAll('.bar-row').forEach((row) => {
    const d = items[+row.dataset.i];
    row.addEventListener('mousemove', (e) => {
      const rowsHtml = series.map((s, k) => (d.parts[k] ? `<div class="row"><span><span class="swatch" style="background:${s.color}"></span> ${esc(s.label)}</span><span>${fmt(d.parts[k])}</span></div>` : '')).join('');
      showTip(`<strong>${esc(d.label)}</strong>${rowsHtml}`, e.clientX, e.clientY);
    });
    row.addEventListener('mouseleave', hideTip);
  });
  if (onSelect) ul.querySelectorAll('.link-btn').forEach((b) => b.addEventListener('click', () => onSelect(items[+b.dataset.i])));
  wrap.append(ul);
  wrap.insertAdjacentHTML('beforeend', `<ul class="legend">${series.map((s) => `<li><span class="swatch" style="background:${s.color}"></span>${esc(s.label)}</li>`).join('')}</ul>`);
  return wrap;
}
