import { load } from '../data.js';
import { barList, card, columnChart, shareBar, stats, tableHtml } from '../charts.js';
import { authorUrl, compact, date, days, esc, int, LICENSE_FAMILY, params as fmtParams, pct, shortDate, task } from '../format.js';

const LF_COLOR = { oss: 'var(--series-1)', unknown: 'var(--axis)', 'non-commercial': 'var(--series-2)' };
const PAGE = 50;

export async function render(section) {
  const g = await load('graveyard.json');
  const t = g.totals;
  section.innerHTML = `
    <div class="view-head">
      <h1 id="h-graveyard">The graveyard</h1>
      <p>The Hub never announces removals. The radar re-checks every model it tracks and flags those that start
      returning a real 404. Since ${esc(date(t.first_detected))} it has caught <strong>${int(t.removed)}</strong> removals.
      Below: who removes the most, how long models lived, and whether they were gated or had unclear licenses.</p>
    </div>`;

  section.append(stats([
    { label: 'Removed models', value: int(t.removed), sub: `${pct(t.removed / t.tracked)} of everything tracked`, hero: true },
    { label: 'Median lifespan', value: days(t.median_lifespan_days), sub: 'from creation on the Hub to detected removal' },
    { label: 'Had real traction', value: int(t.removed_with_traction), sub: 'removed with ≥ 1,000 downloads in their last 30 days' },
    { label: 'Gated', value: pct(t.gated_share_removed), sub: `of removed models, vs ${pct(t.gated_share_live)} of live ones` },
    { label: 'Unclear license', value: pct(t.unclear_share_removed), sub: `of removed models, vs ${pct(t.unclear_share_live)} of live ones` },
  ]));

  const grid = document.createElement('div');
  grid.className = 'grid';
  section.append(grid);

  grid.append(card({
    title: 'Who removes the most', sub: 'Publishers by number of removed models (bar) and share of their tracked models',
    body: barList(g.by_author.map((a) => ({
      label: a.author, value: a.removed, href: authorUrl(a.author), external: true,
      display: `${int(a.removed)} · ${pct(a.removed / a.tracked)}`,
      title: `${a.author}: ${int(a.removed)} of ${int(a.tracked)} tracked models removed`,
    }))),
    table: { columns: [{ key: 'author', label: 'Publisher' }, { key: 'removed', label: 'Removed', num: true, fmt: int }, { key: 'tracked', label: 'Tracked', num: true, fmt: int }, { key: 'downloads', label: 'Downloads before removal', num: true, fmt: int }], rows: g.by_author },
  }));

  grid.append(card({
    title: 'How long they lived', sub: 'Time between creation on the Hub and detected removal',
    body: barList(g.lifespan.map((l) => ({ label: l.bucket, value: l.models, display: `${int(l.models)} · ${pct(l.models / t.removed)}` }))),
    table: { columns: [{ key: 'bucket', label: 'Lifespan' }, { key: 'models', label: 'Models', num: true, fmt: int }], rows: g.lifespan },
  }));

  grid.append(card({
    span: 12, title: 'Removals detected per week',
    sub: 'By the date the radar first saw the 404. The first weeks include a backlog of earlier removals.',
    body: columnChart(g.per_week.map((w) => ({ x: w.week, values: [w.models - w.gated, w.gated] })), {
      series: [{ label: 'Public' }, { label: 'Gated' }], xFmt: shortDate, tipTitle: (w) => `Week of ${date(w.x)}`, height: 200,
    }),
    table: { columns: [{ key: 'week', label: 'Week of', fmt: date }, { key: 'models', label: 'Removed', num: true, fmt: int }, { key: 'gated', label: 'of which gated', num: true, fmt: int }], rows: g.per_week },
  }));

  const licBody = document.createElement('div');
  const famOrder = ['oss', 'unknown', 'non-commercial'];
  const lic = Object.fromEntries(g.license.map((l) => [l.family, l]));
  for (const [key, label] of [['removed', 'Removed models'], ['live', 'Live models']]) {
    const h = document.createElement('h3');
    h.textContent = label;
    h.style.margin = '6px 0';
    licBody.append(h, shareBar(famOrder.filter((f) => lic[f]).map((f) => ({ label: LICENSE_FAMILY[f].label, value: lic[f][key], color: LF_COLOR[f] }))));
  }
  grid.append(card({
    title: 'Licenses: removed vs live', sub: 'Removed models are more likely to have no clear license', body: licBody,
    table: { columns: [{ key: 'family', label: 'License class', fmt: (v) => LICENSE_FAMILY[v]?.label || v }, { key: 'removed', label: 'Removed', num: true, fmt: int }, { key: 'live', label: 'Live', num: true, fmt: int }], rows: g.license },
  }));

  grid.append(card({
    title: 'Removals by task', sub: 'Removed models per task, with the removal rate',
    body: barList(g.by_task.map((x) => ({ label: task(x.task), value: x.removed, display: `${int(x.removed)} · ${pct(x.removed / x.tracked)}` }))),
    table: { columns: [{ key: 'task', label: 'Task', fmt: task }, { key: 'removed', label: 'Removed', num: true, fmt: int }, { key: 'tracked', label: 'Tracked', num: true, fmt: int }], rows: g.by_task },
  }));

  // Full, searchable list
  const cols = g.models.columns;
  const all = g.models.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  const list = document.createElement('article');
  list.className = 'card span-12';
  list.innerHTML = `
    <div class="card-head"><div><h2>Every removed model</h2><p class="sub">Downloads and likes are the last values seen before removal. Links are gone, so models are not linked.</p></div></div>
    <div class="filters" style="margin-bottom:10px">
      <div class="field"><label for="g-q">Search</label><input type="search" id="g-q" placeholder="Model or publisher" autocomplete="off"></div>
      <div class="field"><label for="g-sort">Sort by</label><select id="g-sort">
        <option value="downloads">Downloads before removal</option><option value="removed_at">Most recently removed</option>
        <option value="lifespan_desc">Longest lived</option><option value="lifespan">Shortest lived</option><option value="likes">Likes</option></select></div>
      <div class="field checks" style="align-self:end"><label><input type="checkbox" id="g-gated"> Gated only</label><label><input type="checkbox" id="g-unclear"> Unclear license only</label></div>
    </div>
    <p class="result-count" id="g-count" role="status" aria-live="polite"></p>
    <div class="table-wrap" id="g-table"></div>
    <div class="more-row"><button type="button" class="btn" id="g-more">Show more</button></div>`;
  grid.append(list);

  const q = list.querySelector('#g-q'), sort = list.querySelector('#g-sort'), gated = list.querySelector('#g-gated'), unclear = list.querySelector('#g-unclear');
  const tableEl = list.querySelector('#g-table'), countEl = list.querySelector('#g-count'), more = list.querySelector('#g-more');
  let shown = PAGE, filtered = all;
  const columns = [
    { key: 'id', label: 'Model', html: (v) => `<span class="id">${esc(v)}</span>` },
    { key: 'task', label: 'Task', fmt: (v) => (v ? task(v) : '–') },
    { key: 'params', label: 'Size', num: true, fmt: (v) => fmtParams(v) || '–' },
    { key: 'lf', label: 'License', fmt: (v, r) => r.license || LICENSE_FAMILY[v]?.label },
    { key: 'gated', label: 'Gated', fmt: (v) => (v ? 'Yes' : '') },
    { key: 'created', label: 'Created', num: true, fmt: date },
    { key: 'removed_at', label: 'Removed', num: true, fmt: date },
    { key: 'lifespan', label: 'Lived', num: true, fmt: days },
    { key: 'downloads', label: 'Downloads', num: true, fmt: compact },
  ];
  const draw = () => {
    countEl.textContent = `${int(filtered.length)} removed model${filtered.length === 1 ? '' : 's'}`;
    tableEl.innerHTML = tableHtml(columns, filtered.slice(0, shown), 'Removed models');
    more.hidden = filtered.length <= shown;
  };
  const apply = () => {
    const terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = all.filter((m) => (!gated.checked || m.gated) && (!unclear.checked || m.lf === 'unknown')
      && terms.every((t) => m.id.toLowerCase().includes(t)));
    const s = sort.value;
    const key = {
      downloads: (m) => -m.downloads, likes: (m) => -m.likes, removed_at: (m) => -Date.parse(m.removed_at || 0),
      lifespan: (m) => m.lifespan ?? Infinity, lifespan_desc: (m) => -(m.lifespan ?? -1),
    }[s];
    filtered = filtered.map((m) => [key(m), m]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    shown = PAGE;
    draw();
  };
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 150); });
  [sort, gated, unclear].forEach((x) => x.addEventListener('change', apply));
  more.addEventListener('click', () => { shown += PAGE; draw(); });
  apply();
}
