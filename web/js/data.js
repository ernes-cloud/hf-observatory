// Fetch the generated JSON files once and memoise them.
//
// Every file except meta.json is requested as data/<name>?v=<build time>: a new build gets new
// URLs, so browsers (and the service worker, sw.js) can keep each version without revalidating.

const cache = new Map();

function fetchJson(url, name) {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Could not load data/${name} (HTTP ${r.status})`);
    return r.json();
  });
}

let version = null;
const buildVersion = () => {
  if (!version) version = load('meta.json').then((m) => m.generated_at || '', () => '');
  return version;
};

export function load(name) {
  if (!cache.has(name)) {
    const p = name === 'meta.json'
      ? fetchJson('data/meta.json', name)
      : buildVersion().then((v) => fetchJson(`data/${name}${v ? `?v=${encodeURIComponent(v)}` : ''}`, name));
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return cache.get(name);
}
