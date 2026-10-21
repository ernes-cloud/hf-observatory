// Saved Docker Compose files ("favourites") for the advisor.
// Stored in this browser (localStorage); export / import as JSON to move them or keep a backup.
// When storage is blocked (private mode, sandboxed previews) they live in memory for the visit.

const KEY = 'hfo-advisor-favorites';
const MAX = 200;
let memory = [];

const clean = (f) => (f && typeof f === 'object' && typeof f.id === 'string' && typeof f.yaml === 'string' ? {
  id: f.id.slice(0, 40),
  name: String(f.name || 'Untitled compose').slice(0, 120),
  model: String(f.model || '').slice(0, 200),
  runtime: String(f.runtime || '').slice(0, 60),
  machine: String(f.machine || '').slice(0, 160),
  yaml: f.yaml.slice(0, 100000),
  generated: typeof f.generated === 'string' ? f.generated.slice(0, 100000) : f.yaml.slice(0, 100000),
  params: typeof f.params === 'string' ? f.params.slice(0, 2000) : '',
  opts: f.opts && typeof f.opts === 'object' ? f.opts : null,
  note: String(f.note || '').slice(0, 2000),
  savedAt: Number.isFinite(f.savedAt) ? f.savedAt : Date.now(),
  updatedAt: Number.isFinite(f.updatedAt) ? f.updatedAt : Date.now(),
} : null);

export function loadFavorites() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return memory.slice();
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map(clean).filter(Boolean) : [];
  } catch { return memory.slice(); }
}

function store(list) {
  memory = list.slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(memory)); return true; } catch { return false; }
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Add a favourite; returns it. */
export function addFavorite(fav) {
  const f = clean({ ...fav, id: newId(), savedAt: Date.now(), updatedAt: Date.now() });
  store([f, ...loadFavorites()]);
  return f;
}

/** Change fields of a favourite (name, yaml, note); returns the updated one or null. */
export function updateFavorite(id, patch) {
  const list = loadFavorites();
  const i = list.findIndex((f) => f.id === id);
  if (i < 0) return null;
  list[i] = clean({ ...list[i], ...patch, id, updatedAt: Date.now() });
  store(list);
  return list[i];
}

export function removeFavorite(id) {
  store(loadFavorites().filter((f) => f.id !== id));
}

/** True when the saved text differs from what the advisor generated. */
export const isEdited = (f) => f.yaml.trim() !== f.generated.trim();

/** Whether favourites survive a reload in this browser. */
export function persistent() {
  try { localStorage.setItem(`${KEY}-probe`, '1'); localStorage.removeItem(`${KEY}-probe`); return true; } catch { return false; }
}

export function exportFavorites() {
  return JSON.stringify({ kind: 'hf-observatory/compose-favorites', version: 1, exported: new Date().toISOString(), items: loadFavorites() }, null, 2);
}

/** Merge favourites from an export; returns how many were added (same id + same text are skipped). */
export function importFavorites(text) {
  const data = JSON.parse(text);
  const items = (Array.isArray(data) ? data : data?.items || []).map(clean).filter(Boolean);
  if (!items.length) throw new Error('No saved composes found in this file.');
  const list = loadFavorites();
  let added = 0;
  for (const f of items) {
    if (list.some((x) => x.id === f.id && x.yaml === f.yaml)) continue;
    list.unshift(list.some((x) => x.id === f.id) ? { ...f, id: newId() } : f);
    added++;
  }
  store(list);
  return added;
}

/**
 * Light checks for hand-edited compose files (the browser has no YAML parser):
 * tabs used for indentation, a missing "services:" block, unbalanced quotes in a line.
 */
export function lintCompose(text) {
  const issues = [];
  const lines = text.split('\n');
  if (!/^services:\s*$/m.test(text)) issues.push('There is no top-level "services:" block.');
  lines.forEach((l, i) => {
    if (/^\t| \t/.test(l.match(/^\s*/)[0])) issues.push(`Line ${i + 1}: YAML indentation must use spaces, not tabs.`);
    const code = l.replace(/(^|\s)#.*$/, '');
    if ((code.match(/"/g) || []).length % 2) issues.push(`Line ${i + 1}: unbalanced double quotes.`);
  });
  return issues.slice(0, 5);
}
