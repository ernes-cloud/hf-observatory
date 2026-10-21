import { load } from '../data.js';
import { barList, card, columnChart, shareBar, stats } from '../charts.js';
import { authorUrl, compact, date, esc, FORMAT_LABEL, hfUrl, int, language, LICENSE_FAMILY, pct, shortDate, task } from '../format.js';

const LF_COLOR = { oss: 'var(--series-1)', unknown: 'var(--axis)', 'non-commercial': 'var(--series-2)' };

/** A card whose bar list can switch between "models" and "downloads". */
function metricCard({ title, sub, span = 6, items, labelOf, hrefOf, defaultMetric = 'models', limit = 12, table }) {
  const actions = `<div class="segmented" role="group" aria-label="Metric">
    <button type="button" data-m="models" aria-pressed="${defaultMetric === 'models'}">Models</button>
    <button type="button" data-m="downloads" aria-pressed="${defaultMetric === 'downloads'}">Downloads</button></div>`;
  const body = document.createElement('div');
  const draw = (metric) => {
    const sorted = [...items].sort((a, b) => (b[metric] || 0) - (a[metric] || 0)).slice(0, limit);
    body.replaceChildren(barList(sorted.map((d) => ({
      label: labelOf(d), value: d[metric] || 0, href: hrefOf?.(d), external: true,
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
  section.innerHTML = `
    <div class="view-head">
      <h1 id="h-overview">The Hugging Face ecosystem at a glance</h1>
      <p>A snapshot of every model tracked by the radar as of <strong>${esc(date(d.meta.snapshot_at))}</strong>:
      who publishes, under which licenses, at which sizes and in which formats. Download counts are the
      last 30 days, as reported by the Hub.</p>
    </div>`;

  section.append(stats([
    { label: 'Live models', value: int(t.live), sub: `${int(t.tracked)} tracked in total`, hero: true },
    { label: 'Removed from the Hub', value: int(t.removed), sub: `${pct(t.removed / t.tracked)} of all tracked` },
    { label: 'Gated (live)', value: int(t.gated), sub: `${pct(t.gated / t.live)} require access approval` },
    { label: 'Open license', value: pct(t.open_license / t.live), sub: `${int(t.open_license)} live models allow commercial use` },
    { label: 'Publishers', value: int(t.authors), sub: 'organizations and users with live models' },
    { label: 'Downloads, last 30 days', value: compact(t.downloads_30d), sub: `${int(t.created_7d)} models created in the last 7 days` },
  ]));

  const grid = document.createElement('div');
  grid.className = 'grid';
  section.append(grid);

  grid.append(metricCard({
    title: 'Top publishers', sub: 'Organizations and users, by number of live models or by 30-day downloads',
    items: mergeOrgs(d.top_orgs_by_count, d.top_orgs_by_downloads), labelOf: (o) => o.author, hrefOf: (o) => authorUrl(o.author),
    defaultMetric: 'downloads', limit: 15,
  }));

  grid.append(metricCard({
    title: 'Tasks', sub: 'Main pipeline tag declared on the model card',
    items: d.tasks, labelOf: (x) => task(x.task), limit: 15,
  }));

  // Licenses: part-to-whole + raw licenses
  const licBody = document.createElement('div');
  licBody.append(shareBar(d.license_families.map((f) => ({ label: LICENSE_FAMILY[f.family]?.label || f.family, value: f.models, color: LF_COLOR[f.family] }))));
  const h = document.createElement('h3');
  h.textContent = 'Most common declared licenses';
  h.style.margin = '16px 0 8px';
  licBody.append(h, barList(d.licenses.slice(0, 10).map((l) => ({ label: l.license, value: l.models }))));
  grid.append(card({
    title: 'Licenses', sub: 'Classified by the dataset as open (commercial use allowed), non-commercial or unclear', body: licBody,
    table: { columns: [{ key: 'license', label: 'License' }, { key: 'family', label: 'Class', fmt: (v) => LICENSE_FAMILY[v]?.label || v }, { key: 'models', label: 'Models', num: true, fmt: int }], rows: d.licenses },
  }));

  grid.append(metricCard({
    title: 'Model sizes', sub: 'Parameter count (from safetensors or GGUF metadata)', items: d.sizes.map((s) => ({ ...s })),
    labelOf: (s) => s.bucket, limit: 20,
  }));
  // keep size buckets in their natural order
  const sizeCard = grid.lastElementChild;
  sizeCard.querySelectorAll('.segmented button').forEach((b) => b.addEventListener('click', () => orderSizes(sizeCard, d.sizes, b.dataset.m)));
  orderSizes(sizeCard, d.sizes, 'models');

  grid.append(metricCard({
    title: 'Distribution formats', sub: `A model can ship in several formats. ${int(d.no_format)} live models have none detected.`,
    items: d.formats, labelOf: (f) => FORMAT_LABEL[f.format] || f.format,
  }));

  grid.append(card({
    title: 'Languages', sub: `Declared on the model card (top 20). ${int(d.no_language)} live models declare none.`,
    body: barList(d.languages.map((l) => ({ label: language(l.lang), value: l.models }))),
    table: { columns: [{ key: 'lang', label: 'Code' }, { key: 'name', label: 'Language' }, { key: 'models', label: 'Models', num: true, fmt: int }], rows: d.languages.map((l) => ({ ...l, name: language(l.lang) })) },
  }));

  grid.append(metricCard({
    title: 'Model families', sub: 'Detected from the model name and its declared base model', items: d.families,
    labelOf: (f) => f.family, defaultMetric: 'downloads', limit: 15,
  }));

  grid.append(card({
    title: 'Most downloaded models', sub: 'Last 30 days',
    body: barList(d.top_models.map((m) => ({ label: m.id, value: m.downloads, href: hfUrl(m.id), external: true, title: `${m.id} · ${task(m.task)} · ${int(m.downloads)} downloads` }))),
    table: { columns: [{ key: 'id', label: 'Model' }, { key: 'task', label: 'Task', fmt: task }, { key: 'downloads', label: 'Downloads (30d)', num: true, fmt: int }, { key: 'likes', label: 'Likes', num: true, fmt: int }], rows: d.top_models },
  }));

  const weeks = d.created_per_week;
  grid.append(card({
    span: 12, title: 'Models created per week',
    sub: 'By creation date on the Hub, for models tracked by the radar. Older weeks are under-represented because the radar only started tracking in August 2026.',
    body: columnChart(weeks.map((w) => ({ x: w.week, values: [w.models - w.removed, w.removed] })), {
      series: [{ label: 'Still live' }, { label: 'Since removed' }], xFmt: shortDate, tipTitle: (w) => `Week of ${date(w.x)}`,
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
