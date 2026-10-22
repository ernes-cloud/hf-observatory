// Service worker: data files of a build are immutable (their URL carries ?v=<build time>), so they
// are served from cache once fetched; the page and its code are fetched fresh when online and
// served from cache when offline. Old builds' data is dropped as soon as a newer one is stored.

const SHELL = 'hfo-shell-v1';
const DATA = 'hfo-data-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL && k !== DATA) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/data/') && url.searchParams.has('v')) e.respondWith(dataFirst(req, url));
  else e.respondWith(networkFirst(req));
});

async function dataFirst(req, url) {
  const cache = await caches.open(DATA);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    const v = url.searchParams.get('v');
    for (const old of await cache.keys()) {
      if (new URL(old.url).searchParams.get('v') !== v) cache.delete(old);
    }
  }
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok && (res.type === 'basic' || res.type === 'default')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const page = await cache.match('./') || await cache.match('index.html');
      if (page) return page;
    }
    throw err;
  }
}
