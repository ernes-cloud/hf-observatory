import { load } from '../data.js';
import { term } from '../glossary.js';
import { pageHeader } from '../ui.js';
import { card, lineChart, seriesColor, sparkline, stats } from '../charts.js';
import { authorUrl, compact, date, esc, hfUrl, int, pct, shortDate, signed, signedPct, task } from '../format.js';

let T = null;
let windowDays = '7';

export async function render(section, params) {
  T = await load('trends.json');
  const windows = Object.keys(T.windows);
  section.replaceChildren(pageHeader({
    id: 'h-trends', eyebrow: 'Trends', title: 'What is rising and what is fading',
    lead: `How popularity changes over time, measured across ${int(T.snapshots.length)} daily ${term('snapshot', 'snapshots')} from ${esc(date(T.snapshots[0]?.date))} to ${esc(date(T.snapshots.at(-1)?.date))}.`,
    howTo: [
      'Pick a period (7, 14 or 30 days). Every list compares the first and the last day of that period.',
      `${term('downloads', 'Downloads')} are a rolling 30-day count, so “+5M” means the model was downloaded 5 million more times in the latest 30-day window than in the earlier one.`,
      'The small lines (sparklines) show the path in between. A green end dot means up, red means down.',
      'Only models tracked on both dates are compared. Models that appear for the first time are listed under “New to the radar” instead of “Rising”.',
    ],
  }));
  section.insertAdjacentHTML('beforeend', '<div id="trends-body"></div>');
  const body = section.querySelector('#trends-body');
  if (T.snapshots.length < 2 || !windows.length) {
    body.innerHTML = '<div class="empty">Not enough history yet. Trends need at least two dataset releases about a week apart.</div>';
    return;
  }
  windowDays = windows.includes(params.get('window')) ? params.get('window') : windows[0];
  draw(body);
}

export function update(section, params) {
  const w = params.get('window');
  if (T && w && w !== windowDays && T.windows[w]) {
    windowDays = w;
    draw(section.querySelector('#trends-body'));
  }
}

function seriesFor(id, from, to) {
  const s = T.series[id] || [];
  return s.slice(from, to + 1);
}

function moverList(items, { from, to, kind = 'delta', empty = 'Nothing to show.' } = {}) {
  if (!items.length) return `<p class="note">${empty}</p>`;
  return `<ul class="movers">${items.map((m) => {
    const isOrg = !m.id;
    const name = isOrg
      ? `<a href="${esc(authorUrl(m.author))}" rel="noopener">${esc(m.author)}</a><small>${int(m.models)} models compared</small>`
      : `<a href="${esc(hfUrl(m.id))}" rel="noopener">${esc(m.id)}</a><small>${esc(task(m.task))}${m.family ? ` · ${esc(m.family)}` : ''}</small>`;
    let value;
    if (kind === 'ratio') value = `<span class="delta up" title="${int(m.old)} → ${int(m.new)}">×${m.ratio < 10 ? m.ratio.toFixed(1) : compact(m.ratio)}<br><small style="font-weight:400;color:var(--muted)">${compact(m.old)} → ${compact(m.new)}</small></span>`;
    else if (kind === 'new') value = `<span class="delta">${compact(m.new)}</span>`;
    else value = `<span class="delta ${m.delta >= 0 ? 'up' : 'down'}" title="${int(m.old)} → ${int(m.new)}">${signed(m.delta)}<br><small style="font-weight:400;color:var(--muted)">${compact(m.old)} → ${compact(m.new)}</small></span>`;
    const spark = isOrg ? '<span></span>' : sparkline(seriesFor(m.id, from, to), { label: `30-day downloads over the window for ${m.id}` });
    return `<li><span class="name">${name}</span>${spark}${value}</li>`;
  }).join('')}</ul>`;
}

function draw(body) {
  const W = T.windows[windowDays];
  const snaps = T.snapshots;
  const from = W.from, to = W.to;
  const tot = T.totals;
  const a = tot[from], b = tot[to];
  const windows = Object.keys(T.windows);
  body.innerHTML = `
    <div class="filter-bar">
      <div class="segmented" role="group" aria-label="Comparison window">
        ${windows.map((w) => `<button type="button" data-w="${w}" aria-pressed="${w === windowDays}">${w} days</button>`).join('')}
      </div>
      <p class="note">Comparing ${esc(date(snaps[from].date))} (${esc(snaps[from].tag)}) with ${esc(date(snaps[to].date))} (${esc(snaps[to].tag)})</p>
    </div>`;
  body.querySelectorAll('.segmented button').forEach((btn) => btn.addEventListener('click', () => {
    windowDays = btn.dataset.w;
    history.replaceState(null, '', `#trends?window=${windowDays}`);
    draw(body);
  }));

  body.append(stats([
    { label: 'Live models tracked', value: int(b.live), sub: `${signed(b.live - a.live, int)} in ${windowDays} days` },
    { label: 'Downloads, last 30 days', value: compact(b.downloads), sub: `${signedPct(b.downloads / a.downloads - 1)} vs ${shortDate(snaps[from].date)} (all tracked models)` },
    { label: 'Biggest gainer', value: W.rising[0] ? signed(W.rising[0].delta) : '–', sub: W.rising[0] ? esc(W.rising[0].id) : '' },
    { label: 'Biggest newcomer', value: W.newcomers[0] ? compact(W.newcomers[0].new) : '–', sub: W.newcomers[0] ? `${esc(W.newcomers[0].id)} (not tracked ${windowDays} days ago)` : '' },
  ]));

  const grid = document.createElement('div');
  grid.className = 'grid';
  body.append(grid);

  const dates = snaps.map((s) => s.date);
  const xOpts = { time: true, xFmt: shortDate, tipTitle: (d) => date(d) };

  // Download evolution of the current leaders (top 8 so every line gets its own colour)
  const leaders = T.leaders.slice(0, 8);
  const leaderBody = document.createElement('div');
  const drawLeaders = (log) => leaderBody.replaceChildren(lineChart(dates, leaders.map((m) => ({ label: m.id, values: T.series[m.id] || [] })), { ...xOpts, log, yLabel: '30-day downloads' }));
  const leaderCard = card({
    span: 12, title: 'Download evolution of the most downloaded models', sub: '30-day downloads at each snapshot. The log scale keeps models of very different sizes readable.',
    actions: `<div class="segmented" role="group" aria-label="Scale"><button type="button" data-s="log" aria-pressed="true">Log</button><button type="button" data-s="linear" aria-pressed="false">Linear</button></div>`,
    body: leaderBody,
    table: {
      columns: [{ key: 'date', label: 'Snapshot', fmt: date }, ...leaders.map((m, k) => ({ key: `m${k}`, label: m.id, num: true, fmt: int }))],
      rows: dates.map((d, i) => Object.fromEntries([['date', d], ...leaders.map((m, k) => [`m${k}`, (T.series[m.id] || [])[i]])])),
    },
  });
  leaderCard.querySelectorAll('.segmented button').forEach((btn) => btn.addEventListener('click', () => {
    leaderCard.querySelectorAll('.segmented button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    drawLeaders(btn.dataset.s === 'log');
  }));
  drawLeaders(true);
  grid.append(leaderCard);

  // Family adoption
  const fams = Object.keys(T.families);
  const famCard = card({
    span: 12, title: 'Adoption by family', sub: 'Share of all 30-day downloads, or number of live models, per family (detected from names and base models)',
    actions: `<div class="segmented" role="group" aria-label="Metric"><button type="button" data-m="share" aria-pressed="true">Download share</button><button type="button" data-m="models" aria-pressed="false">Models</button></div>`,
    body: document.createElement('div'),
    table: {
      columns: [{ key: 'date', label: 'Snapshot', fmt: date }, ...fams.flatMap((f) => [{ key: `${f}-d`, label: `${f} downloads`, num: true, fmt: int }, { key: `${f}-m`, label: `${f} models`, num: true, fmt: int }])],
      rows: dates.map((d, i) => Object.fromEntries([['date', d], ...fams.flatMap((f) => [[`${f}-d`, T.families[f].downloads[i]], [`${f}-m`, T.families[f].models[i]]])])),
    },
  });
  const famBody = famCard.querySelector('.card-body');
  const drawFam = (metric) => {
    const totals = dates.map((_, i) => tot[i].downloads || 1);
    const series = fams.map((f, k) => ({
      label: f, color: seriesColor(k),
      values: metric === 'share' ? T.families[f].downloads.map((v, i) => v / totals[i]) : T.families[f].models,
    }));
    famBody.replaceChildren(lineChart(dates, series, { ...xOpts, fmt: metric === 'share' ? (v) => pct(v) : compact, yLabel: metric === 'share' ? 'Share of downloads' : 'Live models' }));
  };
  famCard.querySelectorAll('.segmented button').forEach((btn) => btn.addEventListener('click', () => {
    famCard.querySelectorAll('.segmented button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    drawFam(btn.dataset.m);
  }));
  drawFam('share');
  grid.append(famCard);

  const listCard = (title, sub, html) => card({ title, sub, body: html });
  grid.append(listCard('Rising', `Largest gain in 30-day downloads over ${windowDays} days`, moverList(W.rising, { from, to })));
  grid.append(listCard('Fading', `Largest drop in 30-day downloads over ${windowDays} days`, moverList(W.fading, { from, to })));
  grid.append(listCard('Breakouts', 'Fastest relative growth (at least ×1.5, from 500+ to 5,000+ downloads)', moverList(W.breakout, { from, to, kind: 'ratio', empty: 'No breakouts in this window.' })));
  grid.append(listCard('New to the radar', `Most downloaded models that were not tracked ${windowDays} days ago (new releases or newly discovered)`, moverList(W.newcomers, { from, to, kind: 'new' })));
  grid.append(listCard('Publishers on the rise', 'Change in summed 30-day downloads of their models', moverList(W.orgs_rising.slice(0, 10), { from, to })));
  grid.append(listCard('Publishers losing ground', 'Change in summed 30-day downloads of their models', moverList(W.orgs_fading.slice(0, 10), { from, to })));

  const trending = T.trending;
  grid.append(card({
    span: 12, title: 'Trending right now', sub: 'Hugging Face trending score at the latest snapshot; the sparkline shows the score over all snapshots',
    body: `<ul class="movers">${trending.map((m) => `<li><span class="name"><a href="${esc(hfUrl(m.id))}" rel="noopener">${esc(m.id)}</a><small>${esc(task(m.task))} · ${compact(m.downloads)} downloads</small></span>${sparkline(T.trending_series[m.id] || [], { label: `Trending score history for ${m.id}` })}<span class="delta">${compact(m.score)}</span></li>`).join('')}</ul>`,
  }));
}
