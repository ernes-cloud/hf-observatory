// Publisher (#org?name=…) and family (#family?name=…) pages: the same set of cards over
// a group of live models taken from the finder index, plus what only one of them has
// (removals for a publisher, the family's download share over time and its trees).

import { load } from '../data.js';
import { barList, card, columnChart, lineChart, shareBar, stats } from '../charts.js';
import { bindCompareButtons, compareButton, loadFinder } from '../models.js';
import {
  authorUrl, compact, date, esc, finderHref, int, LF_COLOR, LF_ORDER, LICENSE_FAMILY, modelLink, orgHref,
  params as fmtParams, pct, REMOVAL_KIND, shortDate, task,
} from '../format.js';

const DAY_MS = 86400000;
const TOP = 12;

export function renderGroup(kind) {
  return async function render(section, params) {
    const name = (params.get('name') || '').trim();
    if (!name) {
      section.innerHTML = `<div class="empty">No ${kind === 'org' ? 'publisher' : 'family'} selected. <a href="#overview">Browse the overview →</a></div>`;
      return;
    }
    section.innerHTML = '<p class="loading" role="status">Loading…</p>';
    const D = await loadFinder();
    const c = D.cols;
    const famIdx = kind === 'family' ? D.dict.family.findIndex((f) => f.toLowerCase() === name.toLowerCase()) : -1;
    const prefix = `${name.toLowerCase()}/`;
    const rows = [];
    for (let i = 0; i < D.n; i++) {
      if (kind === 'org' ? D.idLower[i].startsWith(prefix) : c.fam[i] === famIdx) rows.push(i);
    }
    const label = kind === 'family' && famIdx >= 0 ? D.dict.family[famIdx] : rows.length ? (kind === 'org' ? c.id[rows[0]].split('/')[0] : name) : name;
    document.title = `${label} · HF Observatory`;
    const signal = rows.filter((i) => !(c.flags[i] & 8));
    const dl = rows.reduce((a, i) => a + (c.dl[i] || 0), 0);
    const likes = rows.reduce((a, i) => a + (c.likes[i] || 0), 0);

    section.innerHTML = `
      <header class="page-head">
        <p class="eyebrow">${kind === 'org' ? 'Publisher' : 'Model family'}</p>
        <h1 id="h-${kind}">${esc(label)}</h1>
        <p class="lead">${kind === 'org'
          ? `Everything ${esc(label)} publishes among the models the radar tracks.`
          : `Models detected as ${esc(label)} from their name or the base model they declare, from every publisher.`}</p>
        <div class="hero-actions">
          ${kind === 'org' ? `<a class="btn btn-primary" href="${esc(authorUrl(label))}" rel="noopener">${esc(label)} on Hugging Face ↗</a>` : ''}
          <a class="btn btn-ghost" href="${esc(finderHref(kind === 'org' ? { q: `${label}/` } : { q: label }))}">Search them in the finder</a>
        </div>
      </header>`;
    if (!rows.length) {
      section.insertAdjacentHTML('beforeend', `<div class="empty">No live model found for “${esc(name)}”.</div>`);
      if (kind === 'org') section.append(await removedCard(label));
      return;
    }
    const created = rows.map((i) => c.created[i]).filter((x) => x != null);
    section.append(stats([
      { label: 'Live models', value: int(rows.length), sub: rows.length > signal.length ? `${int(rows.length - signal.length)} of them low-signal uploads` : 'all with some traction', hero: true },
      { label: 'Downloads, last 30 days', value: compact(dl), sub: 'summed over its live models' },
      { label: 'Likes', value: compact(likes), sub: `${int(signal.filter((i) => c.likes[i] > 0).length)} models with at least one` },
      kind === 'org'
        ? { label: 'Publishing since', value: created.length ? date(Math.min(...created) * DAY_MS) : '–', sub: created.length ? `latest model ${date(Math.max(...created) * DAY_MS)}` : '' }
        : { label: 'Publishers', value: int(new Set(rows.map((i) => D.idLower[i].split('/')[0])).size), sub: 'releasing models of this family' },
    ]));

    const grid = document.createElement('div');
    grid.className = 'grid';
    section.append(grid);

    const top = (signal.length ? signal : rows).slice(0, TOP); // rows keep the index order: downloads
    grid.append(card({
      title: 'Most downloaded models', sub: 'Last 30 days',
      body: `<ul class="alt-list">${top.map((i) => `<li><span class="name">${modelLink(c.id[i], { short: kind === 'org' })}<small>${[c.task[i] >= 0 ? task(D.dict.task[c.task[i]]) : '', fmtParams(c.params[i]), `${compact(c.dl[i])} downloads`].filter(Boolean).map(esc).join(' · ')}</small></span>${compareButton(c.id[i])}</li>`).join('')}</ul>`,
    }));
    bindCompareButtons(grid);

    if (kind === 'family') {
      const pubs = new Map();
      for (const i of signal) {
        const a = c.id[i].split('/')[0];
        const p = pubs.get(a) || { a, n: 0, dl: 0 };
        p.n++; p.dl += c.dl[i] || 0;
        pubs.set(a, p);
      }
      const list = [...pubs.values()].sort((x, y) => y.dl - x.dl).slice(0, TOP);
      grid.append(card({
        title: 'Who publishes it', sub: 'Publishers by downloads of their models in this family',
        body: barList(list.map((p) => ({ label: p.a, value: p.dl, href: orgHref(p.a), title: `${p.a}: ${int(p.n)} models, ${int(p.dl)} downloads` }))),
        table: { columns: [{ key: 'a', label: 'Publisher' }, { key: 'n', label: 'Models', num: true, fmt: int }, { key: 'dl', label: 'Downloads (30d)', num: true, fmt: int }], rows: list },
      }));
    }

    const count = (key, dict) => {
      const m = new Map();
      for (const i of signal) { const v = c[key][i]; if (v >= 0) m.set(v, (m.get(v) || 0) + 1); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v: dict[v], n }));
    };
    const tasks = count('task', D.dict.task).slice(0, 10);
    if (tasks.length) {
      grid.append(card({
        title: 'What its models do', sub: 'Tasks, by number of models (low-signal uploads left out)',
        body: barList(tasks.map((t) => ({ label: task(t.v), value: t.n, href: finderHref(kind === 'org' ? { task: t.v, q: `${label}/` } : { task: t.v, q: label }) })), { fmt: int }),
      }));
    }

    const lfs = count('lf', D.dict.license_family);
    const licBody = document.createElement('div');
    licBody.append(shareBar([...lfs].sort((a, b) => LF_ORDER.indexOf(a.v) - LF_ORDER.indexOf(b.v)).map((x) => ({ label: LICENSE_FAMILY[x.v]?.label || x.v, value: x.n, color: LF_COLOR[x.v] }))));
    const lics = count('lic', D.dict.license).slice(0, 6);
    if (lics.length) licBody.insertAdjacentHTML('beforeend', `<p class="note" style="margin-top:12px">Most used: ${lics.map((l) => `${esc(l.v)} (${int(l.n)})`).join(', ')}</p>`);
    grid.append(card({ title: 'Licenses', sub: 'How its models may be used', body: licBody }));

    // Releases per week, by creation date on the Hub (live models only).
    const weeks = new Map();
    for (const i of rows) {
      if (c.created[i] == null) continue;
      const d = new Date(c.created[i] * DAY_MS);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const k = d.toISOString().slice(0, 10);
      weeks.set(k, (weeks.get(k) || 0) + 1);
    }
    const series = [...weeks.entries()].sort().slice(-26).map(([x, n]) => ({ x, values: [n] }));
    if (series.length > 1) {
      grid.append(card({
        span: 12, title: 'New models per week', sub: 'By creation date on the Hub; live models only, last 26 weeks with releases',
        body: columnChart(series, { series: [{ label: 'Models' }], xFmt: shortDate, tipTitle: (w) => `Week of ${date(w.x)}`, height: 180 }),
      }));
    }

    if (kind === 'org') grid.append(await removedCard(label));
    else grid.append(...await familyExtras(label));
  };
}

async function removedCard(author) {
  let g = null;
  try { g = await load('graveyard.json'); } catch (e) { /* optional */ }
  const prefix = `${author.toLowerCase()}/`;
  const cols = g?.models?.columns || [];
  const ix = (k) => cols.indexOf(k);
  const gone = g ? g.models.rows.filter((r) => r[0].toLowerCase().startsWith(prefix)) : [];
  const body = gone.length
    ? `<p class="note">${int(gone.length)} models removed. ${Object.entries(gone.reduce((a, r) => { const k = r[ix('kind')] || 'removed'; a[k] = (a[k] || 0) + 1; return a; }, {})).map(([k, n]) => `${esc(REMOVAL_KIND[k]?.label || k)}: ${int(n)}`).join(' · ')}</p>
      <ul class="plain">${gone.slice(0, 8).map((r) => `<li>${modelLink(r[0], { short: true })} <span class="note">removed ${esc(date(r[ix('removed_at')]))} · ${compact(r[ix('downloads')])} downloads before</span></li>`).join('')}</ul>`
    : '<p class="note">None of its tracked models has been removed.</p>';
  return card({ title: 'Removed models', sub: 'Models of this publisher that disappeared from the Hub', body });
}

async function familyExtras(name) {
  const out = [];
  try {
    const T = await load('trends.json');
    const f = T.families?.[name];
    if (f) {
      const totals = T.totals.map((t) => t.downloads || 1);
      out.push(card({
        span: 12, title: 'Share of all downloads over time', sub: 'Among the models tracked at each snapshot',
        body: lineChart(T.snapshots.map((s) => s.date), [{ label: name, values: f.downloads.map((v, i) => v / totals[i]) }],
          { time: true, xFmt: shortDate, tipTitle: (d) => date(d), fmt: pct, yLabel: 'Share of downloads', height: 200 }),
      }));
    }
  } catch (e) { /* optional */ }
  try {
    const idx = await load('families/index.json');
    const bases = idx.bases.filter((b) => b.family === name).slice(0, 10);
    if (bases.length) {
      out.push(card({
        title: 'Base models with the most derivatives', sub: 'Open one to explore its family tree',
        body: barList(bases.map((b) => ({ label: b.id, value: b.direct, href: b.tree != null ? `#families?tree=${encodeURIComponent(b.id)}` : `#model?id=${encodeURIComponent(b.id)}`, title: `${b.id}: ${int(b.direct)} direct derivatives` })), { fmt: int }),
      }));
    }
  } catch (e) { /* optional */ }
  return out;
}

