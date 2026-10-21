// Hash router, theme toggle and lazy view loading.

import { load } from './data.js';
import { dateTime, esc } from './format.js';
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
};
const TITLES = {
  home: 'Home', overview: 'Overview', finder: 'Model finder', advisor: 'Model advisor', trends: 'Trends', families: 'Family trees', graveyard: 'Graveyard', newsletter: 'Newsletter', about: 'Help & glossary',
};

let previous = null;
const rendered = new Map(); // view → module (rendered once, then `update` on param change)

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, query = ''] = raw.split('?');
  return { name: VIEWS[name] ? name : 'home', params: new URLSearchParams(query) };
}

async function route() {
  const { name, params } = parseHash();
  document.querySelectorAll('.view').forEach((s) => { s.hidden = s.id !== `view-${name}`; });
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = name === 'home' ? 'HF Observatory' : `${TITLES[name]} · HF Observatory`;
  const section = document.getElementById(`view-${name}`);
  hideTip();
  if (previous !== name) window.scrollTo(0, 0);
  previous = name;
  if (rendered.has(name)) {
    const mod = rendered.get(name);
    if (mod.update) mod.update(section, params);
    return;
  }
  rendered.set(name, null);
  section.innerHTML = '<p class="loading" role="status">Loading…</p>';
  try {
    const mod = await import(VIEWS[name]);
    await mod.render(section, params);
    rendered.set(name, mod);
  } catch (err) {
    rendered.delete(name);
    console.warn(err);
    section.innerHTML = `<p class="error" role="alert">Something went wrong loading this section: ${esc(err.message)}</p>`;
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

initTheme();
initGlossary();
initFreshness();
window.addEventListener('hashchange', route);
route();
