import { load } from '../data.js';
import { term } from '../glossary.js';
import { pageHeader } from '../ui.js';
import { compact, date, esc, FORMAT_LABEL, gigabytes, hfUrl, int, language, LICENSE_FAMILY, params as fmtParams, task } from '../format.js';

const PAGE = 24;
const MEMORY_PRESETS = [
  { v: '', label: 'Any size' },
  { v: '4', label: 'Fits in 4 GB (phones, edge devices)' },
  { v: '8', label: 'Fits in 8 GB (entry GPUs, 8 GB laptops)' },
  { v: '16', label: 'Fits in 16 GB (RTX 4080, 16 GB Macs)' },
  { v: '24', label: 'Fits in 24 GB (RTX 3090/4090)' },
  { v: '48', label: 'Fits in 48 GB (2× 24 GB, 48 GB Macs)' },
  { v: '80', label: 'Fits in 80 GB (A100/H100)' },
];
const SORTS = [
  { v: 'downloads', label: 'Downloads (30 days)' },
  { v: 'likes', label: 'Most liked' },
  { v: 'trending', label: 'Trending' },
  { v: 'newest', label: 'Newest' },
  { v: 'smallest', label: 'Smallest first' },
];
const DAY_MS = 86400000;

// One-click starting points for common needs; each replaces the current filters.
const PRESETS = [
  { label: 'Chatbot for my laptop', state: { task: 'text-generation', chat: true, mem: '16', fmt: ['gguf'] } },
  { label: 'Runs on a Mac', state: { fmt: ['mlx'], mem: '16' } },
  { label: 'Commercial use, small', state: { lic: 'commercial', mem: '8' } },
  { label: 'Speech to text', state: { task: 'automatic-speech-recognition' } },
  { label: 'Image generation', state: { task: 'text-to-image' } },
  { label: 'Embeddings for search', state: { task: 'feature-extraction' } },
  { label: 'Trending now', state: { sort: 'trending' } },
];
const EMPTY = { q: '', task: '', lang: '', lic: '', mem: '', unknownSize: false, fmt: [], hideGated: false, chat: false, showNoise: false, sort: 'downloads' };
let hiddenNoise = 0;
const NOISE = 8; // flag set by the pipeline: experiment sweeps, course exercises, test repos, no traction after a week

let D = null; // decoded index
let state = null;
let shown = PAGE;
let els = {};

function decode(raw) {
  const c = raw.cols;
  const n = raw.count;
  const idLower = new Array(n);
  const baseLower = new Array(n);
  for (let i = 0; i < n; i++) {
    idLower[i] = c.id[i].toLowerCase();
    baseLower[i] = c.base[i] >= 0 ? raw.dict.base_model[c.base[i]].toLowerCase() : '';
  }
  // task / language option counts
  const taskCounts = new Array(raw.dict.task.length).fill(0);
  c.task.forEach((t) => { if (t >= 0) taskCounts[t]++; });
  const langCounts = new Array(raw.dict.language.length).fill(0);
  c.lang.forEach((ls) => ls.forEach((l) => langCounts[l]++));
  return { ...raw, n, idLower, baseLower, taskCounts, langCounts };
}

function readState(p) {
  return {
    q: p.get('q') || '',
    task: p.get('task') || '',
    lang: p.get('lang') || '',
    lic: p.get('lic') || '',
    mem: p.get('mem') || '',
    unknownSize: p.get('unknown') === '1',
    fmt: (p.get('fmt') || '').split(',').filter((f) => D.dict.format.includes(f)),
    hideGated: p.get('gated') === 'hide',
    chat: p.get('chat') === '1',
    showNoise: p.get('all') === '1',
    sort: SORTS.some((s) => s.v === p.get('sort')) ? p.get('sort') : 'downloads',
  };
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.task) p.set('task', state.task);
  if (state.lang) p.set('lang', state.lang);
  if (state.lic) p.set('lic', state.lic);
  if (state.mem) p.set('mem', state.mem);
  if (state.mem && state.unknownSize) p.set('unknown', '1');
  if (state.fmt.length) p.set('fmt', state.fmt.join(','));
  if (state.hideGated) p.set('gated', 'hide');
  if (state.chat) p.set('chat', '1');
  if (state.showNoise) p.set('all', '1');
  if (state.sort !== 'downloads') p.set('sort', state.sort);
  const qs = p.toString();
  history.replaceState(null, '', `#finder${qs ? `?${qs}` : ''}`);
}

function filter() {
  const c = D.cols;
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const taskIdx = state.task ? D.dict.task.indexOf(state.task) : -1;
  const langIdx = state.lang ? D.dict.language.indexOf(state.lang) : -1;
  // license_family dictionary order: oss, non-commercial, unknown, conditional
  const lfIdx = { commercial: [0], 'commercial-terms': [0, 3], noncommercial: [1], unclear: [2], known: [0, 1, 3] }[state.lic];
  const mem = state.mem ? +state.mem : null;
  const fmtMask = state.fmt.reduce((m, f) => m | (1 << D.dict.format.indexOf(f)), 0);
  const out = [];
  hiddenNoise = 0;
  for (let i = 0; i < D.n; i++) {
    if (state.task && c.task[i] !== taskIdx) continue;
    if (lfIdx && !lfIdx.includes(c.lf[i])) continue;
    if (state.hideGated && c.flags[i] & 1) continue;
    if (state.chat && !(c.flags[i] & 2)) continue;
    if (fmtMask && !(c.fmt[i] & fmtMask)) continue;
    if (mem != null) {
      const m = c.mem[i];
      if (m == null ? !state.unknownSize : m > mem) continue;
    }
    if (state.lang && !c.lang[i].includes(langIdx)) continue;
    if (terms.length) {
      const hay = D.idLower[i];
      const base = D.baseLower[i];
      if (!terms.every((t) => hay.includes(t) || base.includes(t))) continue;
    }
    if (!state.showNoise && c.flags[i] & NOISE) { hiddenNoise++; continue; }
    out.push(i);
  }
  const key = {
    downloads: (i) => -c.dl[i],
    likes: (i) => -c.likes[i],
    trending: (i) => -c.trend[i],
    newest: (i) => -(c.created[i] ?? 0),
    smallest: (i) => c.params[i] ?? (c.mem[i] != null ? c.mem[i] * 500 : Infinity),
  }[state.sort];
  if (state.sort !== 'downloads') {
    // index is pre-sorted by downloads, so a stable sort keeps downloads as the tie-breaker
    const k = new Map(out.map((i) => [i, key(i) ?? Infinity]));
    out.sort((a, b) => k.get(a) - k.get(b));
  }
  return out;
}

function summary(i) {
  const c = D.cols;
  const p = fmtParams(c.params[i]);
  const t = c.task[i] >= 0 ? task(D.dict.task[c.task[i]]).toLowerCase() : null;
  const base = c.base[i] >= 0 ? D.dict.base_model[c.base[i]] : null;
  const isMerge = c.flags[i] & 4;
  const fmts = D.dict.format.filter((f, k) => c.fmt[i] & (1 << k)).map((f) => FORMAT_LABEL[f]);
  const lf = D.dict.license_family[c.lf[i]];
  const lic = c.lic[i] >= 0 ? D.dict.license[c.lic[i]] : null;
  const lib = c.lib[i] >= 0 ? D.dict.library[c.lib[i]] : null;
  let s = `A${p ? ` ${p}-parameter` : ''} ${t ? `${t} model` : lib ? `${lib} model` : 'model'}`;
  if (/^[aeiou8]/i.test(s.slice(2))) s = 'An' + s.slice(1);
  if (base) {
    const bases = base.split(',').map((b) => b.trim()).filter(Boolean);
    s += isMerge || bases.length > 1 ? `, merged from ${bases.slice(0, 2).join(' and ')}${bases.length > 2 ? ` and ${bases.length - 2} more` : ''}` : `, derived from ${bases[0]}`;
  }
  s += '.';
  if (c.flags[i] & 2) s += ' Tuned for chat / instructions.';
  if (fmts.length) s += ` Ships as ${fmts.join(', ')}.`;
  if (lf === 'oss') s += ` License: ${lic || 'open'} (commercial use allowed).`;
  else if (lf === 'non-commercial') s += ` License: ${lic || 'non-commercial'} (no commercial use).`;
  else if (lf === 'conditional') s += ` License: ${lic} (custom terms: commercial use is usually allowed with conditions, read them first).`;
  else s += lic && lic !== 'other' && lic !== 'unknown' ? ` License: ${lic} (check its terms before commercial use).` : ' License not clearly declared.';
  return s;
}

function cardHtml(i) {
  const c = D.cols;
  const id = c.id[i];
  const [author, ...rest] = id.split('/');
  const lf = D.dict.license_family[c.lf[i]];
  const chips = [];
  if (c.task[i] >= 0) chips.push(`<span class="chip">${esc(task(D.dict.task[c.task[i]]))}</span>`);
  const p = fmtParams(c.params[i]);
  if (p) chips.push(`<span class="chip">${p} params</span>`);
  const mem = gigabytes(c.mem[i]);
  if (mem) chips.push(`<span class="chip" title="Estimated memory to load the weights (smallest common quantization for GGUF)">≈ ${mem}</span>`);
  chips.push(`<span class="chip ${lf === 'oss' ? 'ok' : lf === 'non-commercial' ? 'nc' : ''}">${esc(LICENSE_FAMILY[lf].short)}</span>`);
  D.dict.format.forEach((f, k) => { if (c.fmt[i] & (1 << k)) chips.push(`<span class="chip">${FORMAT_LABEL[f]}</span>`); });
  const langs = c.lang[i];
  if (langs.length) chips.push(`<span class="chip" title="${esc(langs.map((l) => language(D.dict.language[l])).join(', '))}">${esc(langs.slice(0, 2).map((l) => language(D.dict.language[l])).join(', '))}${langs.length > 2 ? ` +${langs.length - 2}` : ''}</span>`);
  if (c.flags[i] & 1) chips.push('<span class="chip gated">Gated</span>');
  const created = c.created[i] != null ? date(c.created[i] * DAY_MS) : null;
  return `<article class="model-card">
    <h3><a href="${esc(hfUrl(id))}" rel="noopener"><span class="author">${esc(author)}/</span>${esc(rest.join('/'))}</a></h3>
    <div class="chips">${chips.join('')}</div>
    <p class="summary">${esc(summary(i))}</p>
    <div class="model-stats">
      <span title="Downloads in the last 30 days"><b>${compact(c.dl[i])}</b> downloads</span>
      <span><b>${compact(c.likes[i])}</b> likes</span>
      ${c.trend[i] ? `<span title="Hugging Face trending score"><b>${compact(c.trend[i])}</b> trending</span>` : ''}
      ${created ? `<span>created ${esc(created)}</span>` : ''}
    </div>
  </article>`;
}

let results = [];
function markPresets() {
  els.presets?.forEach((b) => {
    const want = { ...EMPTY, ...PRESETS[+b.dataset.i].state };
    b.setAttribute('aria-pressed', String(JSON.stringify(want) === JSON.stringify(state)));
  });
}

function refresh(resetPage = true) {
  markPresets();
  results = filter();
  if (resetPage) shown = PAGE;
  els.count.textContent = `${int(results.length)} model${results.length === 1 ? '' : 's'} match`
    + (hiddenNoise ? ` (${int(hiddenNoise)} low-signal uploads hidden)` : '');
  if (!results.length) {
    els.results.innerHTML = '<div class="empty">No models match these filters. Try removing one.</div>';
    els.more.hidden = true;
    return;
  }
  els.results.innerHTML = results.slice(0, shown).map(cardHtml).join('');
  els.more.hidden = results.length <= shown;
  els.moreBtn.textContent = `Show ${Math.min(PAGE, results.length - shown)} more`;
}

function syncForm() {
  const f = els.form;
  f.q.value = state.q;
  f.task.value = state.task;
  f.lang.value = state.lang;
  f.lic.value = state.lic;
  f.mem.value = state.mem;
  f.unknown.checked = state.unknownSize;
  f.unknown.disabled = !state.mem;
  f.querySelectorAll('input[name="fmt"]').forEach((x) => { x.checked = state.fmt.includes(x.value); });
  f.gated.checked = state.hideGated;
  f.chat.checked = state.chat;
  f.all.checked = state.showNoise;
  f.sort.value = state.sort;
}

function readForm() {
  const f = els.form;
  state = {
    q: f.q.value.trim(),
    task: f.task.value,
    lang: f.lang.value,
    lic: f.lic.value,
    mem: f.mem.value,
    unknownSize: f.unknown.checked,
    fmt: [...f.querySelectorAll('input[name="fmt"]:checked')].map((x) => x.value),
    hideGated: f.gated.checked,
    chat: f.chat.checked,
    showNoise: f.all.checked,
    sort: f.sort.value,
  };
  f.unknown.disabled = !state.mem;
}

export async function render(section, params) {
  D = decode(await load('finder.json'));
  const taskOpts = D.dict.task.map((t, i) => ({ t, n: D.taskCounts[i] })).sort((a, b) => b.n - a.n)
    .map(({ t, n }) => `<option value="${esc(t)}">${esc(task(t))} (${int(n)})</option>`).join('');
  const langOpts = D.dict.language.map((l, i) => ({ l, n: D.langCounts[i] })).filter((x) => x.n >= 5)
    .map(({ l, n }) => ({ l, n, name: language(l) })).sort((a, b) => b.n - a.n)
    .map(({ l, n, name }) => `<option value="${esc(l)}">${esc(name)} (${int(n)})</option>`).join('');

  section.replaceChildren(pageHeader({
    id: 'h-finder', eyebrow: 'Model finder', title: 'Which model fits my needs?',
    lead: `Search ${int(D.n)} live models. Pick a starting point below or set the filters yourself; every result links to the model's page on Hugging Face.`,
    howTo: [
      `<strong>Task</strong> is what the model does (chat, transcribe audio, generate images…).`,
      `<strong>Max size</strong> uses the ${term('memory', 'estimated memory')} needed to load the model. Choose the memory of your GPU or Mac.`,
      `<strong>License: open source</strong> keeps only models with an open-source ${term('license', 'license')}. Custom licenses such as Llama or Gemma allow commercial use with conditions; pick the second option to include them.`,
      'Experiment checkpoints, course exercises, test repos and uploads nobody used are hidden unless you tick <strong>Show low-signal uploads</strong>.',
      `<strong>Format</strong>: ${term('gguf', 'GGUF')} for Ollama / LM Studio / llama.cpp, ${term('mlx', 'MLX')} for Apple Silicon, ${term('onnx', 'ONNX')} for browsers and mobile.`,
      `${term('gated', 'Gated')} models need you to request access first; hide them if you want something you can download right away.`,
    ],
  }));
  const presetsEl = document.createElement('div');
  presetsEl.innerHTML = `<p class="presets-label" id="presets-label">Quick start</p>
    <div class="presets" role="group" aria-labelledby="presets-label">${PRESETS.map((p, i) => `<button type="button" class="preset" data-i="${i}" aria-pressed="false">${esc(p.label)}</button>`).join('')}</div>`;
  section.append(presetsEl);
  section.insertAdjacentHTML('beforeend', `
    <form class="card filters" id="finder-form" role="search" onsubmit="return false">
      <div class="field wide"><label for="f-q">Search by name, organization or base model</label>
        <input type="search" id="f-q" name="q" placeholder="e.g. qwen coder, whisper, unsloth" autocomplete="off"></div>
      <div class="field"><label for="f-task">Task</label>
        <select id="f-task" name="task"><option value="">Any task</option>${taskOpts}</select></div>
      <div class="field"><label for="f-lang">Language</label>
        <select id="f-lang" name="lang"><option value="">Any language</option>${langOpts}</select></div>
      <div class="field"><label for="f-lic">License</label>
        <select id="f-lic" name="lic">
          <option value="">Any license</option>
          <option value="commercial">Open source (commercial use allowed)</option>
          <option value="commercial-terms">Commercial use, including custom terms (Llama, Gemma…)</option>
          <option value="known">Clearly declared</option>
          <option value="noncommercial">Non-commercial only</option>
          <option value="unclear">Unclear / not declared</option>
        </select></div>
      <div class="field"><label for="f-mem">Max size (estimated memory)</label>
        <select id="f-mem" name="mem">${MEMORY_PRESETS.map((m) => `<option value="${m.v}">${m.label}</option>`).join('')}</select></div>
      <div class="field"><label for="f-sort">Sort by</label>
        <select id="f-sort" name="sort">${SORTS.map((s) => `<option value="${s.v}">${s.label}</option>`).join('')}</select></div>
      <fieldset class="field wide" style="border:0;padding:0;margin:0">
        <legend class="label" style="font-size:.8rem;color:var(--ink-2);font-weight:600;margin-bottom:4px">Format (any of)</legend>
        <div class="checks">${D.dict.format.map((f) => `<label class="chip-toggle"><input type="checkbox" name="fmt" value="${f}">${FORMAT_LABEL[f]}</label>`).join('')}</div>
      </fieldset>
      <div class="field wide checks">
        <label><input type="checkbox" name="gated"> Hide gated models</label>
        <label><input type="checkbox" name="chat"> Chat / instruct models only</label>
        <label><input type="checkbox" name="unknown"> Include models of unknown size</label>
        <label title="Experiment checkpoints, course exercises, test repos and uploads with no downloads or likes after a week"><input type="checkbox" name="all"> Show low-signal uploads</label>
        <button type="reset" class="btn" id="f-reset">Reset filters</button>
      </div>
    </form>
    <div class="filter-bar"><p class="result-count" id="f-count" role="status" aria-live="polite"></p></div>
    <div class="results" id="f-results"></div>
    <div class="more-row" id="f-more" hidden><button type="button" class="btn btn-primary" id="f-more-btn">Show more</button></div>`);

  els = {
    form: section.querySelector('#finder-form'),
    count: section.querySelector('#f-count'),
    results: section.querySelector('#f-results'),
    more: section.querySelector('#f-more'),
    moreBtn: section.querySelector('#f-more-btn'),
  };
  state = readState(params);
  syncForm();
  refresh();
  els.presets = [...presetsEl.querySelectorAll('.preset')];
  els.presets.forEach((b) => b.addEventListener('click', () => {
    state = { ...EMPTY, ...PRESETS[+b.dataset.i].state };
    syncForm();
    writeHash();
    refresh();
  }));
  markPresets();

  let timer;
  const onChange = (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { readForm(); writeHash(); refresh(); }, e.target.name === 'q' ? 180 : 0);
  };
  els.form.addEventListener('input', onChange);
  els.form.addEventListener('change', onChange);
  els.form.addEventListener('reset', () => setTimeout(() => { readForm(); writeHash(); refresh(); }));
  els.moreBtn.addEventListener('click', () => {
    const first = shown;
    shown += PAGE;
    refresh(false);
    els.results.children[first]?.querySelector('a')?.focus();
  });
}

export function update(section, params) {
  if (!D) return;
  const next = readState(params);
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  syncForm();
  refresh();
}
