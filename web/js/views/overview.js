import { load } from '../data.js';
import { barList, card, columnChart, shareBar } from '../charts.js';
import { term } from '../glossary.js';
import { coverageNote, pageHeader, sectionTitle } from '../ui.js';
import { compact, date, esc, familyHref, finderHref, FORMAT_LABEL, int, language, modelHref, orgHref, LF_COLOR, LF_ORDER, LICENSE_FAMILY, pct, shortDate, task } from '../format.js';

/** A card whose bar list can switch between "models" and "downloads". */
function metricCard({ title, sub, span = 6, items, labelOf, hrefOf, defaultMetric = 'models', limit = 12, table }) {
  const actions = `<div class="segmented" role="group" aria-label="Metric">
    <button type="button" data-m="models" aria-pressed="${defaultMetric === 'models'}">Models</button>
    <button type="button" data-m="downloads" aria-pressed="${defaultMetric === 'downloads'}">Downloads</button></div>`;
  const body = document.createElement('div');
  const draw = (metric) => {
    const sorted = [...items].sort((a, b) => (b[metric] || 0) - (a[metric] || 0)).slice(0, limit);
    body.replaceChildren(barList(sorted.map((d) => ({
      label: labelOf(d), value: d[metric] || 0, href: hrefOf?.(d),
      title: `${labelOf(d)}: ${int(d.models)} models · ${int(d.downloads)} downloads (30 days)`,
    })), {}));
  };
  const c = card({ title, sub, span, body, actions, table: table || {
    columns: [{ key: 'label', label: 'Name' }, { key: 'models', label: 'Models', num: true, fmt: int }, { key: 'downloads', label: 'Downloads (30d)', num: true, fmt: int }],
    rows: items.map((d) => ({ ...d, label: labelOf(d) })),
  } });
  c.querySelectorAll('.segmented button').forEach((b) => b.addEventListener('click', () => {
    c.querySelectorAll('.segmented button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw(b.dataset.m);
  }));
  draw(defaultMetric);
  return c;
}

export async function render(section) {
  const d = await load('overview.json');
  const t = d.totals;
  const topPub = d.top_orgs_by_downloads[0];
  const known = d.sizes.filter((s) => s.bucket !== 'Unknown');
  const knownTotal = known.reduce((a, s) => a + s.models, 0) || 1;
  const small = known.filter((s) => s.bucket === '< 1B' || s.bucket === '1–4B').reduce((a, s) => a + s.models, 0);
  const tasksNamed = d.tasks.filter((x) => x.task !== 'unspecified');
  const unspecified = d.tasks.find((x) => x.task === 'unspecified');

  section.replaceChildren(pageHeader({
    id: 'h-overview', eyebrow: 'Overview', title: 'The ecosystem at a glance',
    lead: `Who publishes AI models on Hugging Face, what they are for, how big they are and under which terms you can use them.
      Snapshot of ${esc(date(d.meta.snapshot_at))}; ${term('downloads', 'downloads')} cover the last 30 days.`,
    note: coverageNote(d.meta, { noise: t.noise }),
    takeaways: [
      { value: int(t.live), text: `live ${term('model', 'models')} from ${int(t.authors)} ${term('publisher', 'publishers')}; ${int(t.created_7d)} were created in the last week and ${int(t.removed)} have been deleted so far` },
      { value: topPub ? pct(topPub.downloads / t.downloads_30d) : '–', text: topPub ? `of all downloads go to <strong>${esc(topPub.author)}</strong>, the most downloaded publisher` : '' },
      { value: pct(t.open_license / t.live), text: `of live models have an open-source ${term('license', 'license')} that allows commercial use; another ${pct((t.conditional_license || 0) / t.live)} use custom terms such as Llama, Gemma or OpenRAIL` },
      { value: pct(small / knownTotal), text: `of models with a known size have under 4B ${term('parameters', 'parameters')}: small enough for a laptop` },
    ],
    howTo: [
      'Each card answers one question. The <strong>Models / Downloads</strong> switch ranks either by how many models exist or by how much they are actually used.',
      '<strong>Table</strong> shows the exact numbers behind a chart. Hover or tap a bar for details.',
      `Underlined words such as ${term('gguf', 'GGUF')} or ${term('gated', 'gated')} show a definition when you hover or tap them.`,
    ],
  }));



  const grid = document.createElement('div');
  grid.className = 'grid';
  section.append(grid);

  grid.append(sectionTitle('Who builds and who gets used', 'The organizations behind the most used models'));
  grid.append(metricCard({
    title: 'Top publishers', sub: 'Ranked by monthly downloads, or by models that people use (100+ downloads or 3+ likes): experiment dumps would lead a raw count',
    items: mergeOrgs(d.top_orgs_by_count, d.top_orgs_by_downloads), labelOf: (o) => o.author, hrefOf: (o) => orgHref(o.author),
    defaultMetric: 'downloads', limit: 15,
  }));
  grid.append(card({
    title: 'Most downloaded models', sub: 'Last 30 days. Click a name to open its page.',
    body: barList(d.top_models.map((m) => ({ label: m.id, value: m.downloads, href: modelHref(m.id), title: `${m.id} · ${task(m.task)} · ${int(m.downloads)} downloads` }))),
    table: { columns: [{ key: 'id', label: 'Model' }, { key: 'task', label: 'Task', fmt: task }, { key: 'downloads', label: 'Downloads (30d)', num: true, fmt: int }, { key: 'likes', label: 'Likes', num: true, fmt: int }], rows: d.top_models },
  }));

  grid.append(sectionTitle('What the models are for', 'Tasks and model families'));
  grid.append(metricCard({
    title: 'Tasks', sub: `What each model is built to do.${unspecified ? ` ${int(unspecified.models)} models declare no task and are left out.` : ''}`,
    items: tasksNamed, labelOf: (x) => task(x.task), hrefOf: (x) => finderHref({ task: x.task }), limit: 15,
    table: { columns: [{ key: 'label', label: 'Task' }, { key: 'models', label: 'Models', num: true, fmt: int }, { key: 'downloads', label: 'Downloads (30d)', num: true, fmt: int }], rows: d.tasks.map((x) => ({ ...x, label: task(x.task) })) },
  }));
  grid.append(metricCard({
    title: 'Model families', sub: 'Groups of related models (Qwen, Llama, Gemma…), detected from names and base models. BERT-style are small text-embedding models used for search.', items: d.families,
    labelOf: (f) => f.family, hrefOf: (f) => familyHref(f.family), defaultMetric: 'downloads', limit: 15,
  }));

  grid.append(sectionTitle('Size, format and terms of use', 'What you need to run a model and whether you may use it commercially'));
  grid.append(metricCard({
    title: 'Model sizes', sub: 'Number of parameters. Under 4B runs on most laptops; 30B+ needs a large GPU.', items: d.sizes.map((s) => ({ ...s })),
    labelOf: (s) => s.bucket, limit: 20,
  }));
  // keep size buckets in their natural order
  const sizeCard = grid.lastElementChild;
  sizeCard.querySelectorAll('.segmented button').forEach((b) => b.addEventListener('click', () => orderSizes(sizeCard, d.sizes, b.dataset.m)));
  orderSizes(sizeCard, d.sizes, 'models');

  grid.append(metricCard({
    title: 'File formats', sub: `GGUF and MLX are for running models on your own computer; safetensors is the standard format. ${int(d.no_format)} models have none detected.`,
    items: d.formats, labelOf: (f) => FORMAT_LABEL[f.format] || f.format, hrefOf: (f) => finderHref({ fmt: f.format }),
  }));

  // Licenses: part-to-whole + raw licenses
  const licBody = document.createElement('div');
  const lfs = [...d.license_families].sort((a, b) => LF_ORDER.indexOf(a.family) - LF_ORDER.indexOf(b.family));
  licBody.append(shareBar(lfs.map((f) => ({ label: LICENSE_FAMILY[f.family]?.label || f.family, value: f.models, color: LF_COLOR[f.family] }))));
  const h = document.createElement('h3');
  h.textContent = 'Most common licenses';
  h.style.margin = '16px 0 8px';
  licBody.append(h, barList(d.licenses.slice(0, 10).map((l) => ({ label: l.license, value: l.models }))));
  grid.append(card({
    title: 'Licenses', sub: 'Open source allows commercial use. “Open with conditions” are custom licenses (Llama, Gemma, OpenRAIL…) that usually allow it with conditions: read them. “Not declared” means missing or ambiguous terms.', body: licBody,
    table: { columns: [{ key: 'license', label: 'License' }, { key: 'family', label: 'Class', fmt: (v) => LICENSE_FAMILY[v]?.label || v }, { key: 'models', label: 'Models', num: true, fmt: int }], rows: d.licenses },
  }));

  grid.append(card({
    title: 'Languages', sub: `Languages declared by the author (top 20). ${int(d.no_language)} models declare none.`,
    body: barList(d.languages.map((l) => ({ label: language(l.lang), value: l.models, href: finderHref({ lang: l.lang }) }))),
    table: { columns: [{ key: 'lang', label: 'Code' }, { key: 'name', label: 'Language' }, { key: 'models', label: 'Models', num: true, fmt: int }], rows: d.languages.map((l) => ({ ...l, name: language(l.lang) })) },
  }));

  grid.append(sectionTitle('Activity over time'));
  const weeks = d.created_per_week;
  grid.append(card({
    span: 12, title: 'New models per week',
    sub: `By the date each model was created on Hugging Face, from the week tracking began. Older models are left out: the radar only holds the few it picked up later.`,
    body: columnChart(weeks.map((w) => ({ x: w.week, values: [w.models - w.removed, w.removed] })), {
      series: [{ label: 'Still online' }, { label: 'Since removed' }], xFmt: shortDate, tipTitle: (w) => `Week of ${date(w.x)}`,
    }),
    table: { columns: [{ key: 'week', label: 'Week of', fmt: date }, { key: 'models', label: 'Created', num: true, fmt: int }, { key: 'removed', label: 'Since removed', num: true, fmt: int }], rows: weeks },
  }));
}

function orderSizes(cardEl, sizes, metric) {
  const body = cardEl.querySelector('.card-body');
  body.replaceChildren(barList(sizes.map((s) => ({ label: s.bucket, value: s[metric], title: `${s.bucket}: ${int(s.models)} models · ${int(s.downloads)} downloads` })), {}));
}

function mergeOrgs(a, b) {
  const map = new Map();
  [...a, ...b].forEach((o) => map.set(o.author, o));
  return [...map.values()];
}
