// Hash router, theme toggle and lazy view loading.

import { load } from './data.js';
import { dateTime, esc } from './format.js';
import { clearCompare, compareHref, compareList, onCompareChange } from './models.js';
import { initSearch } from './search.js';
import { GLOSSARY } from './glossary.js';
import { hideTip, showTip } from './charts.js';

// view name → module path. Each module exports `render(section, params)`.
const VIEWS = {
  home: './views/home.js',
  overview: './views/overview.js',
  finder: './views/finder.js',
  advisor: './views/advisor.js',
  trends: './views/trends.js',
  families: './views/families.js',
  graveyard: './views/graveyard.js',
  newsletter: './views/newsletter.js',
  about: './views/about.js',
  model: './views/model.js',
  org: './views/org.js',
  family: './views/family.js',
  compare: './views/compare.js',
};
// Data each view needs first: fetched in parallel with the view's code instead of after it.
const PREFETCH = {
  home: ['overview.json', 'trends.json', 'families/index.json', 'newsletter/index.json'],
  overview: ['overview.json'], finder: ['finder.json'], advisor: ['advisor.json'], trends: ['trends.json'],
  families: ['families/index.json'], graveyard: ['graveyard.json'], newsletter: ['newsletter/index.json'],
  model: ['models/index.json'], org: ['finder.json'], family: ['finder.json'], compare: ['models/index.json'],
};
let attempt = 0; // a failed dynamic import is remembered by the browser: retries use a fresh URL
// Pages reached from links rather than the tab bar: the tab of the section they belong to stays lit.
const PARENT_TAB = { model: 'finder', org: 'overview', family: 'overview', compare: 'finder' };
const TITLES = {
  home: 'Home', overview: 'Overview', finder: 'Model finder', advisor: 'Model advisor', trends: 'Trends', families: 'Family trees', graveyard: 'Graveyard', newsletter: 'Newsletter', about: 'Help & glossary',
  model: 'Model', org: 'Publisher', family: 'Family', compare: 'Compare',
};

let previous = null;
const rendered = new Map(); // view → module (rendered once, then `update` on param change)

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, query = ''] = raw.split('?');
  return { name: VIEWS[name] ? name : 'home', params: new URLSearchParams(query), unknown: !!name && !VIEWS[name] };
}

async function route() {
  const { name, params, unknown } = parseHash();
  if (unknown) history.replaceState(null, '', '#home');
  document.querySelectorAll('.view').forEach((s) => { s.hidden = s.id !== `view-${name}`; });
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.view === (PARENT_TAB[name] || name)) {
      a.setAttribute('aria-current', 'page');
      // on phones the tab bar scrolls sideways: keep the current section in view
      const bar = a.parentElement;
      if (bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: a.offsetLeft - (bar.clientWidth - a.offsetWidth) / 2 });
    } else a.removeAttribute('aria-current');
  });
  document.title = name === 'home' ? 'HF Observatory' : `${TITLES[name]} · HF Observatory`;
  const section = document.getElementById(`view-${name}`);
  hideTip();
  const moved = previous !== null && previous !== name;
  if (previous !== name) window.scrollTo(0, 0);
  previous = name;
  if (rendered.has(name)) {
    const mod = rendered.get(name);
    if (mod.update) mod.update(section, params);
    return;
  }
  rendered.set(name, null);
  section.innerHTML = '<p class="loading" role="status">Loading…</p>';
  for (const f of PREFETCH[name] || []) load(f).catch(() => {}); // errors surface where the view awaits them
  try {
    const mod = await import(attempt ? `${VIEWS[name]}?retry=${attempt}` : VIEWS[name]);
    await mod.render(section, params);
    rendered.set(name, mod);
    // move keyboard and screen-reader focus to the new page's heading
    const h1 = moved && section.querySelector('h1');
    if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
  } catch (err) {
    rendered.delete(name);
    console.warn(err);
    section.innerHTML = `<div class="error" role="alert"><p>Something went wrong loading this section: ${esc(err.message)}</p>
      <p>${navigator.onLine === false ? 'You seem to be offline. ' : ''}<button type="button" class="btn" data-retry>Try again</button></p></div>`;
    section.querySelector('[data-retry]').addEventListener('click', () => { attempt++; route(); });
  }
}

/* Theme: system → light → dark → system */
function initTheme() {
  const btn = document.getElementById('theme-toggle');
  const label = btn.querySelector('.theme-label');
  const get = () => document.documentElement.dataset.theme || 'system';
  const paint = () => {
    const t = get();
    const text = t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark';
    label.textContent = text;
    btn.setAttribute('aria-label', `Theme: ${text}. Click to change.`);
  };
  btn.addEventListener('click', () => {
    const next = { system: 'light', light: 'dark', dark: 'system' }[get()];
    if (next === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    try { if (next === 'system') localStorage.removeItem('hfo-theme'); else localStorage.setItem('hfo-theme', next); } catch (e) { /* storage unavailable */ }
    paint();
  });
  paint();
}

async function initFreshness() {
  const el = document.getElementById('data-freshness');
  try {
    const meta = await load('meta.json');
    el.textContent = `Dataset snapshot: ${dateTime(meta.snapshot_at)}${meta.release ? ` (release ${meta.release})` : ''} · site data built ${dateTime(meta.generated_at)}`;
  } catch (e) {
    el.textContent = 'Data not available. Run the pipeline to generate web/data/.';
  }
}

/* Glossary terms: show the definition on hover, keyboard focus or tap. */
function initGlossary() {
  const show = (btn) => {
    const g = GLOSSARY[btn.dataset.term];
    if (!g) return;
    const r = btn.getBoundingClientRect();
    showTip(`<strong>${esc(g[0])}</strong>${esc(g[1])}`, r.left, r.bottom - 6);
  };
  document.addEventListener('mouseover', (e) => { const b = e.target.closest?.('.term'); if (b) show(b); });
  document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.term')) hideTip(); });
  document.addEventListener('focusin', (e) => { const b = e.target.closest?.('.term'); if (b) show(b); });
  document.addEventListener('focusout', (e) => { if (e.target.closest?.('.term')) hideTip(); });
  document.addEventListener('click', (e) => { const b = e.target.closest?.('.term'); if (b) { e.preventDefault(); show(b); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
}

/* Compare tray: a small bar while models wait to be compared. */
function initCompareTray() {
  const tray = document.getElementById('compare-tray');
  const paint = (list = compareList()) => {
    tray.hidden = !list.length || parseHash().name === 'compare';
    tray.innerHTML = `<span><strong>${list.length}</strong> model${list.length === 1 ? '' : 's'} to compare</span>
      <a class="btn btn-primary btn-small" href="${esc(compareHref(list))}">Compare</a>
      <button type="button" class="btn btn-small" data-clear>Clear</button>`;
  };
  tray.addEventListener('click', (e) => { if (e.target.closest('[data-clear]')) clearCompare(); });
  onCompareChange(paint);
  window.addEventListener('hashchange', () => paint());
  paint();
}

// Repeat visits and offline use (sw.js). Skipped under automation so tests always see the network.
if ('serviceWorker' in navigator && !navigator.webdriver) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

initTheme();
initGlossary();
initSearch(document.getElementById('site-search'));
initCompareTray();
initFreshness();
window.addEventListener('hashchange', route);
route();
