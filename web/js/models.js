// Shared access to per-model data: the sharded model records (pipeline/hfo/models.py),
// the decoded finder index, and the compare list kept in the browser.

import { load } from './data.js';

/** 32-bit FNV-1a of the lowercased id, as in pipeline/hfo/models.py:shard_of. */
export function shardOf(id, shards = 256) {
  let h = 0x811c9dc5;
  for (const ch of id.toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

/** { rec, dates } for one model (live or removed); rec is null when the id is not tracked. */
export async function loadModel(id) {
  const idx = await load('models/index.json');
  const shard = await load(`models/${shardOf(id, idx.shards).toString(16).padStart(2, '0')}.json`);
  return { rec: shard[id.toLowerCase()] || null, dates: idx.dates };
}

let finder = null;
let complete = null;
/**
 * The finder index, decoded once and shared by the finder, model, publisher and family pages.
 * finder.json holds the models with 100+ downloads (a prefix of the list, which is sorted by
 * downloads); loadFinder({ full: true }) also appends the long tail from finder-rest.json.
 */
export function loadFinder({ full = false } = {}) {
  if (!finder) {
    finder = load('finder.json').then((raw) => {
      const D = { ...raw, n: 0, cols: Object.fromEntries(Object.keys(raw.cols).map((k) => [k, []])), idLower: [], baseLower: [],
        rowOf: new Map(), taskCounts: new Array(raw.dict.task.length).fill(0), langCounts: new Array(raw.dict.language.length).fill(0),
        total: raw.total ?? raw.count };
      append(D, raw);
      D.complete = D.n >= D.total;
      return D;
    });
    finder.catch(() => { finder = null; });
  }
  if (!full) return finder;
  if (!complete) {
    complete = finder.then(async (D) => {
      if (!D.complete) { append(D, await load('finder-rest.json')); D.complete = true; }
      return D;
    });
    complete.catch(() => { complete = null; });
  }
  return complete;
}

function append(D, part) {
  const c = part.cols;
  for (const k of Object.keys(D.cols)) for (const v of c[k] || []) D.cols[k].push(v);
  for (let j = 0; j < part.count; j++) {
    const i = D.n + j;
    D.idLower[i] = c.id[j].toLowerCase();
    D.baseLower[i] = c.base[j] >= 0 ? D.dict.base_model[c.base[j]].toLowerCase() : '';
    D.rowOf.set(D.idLower[i], i);
    if (c.task[j] >= 0) D.taskCounts[c.task[j]]++;
    for (const l of c.lang[j]) D.langCounts[l]++;
  }
  D.n += part.count;
}

/* ---------- compare list (up to 4 models, kept in localStorage) ---------- */
const KEY = 'hfo-compare';
export const COMPARE_MAX = 4;
let memory = [];
const listeners = new Set();

export function compareList() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.slice(0, COMPARE_MAX) : []; } catch (e) { return memory; }
}
function save(list) {
  memory = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* storage unavailable: keep it in memory */ }
  listeners.forEach((f) => f(list));
}
export function toggleCompare(id) {
  const list = compareList();
  const i = list.findIndex((x) => x.toLowerCase() === id.toLowerCase());
  if (i >= 0) list.splice(i, 1); else if (list.length < COMPARE_MAX) list.push(id); else return false;
  save(list);
  return true;
}
export const inCompare = (id) => compareList().some((x) => x.toLowerCase() === id.toLowerCase());
export const clearCompare = () => save([]);
export const onCompareChange = (f) => listeners.add(f);
export const compareHref = (ids) => `#compare?ids=${ids.map(encodeURIComponent).join(',')}`;

/** A "+ Compare" toggle button; wire clicks with bindCompareButtons(). */
export function compareButton(id) {
  const on = inCompare(id);
  return `<button type="button" class="btn btn-small compare-toggle" data-compare="${id.replace(/"/g, '&quot;')}" aria-pressed="${on}">${on ? '✓ In compare' : '+ Compare'}</button>`;
}
export function bindCompareButtons(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-compare]');
    if (!b) return;
    if (!toggleCompare(b.dataset.compare)) { b.textContent = `Up to ${COMPARE_MAX} models`; return; }
  });
  onCompareChange(() => root.querySelectorAll('[data-compare]').forEach((b) => {
    const on = inCompare(b.dataset.compare);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '✓ In compare' : '+ Compare';
  }));
}
