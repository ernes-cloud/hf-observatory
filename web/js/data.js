// Fetch the generated JSON files once and memoise them.

const cache = new Map();

export function load(name) {
  if (!cache.has(name)) {
    const p = fetch(`data/${name}`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`Could not load data/${name} (HTTP ${r.status})`);
      return r.json();
    });
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return cache.get(name);
}
