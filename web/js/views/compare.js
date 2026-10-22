// Side-by-side comparison of up to four models (#compare?ids=a,b,c).

import { lineChart, card } from '../charts.js';
import { clearCompare, compareHref, compareList, COMPARE_MAX, loadModel, toggleCompare } from '../models.js';
import {
  compact, date, esc, FORMAT_LABEL, gigabytes, hfUrl, int, language, LICENSE_FAMILY, modelLink,
  params as fmtParams, REMOVAL_KIND, shortDate, task,
} from '../format.js';

export async function render(section, params) {
  const fromUrl = (params.get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, COMPARE_MAX);
  const ids = fromUrl.length ? fromUrl : compareList();
  section.innerHTML = `<header class="page-head"><p class="eyebrow">Compare</p><h1 id="h-compare">Compare models</h1>
    <p class="lead">Up to ${COMPARE_MAX} models side by side. Add models with the <strong>+ Compare</strong> button on any model page,
    finder result or list; the link of this page can be shared.</p></header>`;
  if (!ids.length) {
    section.insertAdjacentHTML('beforeend', '<div class="empty">Nothing to compare yet. <a href="#finder">Find models →</a></div>');
    return;
  }
  const loaded = await Promise.all(ids.map((id) => loadModel(id).then((r) => ({ id, ...r })).catch(() => ({ id, rec: null }))));
  const ms = loaded.map((x) => x.rec).filter(Boolean);
  const dates = loaded.find((x) => x.dates)?.dates || [];
  const missing = loaded.filter((x) => !x.rec).map((x) => x.id);

  const kidsTotal = (m) => (m.kids ? Object.values(m.kids).reduce((a, b) => a + b, 0) : 0);
  const ROWS = [
    ['Task', (m) => (m.t ? esc(task(m.t)) : '–')],
    ['Size', (m) => fmtParams(m.p ? m.p / 1e6 : null) || '–'],
    ['Memory to load', (m) => (m.mem ? `≈ ${gigabytes(m.mem)}` : '–')],
    ['License', (m) => `${esc(m.lic || 'not declared')}<br><span class="note">${esc((LICENSE_FAMILY[m.lf] || LICENSE_FAMILY.unknown).label)}</span>`],
    ['Formats', (m) => (m.fmt.length ? m.fmt.map((f) => esc(FORMAT_LABEL[f] || f)).join(', ') : '–')],
    ['Languages', (m) => (m.lang?.length ? esc(m.lang.slice(0, 5).map(language).join(', ')) + (m.lang.length > 5 ? ` +${m.lang.length - 5}` : '') : '–')],
    ['Downloads (30 days)', (m) => int(m.dl), true],
    ['Likes', (m) => int(m.lk), true],
    ['Trending score', (m) => (m.tr ? compact(m.tr) : '–'), true],
    ['Created', (m) => esc(date(m.c))],
    ['Built on', (m) => (m.par?.length ? m.par.map(([p]) => modelLink(p)).join('<br>') : '–')],
    ['Models built on it', (m) => int(kidsTotal(m)), true],
    ['Family', (m) => esc(m.fam || '–')],
    ['Results on its card', (m) => (m.bm?.length ? `${int(m.bm.length)} reported` : '–')],
    ['Status', (m) => (m.rm ? `Removed ${esc(date(m.rm))} (${esc(REMOVAL_KIND[m.rk]?.label || 'removed')})` : (m.fl || []).includes('gated') ? 'Live, gated' : 'Live')],
  ];
  const table = document.createElement('div');
  table.className = 'card span-12 table-wrap compare-table';
  table.innerHTML = `<table><caption class="visually-hidden">Model comparison</caption>
    <thead><tr><th scope="col">Model</th>${ms.map((m) => `<th scope="col">${modelLink(m.id)}<br>
      <span class="compare-actions">${m.rm ? '' : `<a class="note" href="${esc(hfUrl(m.id))}" rel="noopener">Hub ↗</a>`}
      <button type="button" class="btn btn-small" data-remove="${esc(m.id)}">Remove</button></span></th>`).join('')}</tr></thead>
    <tbody>${ROWS.map(([label, f]) => `<tr><th scope="row">${label}</th>${ms.map((m) => `<td>${f(m)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const grid = document.createElement('div');
  grid.className = 'grid';
  section.append(grid);
  grid.append(table);
  if (missing.length) grid.insertAdjacentHTML('beforeend', `<p class="note span-12">Not in the dataset: ${missing.map(esc).join(', ')}.</p>`);

  const withHistory = ms.filter((m) => m.h?.some((v) => v != null));
  if (withHistory.length) {
    grid.append(card({
      span: 12, title: 'Downloads over time', sub: 'Rolling 30-day downloads at each snapshot (log scale)',
      body: lineChart(dates, withHistory.map((m) => ({ label: m.id, values: m.h })), { time: true, log: true, xFmt: shortDate, tipTitle: (d) => date(d), yLabel: '30-day downloads' }),
    }));
  }
  grid.insertAdjacentHTML('beforeend', `<div class="span-12 hero-actions"><button type="button" class="btn" id="c-share">Copy link to this comparison</button>
    <button type="button" class="btn btn-ghost" id="c-clear">Clear the list</button><span class="note" id="c-msg" role="status"></span></div>`);

  table.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const keep = ids.filter((x) => x.toLowerCase() !== b.dataset.remove.toLowerCase());
    if (compareList().some((x) => x.toLowerCase() === b.dataset.remove.toLowerCase())) toggleCompare(b.dataset.remove);
    location.hash = compareHref(keep);
  });
  section.querySelector('#c-share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}${compareHref(ms.map((m) => m.id))}`;
    try { await navigator.clipboard.writeText(url); section.querySelector('#c-msg').textContent = 'Link copied.'; } catch (e) { section.querySelector('#c-msg').textContent = url; }
  });
  section.querySelector('#c-clear').addEventListener('click', () => { clearCompare(); location.hash = '#compare'; });
}

export const update = render;
