// Insights: quantizers, the first builds after new releases, copies of lab models and
// model-card completeness (data/insights.json, built by pipeline/hfo/insights.py).

import { load } from '../data.js';
import { barList, card, tableHtml } from '../charts.js';
import { term } from '../glossary.js';
import { pageHeader, sectionTitle } from '../ui.js';
import { compact, date, esc, int, modelLink, orgHref, pct } from '../format.js';

const hours = (h) => (h == null ? '–' : h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(h < 240 ? 1 : 0)} days`);

export async function render(section) {
  const d = await load('insights.json');
  const q = d.quantizers;
  const gguf = d.formats.find((f) => f.format === 'GGUF');
  const fastest = [...q].filter((x) => x.median_hours != null && x.timed >= 5).sort((a, b) => a.median_hours - b.median_hours)[0];
  const outranked = d.copies.filter((c) => c.copy_outranks);

  section.replaceChildren(pageHeader({
    id: 'h-insights', eyebrow: 'Insights', title: 'How the ecosystem really works',
    lead: `Who turns new models into versions you can run at home, how fast, which names get copied, and which publishers document their models.`,
    takeaways: [
      { value: int(d.quantizations), text: `live ${term('quantization', 'quantizations')} declare the model they compress${gguf ? `; ${pct(gguf.models / d.quantizations)} of them are ${term('gguf', 'GGUF')}` : ''}` },
      { value: q[0] ? esc(q[0].author) : '–', text: q[0] ? `publishes the most quantizations (${int(q[0].models)})` : '' },
      { value: fastest ? hours(fastest.median_hours) : '–', text: fastest ? `is how long <strong>${esc(fastest.author)}</strong> typically takes to publish a build after a new base model appears, the fastest of the big quantizers` : '' },
      { value: int(d.copies_official), text: `model names from original labs also live under other accounts${outranked.length ? `; in ${int(outranked.length)} cases a copy is downloaded more than the original` : ''}` },
    ],
    howTo: [
      'Quantizations are counted when a model card declares <code>base_model:quantized:…</code>. Format is read from the files and the name.',
      `Times are from the base model's creation to the build's creation, only for bases created after tracking began (${esc(date(d.tracking_start))}), so both dates are known.`,
      'A copy shares the exact repository name with a model from an original lab. Mirrors and format conversions are legitimate; check the publisher before you download.',
    ],
  }));

  const grid = document.createElement('div');
  grid.className = 'grid';
  section.append(grid);

  grid.append(sectionTitle('Who quantizes', 'The publishers that make new models runnable on smaller hardware'));
  grid.append(card({
    span: 12, title: 'Most active quantizers', sub: 'Live quantizations published, main formats and typical delay after the base model',
    body: `<div class="table-wrap">${tableHtml([
      { key: 'author', label: 'Publisher', html: (v) => `<a href="${esc(orgHref(v))}">${esc(v)}</a>` },
      { key: 'models', label: 'Quantizations', num: true, fmt: int },
      { key: 'formats', label: 'Formats', fmt: (v) => Object.entries(v).slice(0, 3).map(([f, n]) => `${f} ${int(n)}`).join(' · ') },
      { key: 'downloads', label: 'Downloads (30d)', num: true, fmt: compact },
      { key: 'median_hours', label: 'Typical delay', num: true, fmt: (v, r) => (v == null ? '–' : `${hours(v)} (${int(r.timed)} timed)`) },
    ], q, 'Most active quantizers')}</div>`,
  }));
  grid.append(card({
    title: 'Formats', sub: 'All live quantizations by format',
    body: barList(d.formats.map((f) => ({ label: f.format, value: f.models })), { fmt: int }),
  }));

  const rel = document.createElement('div');
  rel.innerHTML = d.releases.length ? `<ul class="alt-list">${d.releases.map((r) => `<li><span class="name">${modelLink(r.base)}
      <small>${esc(date(r.created))} · ${int(r.quantizations)} quantizations · first: ${Object.entries(r.firsts).slice(0, 4).map(([f, x]) => `${esc(f)} after ${hours(x.hours)}`).join(', ')}</small></span></li>`).join('')}</ul>`
    : '<p class="note">No recent base model has three or more quantizations yet.</p>';
  grid.append(card({ title: 'First builds after new releases', sub: 'Recent base models with the most downloads: how soon each format appeared', body: rel }));

  grid.append(sectionTitle('Copies and look-alikes', 'The same repository name under many accounts'));
  grid.append(card({
    span: 12, title: 'Most copied lab models',
    sub: `${int(d.copies_total)} names live under three or more accounts; ${int(d.copies_official)} belong to an original lab. Downloads are the last 30 days.`,
    body: `<div class="table-wrap">${tableHtml([
      { key: 'lead', label: 'Original', html: (v, r) => (r.official ? modelLink(r.official) : `${modelLink(v)} <span class="note">(no lab account)</span>`) },
      { key: 'lead_dl', label: 'Its downloads', num: true, fmt: compact },
      { key: 'copies', label: 'Copies', num: true, fmt: int },
      { key: 'copies_dl', label: 'Copies’ downloads', num: true, fmt: compact },
      { key: 'top_copies', label: 'Most downloaded copies', html: (v, r) => v.slice(0, 2).map(([id, dl]) => `${modelLink(id)} <span class="note">${compact(dl)}</span>`).join('<br>') + (r.copy_outranks ? '<br><strong class="warn-text">A copy outranks the original</strong>' : '') },
    ], d.copies, 'Most copied lab models')}</div>`,
  }));

  grid.append(sectionTitle('Model-card completeness', 'How well the most downloaded publishers document their models'));
  grid.append(card({
    span: 12, title: 'What their cards declare', sub: 'Share of each publisher’s live models (low-signal uploads left out) whose card states each item; “base model” only counts derived models',
    body: `<div class="table-wrap">${tableHtml([
      { key: 'author', label: 'Publisher', html: (v) => `<a href="${esc(orgHref(v))}">${esc(v)}</a>` },
      { key: 'models', label: 'Models', num: true, fmt: int },
      { key: 'task', label: 'Task', num: true, fmt: pct },
      { key: 'license', label: 'License', num: true, fmt: pct },
      { key: 'languages', label: 'Languages', num: true, fmt: pct },
      { key: 'base', label: 'Base model', num: true, fmt: (v) => (v == null ? '–' : pct(v)) },
      { key: 'results', label: 'Results', num: true, fmt: pct },
      { key: 'score', label: 'Overall', num: true, fmt: pct },
    ], d.cards, 'Model-card completeness')}</div>`,
  }));
}
