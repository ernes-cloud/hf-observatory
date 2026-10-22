// One model: what it is, how its downloads moved, where it sits in its family,
// what it scored on its own card, and what else does the same job.

import { load } from '../data.js';
import { card, lineChart, stats, tableHtml } from '../charts.js';
import { term } from '../glossary.js';
import { bindCompareButtons, compareButton, loadFinder, loadModel } from '../models.js';
import {
  compact, date, esc, familyHref, finderHref, FORMAT_LABEL, gigabytes, hfUrl, int, language, LICENSE_FAMILY,
  modelLink, orgHref, params as fmtParams, REMOVAL_KIND, shortDate, task,
} from '../format.js';

const REL_LABEL = { finetune: 'fine-tunes', quantized: 'quantizations', adapter: 'adapters', merge: 'merges', derivative: 'other derivatives' };
const REL_ONE = { finetune: 'fine-tune', quantized: 'quantization', adapter: 'adapter', merge: 'merge', derivative: 'derivative' };

export async function render(section, params) {
  const id = (params.get('id') || '').trim();
  if (!id) {
    section.innerHTML = '<div class="empty">No model selected. <a href="#finder">Search for one →</a></div>';
    return;
  }
  section.innerHTML = '<p class="loading" role="status">Loading…</p>';
  const { rec: m, dates } = await loadModel(id);
  if (!m) {
    section.innerHTML = `<div class="page-head"><p class="eyebrow">Model</p><h1 id="h-model">${esc(id)}</h1></div>
      <div class="empty">This model is not in the dataset: the radar tracks a curated selection of the Hub, not every repository.
      <a href="${esc(hfUrl(id))}" rel="noopener">Open it on Hugging Face ↗</a> or <a href="${esc(finderHref({ q: id }))}">search similar names</a>.</div>`;
    return;
  }
  document.title = `${m.id} · HF Observatory`;
  const [author, ...rest] = m.id.split('/');
  const lf = LICENSE_FAMILY[m.lf] || LICENSE_FAMILY.unknown;
  const flags = new Set(m.fl || []);
  const p = fmtParams(m.p ? m.p / 1e6 : null);
  const chips = [
    m.t ? `<a class="chip" href="${esc(finderHref({ task: m.t }))}">${esc(task(m.t))}</a>` : '',
    p ? `<span class="chip">${p} params</span>` : '',
    m.mem ? `<span class="chip" title="Estimated memory to load the weights">≈ ${gigabytes(m.mem)}</span>` : '',
    `<span class="chip ${m.lf === 'oss' ? 'ok' : m.lf === 'non-commercial' ? 'nc' : ''}" title="${esc(lf.long)}">${esc(lf.short)}</span>`,
    ...m.fmt.map((f) => `<span class="chip">${esc(FORMAT_LABEL[f] || f)}</span>`),
    flags.has('gated') ? '<span class="chip gated">Gated</span>' : '',
    flags.has('noise') ? '<span class="chip" title="Experiment checkpoint, course exercise, test repo or an upload with no downloads or likes after a week">Low signal</span>' : '',
    m.rm ? '<span class="chip nc">Removed</span>' : '',
  ].filter(Boolean).join('');

  section.innerHTML = `
    <header class="page-head model-head">
      <p class="eyebrow">${m.rm ? 'Removed model' : 'Model'}${m.fam ? ` · <a href="${esc(familyHref(m.fam))}">${esc(m.fam)} family</a>` : ''}</p>
      <h1 id="h-model"><span class="author"><a href="${esc(orgHref(author))}">${esc(author)}</a>/</span>${esc(rest.join('/'))}</h1>
      <div class="chips">${chips}</div>
      <p class="lead">${esc(describe(m))}</p>
      <div class="hero-actions">
        ${m.rm ? '' : `<a class="btn btn-primary" href="${esc(hfUrl(m.id))}" rel="noopener">Open on Hugging Face ↗</a>`}
        ${compareButton(m.id)}
        <a class="btn btn-ghost" href="#advisor">What runs on my hardware?</a>
      </div>
      ${m.rm ? removedNote(m) : ''}
    </header>`;
  bindCompareButtons(section);

  section.append(stats([
    { label: 'Downloads, last 30 days', value: compact(m.dl), sub: m.dl ? `${int(m.dl)} downloads` : 'none recorded', hero: true },
    { label: 'Likes', value: int(m.lk), sub: m.tr ? `trending score ${compact(m.tr)}` : 'not trending' },
    { label: 'Created', value: date(m.c), sub: m.u ? `last updated ${date(m.u)}` : '' },
    { label: 'Size', value: p || '–', sub: m.mem ? `≈ ${gigabytes(m.mem)} to load the weights` : m.sb ? `${gigabytes(m.sb / 1e9)} of files` : 'not reported' },
  ]));

  const grid = document.createElement('div');
  grid.className = 'grid';
  section.append(grid);

  if (m.h && m.h.some((v) => v != null)) {
    grid.append(card({
      span: 12, title: 'Downloads over time',
      sub: `Rolling 30-day downloads at each ${term('snapshot', 'snapshot')} the radar took (weekly, then daily for the last two weeks).`,
      body: lineChart(dates, [{ label: m.id, values: m.h }], { time: true, xFmt: shortDate, tipTitle: (d) => date(d), yLabel: '30-day downloads', height: 220 }),
      table: { columns: [{ key: 'd', label: 'Snapshot', fmt: date }, { key: 'v', label: 'Downloads (30d)', num: true, fmt: int }], rows: dates.map((d, i) => ({ d, v: m.h[i] })).filter((r) => r.v != null) },
    }));
  }

  grid.append(familyCard(m));
  const bench = benchCard(m);
  if (bench) grid.append(bench);
  grid.append(detailsCard(m));

  const alt = card({ span: 12, title: 'Alternatives', sub: 'Live models for the same task and of a similar size, most downloaded first', body: '<p class="loading">Loading…</p>' });
  grid.append(alt);
  alternatives(m).then((html) => { alt.querySelector('.card-body').innerHTML = html; bindCompareButtons(alt); })
    .catch(() => { alt.querySelector('.card-body').innerHTML = '<p class="note">Could not load the model index.</p>'; });
}

export const update = render;

function describe(m) {
  const p = fmtParams(m.p ? m.p / 1e6 : null);
  const t = m.t ? task(m.t).toLowerCase() : null;
  let s = `A${p ? ` ${p}-parameter` : ''} ${t ? `${t} model` : m.lib ? `${m.lib} model` : 'model'}`;
  if (/^[aeiou8]/i.test(s.slice(2))) s = `An${s.slice(1)}`;
  s += ` published by ${m.id.split('/')[0]}`;
  if (m.par?.length) {
    const [base, rel] = m.par[0];
    s += m.par.length > 1 && rel === 'merge' ? `, merged from ${m.par.slice(0, 2).map((x) => x[0]).join(' and ')}` : `, a ${REL_ONE[rel] || 'derivative'} of ${base}`;
  }
  s += '.';
  if ((m.fl || []).includes('chat')) s += ' Tuned for chat and instructions.';
  if (m.lang?.length) s += ` Languages: ${m.lang.slice(0, 4).map(language).join(', ')}${m.lang.length > 4 ? ` and ${m.lang.length - 4} more` : ''}.`;
  if (m.lf === 'oss') s += ` Open-source license (${m.lic}): commercial use allowed.`;
  else if (m.lf === 'conditional') s += ` Custom license (${m.lic}): commercial use is usually allowed with conditions; read them first.`;
  else if (m.lf === 'non-commercial') s += ` Non-commercial license (${m.lic}).`;
  else s += ' License not clearly declared.';
  return s;
}

function removedNote(m) {
  const k = REMOVAL_KIND[m.rk] || REMOVAL_KIND.removed;
  return `<aside class="coverage removed-note"><strong>Removed from Hugging Face on ${esc(date(m.rm))}.</strong> ${esc(k.label)}: ${esc(k.long)}.
    ${m.sc ? `See ${modelLink(m.sc)}.` : ''} Figures below are the last ones seen. <a href="#graveyard">More removals →</a></aside>`;
}

function familyCard(m) {
  const parts = [];
  if (m.par?.length) {
    parts.push(`<h3 class="mini">Built on</h3><ul class="plain">${m.par.map(([id, rel]) => `<li>${modelLink(id)} <span class="note">(${esc(REL_ONE[rel] || rel)})</span></li>`).join('')}</ul>`);
  } else {
    parts.push('<p class="note">Declares no base model: trained from scratch, or the card does not say.</p>');
  }
  if (m.kids) {
    const total = Object.values(m.kids).reduce((a, b) => a + b, 0);
    parts.push(`<h3 class="mini">${int(total)} live models build on it</h3>
      <p class="note">${Object.entries(m.kids).map(([r, n]) => `${int(n)} ${REL_LABEL[r] || r}`).join(' · ')}</p>
      <ul class="plain">${(m.top || []).map(([id, rel, dl]) => `<li>${modelLink(id)} <span class="note">${esc(REL_ONE[rel] || rel)} · ${compact(dl)} downloads</span></li>`).join('')}</ul>
      <p><a href="#families?tree=${encodeURIComponent(m.id)}">Open its family tree →</a></p>`);
  }
  return card({ title: 'Family', sub: `Where it comes from and what was built on it (${term('basemodel', 'base model')} links declared on model cards)`, body: parts.join('') });
}

function benchCard(m) {
  if (!m.bm?.length) return null;
  const rows = m.bm.map(([t, ds, metric, v]) => ({ t, ds, metric, v }));
  return card({
    title: 'Results on its model card',
    sub: 'Self-reported by the uploader in the card’s model-index; not verified, and not comparable across different setups.',
    body: `<div class="table-wrap">${tableHtml([
      { key: 'ds', label: 'Benchmark' }, { key: 'metric', label: 'Metric' },
      { key: 'v', label: 'Value', num: true, fmt: (v) => (typeof v === 'number' ? (Math.abs(v) <= 1 ? v.toFixed(3) : compact(v)) : String(v)) },
    ], rows, 'Benchmarks reported on the model card')}</div>`,
  });
}

function detailsCard(m) {
  const rows = [
    ['Publisher', `<a href="${esc(orgHref(m.id.split('/')[0]))}">${esc(m.id.split('/')[0])}</a>`],
    ['Task', m.t ? esc(task(m.t)) : '–'],
    ['Library', m.lib ? esc(m.lib) : '–'],
    ['License', `${esc(m.lic || 'not declared')} <span class="note">(${esc((LICENSE_FAMILY[m.lf] || LICENSE_FAMILY.unknown).label)})</span>`],
    ['Formats', m.fmt.length ? m.fmt.map((f) => esc(FORMAT_LABEL[f] || f)).join(', ') : '–'],
    ['Languages', m.lang?.length ? esc(m.lang.map(language).join(', ')) : '–'],
    ['Parameters', m.p ? int(m.p) : '–'],
    ['Repository size', m.sb ? gigabytes(m.sb / 1e9) : '–'],
    ['Family', m.fam ? `<a href="${esc(familyHref(m.fam))}">${esc(m.fam)}</a>` : '–'],
  ];
  return card({ title: 'Details', body: `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` });
}

async function alternatives(m) {
  const D = await loadFinder();
  const c = D.cols;
  const t = m.t ? D.dict.task.indexOf(m.t) : -1;
  if (t < 0) return '<p class="note">No task declared, so no comparable models.</p>';
  const pm = m.p ? m.p / 1e6 : null;
  const self = m.id.toLowerCase();
  const out = [];
  for (let i = 0; i < D.n && out.length < 6; i++) { // rows are sorted by downloads
    if (c.task[i] !== t || D.idLower[i] === self || c.flags[i] & 8) continue;
    if (pm && c.params[i] && (c.params[i] < pm / 2.5 || c.params[i] > pm * 2.5)) continue;
    if (pm && !c.params[i]) continue;
    out.push(i);
  }
  if (!out.length) return '<p class="note">No comparable live model found.</p>';
  const more = finderHref({ task: m.t });
  return `<ul class="alt-list">${out.map((i) => `<li>
      <span class="name">${modelLink(c.id[i])}<small>${[fmtParams(c.params[i]), `${compact(c.dl[i])} downloads`, LICENSE_FAMILY[D.dict.license_family[c.lf[i]]]?.short].filter(Boolean).map(esc).join(' · ')}</small></span>
      ${compareButton(c.id[i])}</li>`).join('')}</ul>
    <p><a href="${esc(more)}">All ${esc(task(m.t).toLowerCase())} models in the finder →</a></p>`;
}

// Prefetch the index used by every model page.
load('models/index.json').catch(() => {});
