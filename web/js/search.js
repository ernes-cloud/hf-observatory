// Header search: type a model, publisher or family and jump to its page.
// The index (data/search.json) loads on first focus; anything else goes to the finder.

import { load } from './data.js';
import { esc, familyHref, finderHref, int, modelHref, orgHref } from './format.js';

const MAX = 8;

export function initSearch(form) {
  const input = form.querySelector('input');
  const list = form.querySelector('[role="listbox"]');
  let index = null;
  let items = [];
  let active = -1;

  const ensure = () => {
    if (!index) index = load('search.json').then((d) => ({
      models: d.models.map((id) => [id, id.toLowerCase()]),
      authors: d.authors.map(([a, n]) => [a, n, a.toLowerCase()]),
      families: d.families.map(([f, n]) => [f, n, f.toLowerCase()]),
    })).catch(() => { index = null; return null; });
    return index;
  };

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; input.removeAttribute('aria-activedescendant'); };
  const paint = () => {
    list.innerHTML = items.map((it, i) => `<li role="option" id="ss-${i}" aria-selected="${i === active}" data-i="${i}">
      <span class="ss-kind">${it.kind}</span><span class="ss-label">${esc(it.label)}</span>${it.sub ? `<span class="ss-sub">${esc(it.sub)}</span>` : ''}</li>`).join('');
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(!!items.length));
    if (active >= 0) input.setAttribute('aria-activedescendant', `ss-${active}`); else input.removeAttribute('aria-activedescendant');
  };

  const suggest = async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { items = []; paint(); return; }
    const d = await ensure();
    if (!d || input.value.trim().toLowerCase() !== q) return;
    const rank = (s) => (s.startsWith(q) ? 0 : s.includes(`/${q}`) ? 1 : 2);
    const fams = d.families.filter((f) => f[2].includes(q)).slice(0, 2)
      .map(([f, n]) => ({ kind: 'Family', label: f, sub: `${int(n)} models`, href: familyHref(f) }));
    const orgs = d.authors.filter((a) => a[2].includes(q)).sort((a, b) => rank(a[2]) - rank(b[2])).slice(0, 3)
      .map(([a, n]) => ({ kind: 'Publisher', label: a, sub: `${int(n)} models`, href: orgHref(a) }));
    const terms = q.split(/\s+/);
    const models = [];
    for (const [id, low] of d.models) { // sorted by downloads
      if (terms.every((t) => low.includes(t))) models.push({ kind: 'Model', label: id, href: modelHref(id) });
      if (models.length >= MAX) break;
    }
    items = [...fams, ...orgs, ...models].slice(0, MAX);
    items.push({ kind: 'Search', label: `“${input.value.trim()}” in the finder`, href: finderHref({ q: input.value.trim() }) });
    active = -1;
    paint();
  };

  const go = (it) => { close(); input.blur(); location.hash = it.href; input.value = ''; };
  let timer;
  input.addEventListener('focus', ensure);
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(suggest, 120); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    if (active >= 0 && items[active]) return go(items[active]);
    // A full "author/name" id opens the model page even when it is not in the suggestion index.
    if (/^[\w.-]+\/[\w.-]+$/.test(q)) return go({ href: modelHref(q) });
    go({ href: finderHref({ q }) });
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); go(items[+li.dataset.i]); }
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
}
