import { load } from '../data.js';
import { term } from '../glossary.js';
import { pageHeader } from '../ui.js';
import { card, hideTip, showTip, stackedBarList, stats } from '../charts.js';
import { compact, esc, familyHref, hfUrl, int, modelHref, params as fmtParams, pct, task } from '../format.js';

const REL = {
  finetune: { label: 'Fine-tunes', one: 'fine-tune', color: 'var(--series-1)' },
  quantized: { label: 'Quantizations', one: 'quantization', color: 'var(--series-2)' },
  adapter: { label: 'Adapters (LoRA…)', one: 'adapter', color: 'var(--series-7)' },
  merge: { label: 'Merges', one: 'merge', color: 'var(--series-3)' },
  derivative: { label: 'Other derivatives', one: 'derivative', color: 'var(--muted)' },
};
const SVG_NS = 'http://www.w3.org/2000/svg';

let index = null;
let explorer = null;

export async function render(section, params) {
  index = await load('families/index.json');
  const rels = index.relations;
  const series = rels.map((r) => ({ label: REL[r].label, color: REL[r].color }));
  const tot = index.totals;
  const topBase = index.bases[0];
  const topFam = index.families[0];
  const totalLinks = rels.reduce((a, r) => a + tot[r], 0) || 1;
  section.replaceChildren(pageHeader({
    id: 'h-families', eyebrow: 'Family trees', title: 'Who builds on whom',
    lead: `Most models on Hugging Face are not trained from scratch: they start from an existing ${term('basemodel', 'base model')} and adapt it.
      This page shows which base models have the most descendants and lets you explore each family tree.`,
    takeaways: [
      { value: pct(index.derived_models / index.live_models), text: 'of live models declare a base model they were built from' },
      { value: topBase ? int(topBase.direct) : '–', text: topBase ? `models are built directly on <strong>${esc(topBase.id)}</strong>, more than on any other base` : '' },
      { value: pct(tot.quantized / totalLinks), text: `of all derivatives are ${term('quantization', 'quantizations')}: compressed copies made to run on smaller hardware` },
      { value: topFam ? esc(topFam.family) : '–', text: topFam ? `is the family with the most derived models (${int(topFam.total)})` : '' },
    ],
    howTo: [
      `Four kinds of derivative: ${term('finetune', 'fine-tune')} (trained further), ${term('quantization', 'quantization')} (compressed), ${term('adapter', 'adapter')} (small add-on) and ${term('merge', 'merge')} (combination of models).`,
      'In the first chart, click a base model name to open its tree below.',
      'In the graph, the base model is in the centre; the first ring is its direct derivatives and the outer ring their derivatives. Bigger dots have more downloads.',
      'The list under the graph can be expanded level by level with the + buttons.',
    ],
  }));
  section.append(stats([
    { label: 'Derived models', value: pct(index.derived_models / index.live_models), sub: `${int(index.derived_models)} of ${int(index.live_models)} live models declare a base model`, hero: true },
    { label: 'Fine-tunes', value: int(tot.finetune), sub: 'parent → child links' },
    { label: 'Quantizations', value: int(tot.quantized), sub: 'GGUF, MLX, AWQ, GPTQ…' },
    { label: 'Adapters', value: int(tot.adapter), sub: 'LoRA and other PEFT adapters' },
    { label: 'Merges', value: int(tot.merge), sub: 'models combining several parents' },
  ]));

  const grid = document.createElement('div');
  grid.className = 'grid';
  section.append(grid);

  const withTree = index.bases.filter((b) => b.tree != null);
  const top = index.bases.slice(0, 25);
  grid.append(card({
    title: 'Base models with the most direct derivatives',
    sub: 'Live models that name this base directly. Select one to explore its tree.',
    body: stackedBarList(top.map((b) => ({ label: b.id, parts: rels.map((r) => b.by_relation[r]), base: b })), series, {
      onSelect: (item) => {
        if (item.base.tree != null) { explorer.select(item.base.tree, true); } else { location.hash = modelHref(item.base.id); }
      },
    }),
    table: {
      columns: [{ key: 'id', label: 'Base model' }, { key: 'direct', label: 'Direct', num: true, fmt: int },
        ...rels.map((r) => ({ key: r, label: REL[r].label, num: true, fmt: int })),
        { key: 'descendants', label: 'All descendants', num: true, fmt: int }, { key: 'depth', label: 'Depth', num: true }],
      rows: index.bases.map((b) => ({ ...b, ...b.by_relation })),
    },
  }));

  grid.append(card({
    title: 'Derivatives by family', sub: 'Derived models grouped by the family of the model (detected from names and base models)',
    body: stackedBarList(index.families.slice(0, 15).map((f) => ({ label: f.family, parts: rels.map((r) => f[r]) })), series, {
      onSelect: (item) => { location.hash = familyHref(item.label); },
    }),
    table: { columns: [{ key: 'family', label: 'Family' }, ...rels.map((r) => ({ key: r, label: REL[r].label, num: true, fmt: int })), { key: 'total', label: 'Total', num: true, fmt: int }], rows: index.families },
  }));

  const ex = document.createElement('article');
  ex.className = 'card span-12';
  ex.id = 'tree-explorer';
  ex.innerHTML = `
    <div class="card-head"><div><h2>Tree explorer</h2><p class="sub">The graph shows the base and two generations of derivatives (node size reflects downloads). The list below it is fully navigable. Very large families are trimmed to the most downloaded branches.</p></div></div>
    <div class="filters" style="margin-bottom:12px">
      <div class="field"><label for="tree-pick">Base model</label>
        <select id="tree-pick">${withTree.map((b) => `<option value="${b.tree}">${esc(b.id)} (${int(b.direct)} direct)</option>`).join('')}</select></div>
      <div class="field"><label for="tree-find">Or type a name</label>
        <input id="tree-find" list="tree-bases" placeholder="e.g. Qwen3-8B" autocomplete="off">
        <datalist id="tree-bases">${withTree.map((b) => `<option value="${esc(b.id)}"></option>`).join('')}</datalist></div>
    </div>
    <div id="tree-summary"></div>
    <div class="graph-wrap" id="tree-graph"></div>
    <ul class="legend">${rels.map((r) => `<li><span class="swatch" style="background:${REL[r].color};border-radius:50%"></span>${REL[r].label}</li>`).join('')}</ul>
    <h3 style="margin:16px 0 6px">Navigable tree</h3>
    <div class="tree tree-scroll" id="tree-list"></div>`;
  grid.append(ex);
  explorer = makeExplorer(ex);
  const initial = treeOf(params.get('tree'));
  explorer.select(initial ?? withTree[0].tree, false);
  if (params.get('tree') && initial == null) {
    ex.querySelector('#tree-summary').insertAdjacentHTML('beforebegin', `<p class="note">No tree is drawn for ${esc(params.get('tree'))}: only the ${int(withTree.length)} bases with the most derivatives get one. <a href="${esc(modelHref(params.get('tree')))}">Open its model page →</a></p>`);
  } else if (params.get('tree')) {
    ex.scrollIntoView({ block: 'start' });
  }
}

export function update(section, params) {
  const idx = treeOf(params.get('tree'));
  if (explorer && idx != null) explorer.select(idx, true);
}

/** A tree by base model id (permalinks) or by its number (older links). */
function treeOf(v) {
  if (v == null || v === '') return null;
  const byId = index.bases.find((b) => b.tree != null && b.id.toLowerCase() === v.toLowerCase());
  if (byId) return byId.tree;
  return /^\d+$/.test(v) && index.bases.some((b) => b.tree === +v) ? +v : null;
}

function makeExplorer(root) {
  const pick = root.querySelector('#tree-pick');
  const graphEl = root.querySelector('#tree-graph');
  const listEl = root.querySelector('#tree-list');
  const summaryEl = root.querySelector('#tree-summary');
  let current = null;
  pick.addEventListener('change', () => select(+pick.value, false));
  const find = root.querySelector('#tree-find');
  find.addEventListener('change', () => {
    const idx = treeOf(find.value.trim());
    if (idx != null) { select(idx, false); find.value = ''; }
  });

  async function select(idx, scroll) {
    if (idx === current) { if (scroll) root.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    current = idx;
    pick.value = String(idx);
    history.replaceState(null, '', `#families?tree=${encodeURIComponent(index.bases.find((x) => x.tree === idx)?.id ?? idx)}`);
    graphEl.innerHTML = '<p class="loading" style="padding:20px">Loading tree…</p>';
    const data = await load(`families/tree-${idx}.json`);
    if (current !== idx) return;
    const rels = data.relations;
    const b = data.base;
    summaryEl.innerHTML = `<p><a href="${esc(modelHref(b.id))}"><strong>${esc(b.id)}</strong></a> <a class="hub-link" href="${esc(hfUrl(b.id))}" rel="noopener">Hub ↗</a>
      ${b.task ? `· ${esc(task(b.task))}` : ''} ${b.downloads != null ? `· ${compact(b.downloads)} downloads (30d)` : '· not tracked by the radar itself'}
      ${b.parents?.length ? `<br><span class="note">Itself built on ${b.parents.map((p) => esc(p)).join(', ')}</span>` : ''}<br>
      <span class="note">${int(b.direct)} direct derivatives, ${int(b.descendants)} in total across ${b.depth} generation${b.depth === 1 ? '' : 's'}; they were downloaded ${compact(b.descendant_downloads)} times in the last 30 days.</span></p>`;
    drawGraph(graphEl, data.tree, rels, (node) => revealInList(node));
    listEl.replaceChildren(treeList(data.tree, rels));
    if (scroll) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function revealInList(node) {
    const li = listEl.querySelector(`[data-id="${CSS.escape(node.i)}"]`);
    if (!li) return;
    // expand ancestors
    let p = li.parentElement;
    while (p && p !== listEl) {
      if (p.tagName === 'UL') p.hidden = false;
      if (p.tagName === 'LI') p.querySelector(':scope > .node > .twisty')?.setAttribute('aria-expanded', 'true');
      p = p.parentElement;
    }
    const n = li.querySelector(':scope > .node');
    n.classList.add('flash');
    setTimeout(() => n.classList.remove('flash'), 1600);
    n.scrollIntoView({ behavior: 'smooth', block: 'center' });
    n.querySelector('a')?.focus({ preventScroll: true });
  }
  return { select };
}

function nodeHtml(n, rels, isRoot) {
  const rel = isRoot ? '' : `<span class="rel rel-${rels[n.r]}">${REL[rels[n.r]].one}</span>`;
  const meta = [fmtParams(n.p) ? `${fmtParams(n.p)}` : null, `${compact(n.d)} dl`, n.n ? `${int(n.n)} derivative${n.n === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
  return `${rel}<a href="${esc(modelHref(n.i))}">${esc(n.i)}</a><span class="meta">${meta}</span>`;
}

function treeList(rootNode, rels) {
  const build = (n, depth) => {
    const li = document.createElement('li');
    li.dataset.id = n.i;
    const node = document.createElement('div');
    node.className = 'node';
    const kids = n.c || [];
    if (kids.length) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'twisty';
      const open = depth === 0;
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', `Show derivatives of ${n.i}`);
      btn.textContent = open ? '−' : '+';
      node.append(btn);
    }
    node.insertAdjacentHTML('beforeend', nodeHtml(n, rels, depth === 0));
    li.append(node);
    if (kids.length) {
      const ul = document.createElement('ul');
      ul.hidden = depth !== 0;
      kids.forEach((k) => ul.append(build(k, depth + 1)));
      if (n.more) ul.insertAdjacentHTML('beforeend', `<li class="more">… and ${int(n.more)} more with fewer downloads</li>`);
      li.append(ul);
    }
    return li;
  };
  const ul = document.createElement('ul');
  ul.append(build(rootNode, 0));
  ul.addEventListener('click', (e) => {
    const btn = e.target.closest('.twisty');
    if (!btn) return;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? '−' : '+';
    btn.closest('li').querySelector(':scope > ul').hidden = !open;
  });
  return ul;
}

/** Radial layout: root in the centre, children on ring 1, grandchildren on ring 2. */
function drawGraph(container, tree, rels, onPick) {
  container.innerHTML = '';
  const S = 640, C = S / 2;
  const R1 = 150, R2 = 270;
  const kids = tree.c || [];
  const weight = (k) => Math.max(1, (k.c || []).length);
  const totalW = kids.reduce((s, k) => s + weight(k), 0) || 1;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Graph of ${tree.i} and ${kids.length} direct derivatives shown`);
  const links = [], nodes = [];
  const rad = (d) => 2.5 + Math.min(9, Math.log10((d || 0) + 1) * 1.4);
  nodes.push({ n: tree, x: C, y: C, r: 12, root: true });
  let a0 = -Math.PI / 2;
  kids.forEach((k) => {
    const span = (weight(k) / totalW) * Math.PI * 2;
    const a = a0 + span / 2;
    const x = C + R1 * Math.cos(a), y = C + R1 * Math.sin(a);
    links.push([C, C, x, y]);
    nodes.push({ n: k, x, y, r: rad(k.d), a });
    const gk = k.c || [];
    gk.forEach((g, j) => {
      const ga = a0 + (span * (j + 0.5)) / gk.length;
      const gx = C + R2 * Math.cos(ga), gy = C + R2 * Math.sin(ga);
      links.push([x, y, gx, gy]);
      nodes.push({ n: g, x: gx, y: gy, r: rad(g.d) * 0.8 });
    });
    a0 += span;
  });
  const gl = document.createElementNS(SVG_NS, 'g');
  gl.innerHTML = links.map(([x1, y1, x2, y2]) => `<path class="link" d="M${x1.toFixed(1)},${y1.toFixed(1)}Q${((x1 + x2) / 2 + (C - (x1 + x2) / 2) * 0.15).toFixed(1)},${((y1 + y2) / 2 + (C - (y1 + y2) / 2) * 0.15).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}"/>`).join('');
  svg.append(gl);
  // label the most downloaded first-ring nodes
  // (skipping any too close in angle to one already labelled, so labels never collide)
  const labelled = new Set();
  const angles = [];
  for (const d of nodes.filter((x) => x.a != null).sort((p, q) => q.n.d - p.n.d)) {
    if (labelled.size >= 8) break;
    if (angles.some((a) => Math.abs(Math.atan2(Math.sin(d.a - a), Math.cos(d.a - a))) < 0.2)) continue;
    angles.push(d.a);
    labelled.add(d.n.i);
  }
  const gn = document.createElementNS(SVG_NS, 'g');
  nodes.sort((p, q) => q.r - p.r); // draw big nodes first so small ones stay hoverable
  gn.innerHTML = nodes.map((d, i) => {
    const color = d.root ? 'var(--ink)' : REL[rels[d.n.r]].color;
    return `<g class="gnode" data-k="${i}"><circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(1)}" fill="${color}"/></g>`;
  }).join('');
  // Labels go in their own top layer with a surface-coloured halo so nodes never cover them.
  const labels = nodes.filter((d) => d.root || labelled.has(d.n.i)).map((d) => {
    const name = d.n.i.split('/').pop();
    const short = name.length > 26 ? `${name.slice(0, 25)}…` : name;
    const right = d.root || Math.cos(d.a) >= 0;
    const x = d.x + (d.root ? 0 : right ? d.r + 4 : -d.r - 4);
    const y = d.y + (d.root ? -18 : 3);
    return `<text class="glabel${d.root ? ' root' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${d.root ? 'middle' : right ? 'start' : 'end'}">${esc(short)}</text>`;
  }).join('');
  svg.append(gn);
  const gt = document.createElementNS(SVG_NS, 'g');
  gt.setAttribute('pointer-events', 'none');
  gt.innerHTML = labels;
  svg.append(gt);
  gn.addEventListener('mousemove', (e) => {
    const g = e.target.closest('.gnode');
    if (!g) return hideTip();
    const d = nodes[+g.dataset.k];
    const rel = d.root ? 'Base model' : REL[rels[d.n.r]].one;
    showTip(`<strong>${esc(d.n.i)}</strong>${esc(rel)} · ${compact(d.n.d)} downloads${d.n.n ? ` · ${int(d.n.n)} derivatives` : ''}`, e.clientX, e.clientY);
  });
  gn.addEventListener('mouseleave', hideTip);
  gn.addEventListener('click', (e) => {
    const g = e.target.closest('.gnode');
    if (g) onPick(nodes[+g.dataset.k].n);
  });
  container.append(svg);
  container.insertAdjacentHTML('beforeend', `<p class="note" style="padding:6px 10px;margin:0">Showing ${int(nodes.length)} nodes. Hover for details; click a node to find it in the list below.</p>`);
}
