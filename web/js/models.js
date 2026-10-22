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
/** The finder index, decoded once and shared by the finder, model, publisher and family pages. */
export function loadFinder() {
  if (!finder) {
    finder = load('finder.json').then((raw) => {
      const c = raw.cols;
      const n = raw.count;
      const idLower = new Array(n);
      const baseLower = new Array(n);
      const rowOf = new Map();
      for (let i = 0; i < n; i++) {
        idLower[i] = c.id[i].toLowerCase();
        baseLower[i] = c.base[i] >= 0 ? raw.dict.base_model[c.base[i]].toLowerCase() : '';
        rowOf.set(idLower[i], i);
      }
      const taskCounts = new Array(raw.dict.task.length).fill(0);
      c.task.forEach((t) => { if (t >= 0) taskCounts[t]++; });
      const langCounts = new Array(raw.dict.language.length).fill(0);
      c.lang.forEach((ls) => ls.forEach((l) => langCounts[l]++));
      return { ...raw, n, idLower, baseLower, rowOf, taskCounts, langCounts };
    });
    finder.catch(() => { finder = null; });
  }
  return finder;
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
