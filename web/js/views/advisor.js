import { load } from '../data.js';
import { compact, esc, hfUrl, int, language, LICENSE_FAMILY, task } from '../format.js';
import { GLOSSARY, term } from '../glossary.js';
import { pageHeader } from '../ui.js';
import { CPU_MEMORY, GPUS, MAC_CHIPS, PRESETS, RAM_SIZES, UNIFIED, UNIFIED_GROUPS, allGpus, gpuById } from '../advisor/hardware.js';
import {
  AGENT_KINDS, CTX_STOPS, LLM_USES, RUNTIMES, SIZE_STOPS, USER_STOPS, USES,
  agentKind, capacity, energyPerMillion, finetuneCapacity, memNeeded, recommend, refit, runtimeKinds, speedLabel, thinkingOf, upgradeOptions,
} from '../advisor/engine.js';
import { commandsFor, defaultOptions, defaultSpecTokens } from '../advisor/commands.js';
import { addFavorite, exportFavorites, importFavorites, isEdited, lintCompose, loadFavorites, packFavorite, persistent, removeFavorite, unpackFavorite, updateFavorite } from '../advisor/favorites.js';

const LANGS = ['en', 'es', 'zh', 'fr', 'de', 'ja', 'ko', 'pt', 'it', 'ru', 'ar', 'hi'];
const MUST = [['tools', 'Tool calling'], ['vision', 'Vision'], ['reasoning', 'Thinking / reasoning'], ['spec', 'Speculative decoding'], ['prequant', 'Ready-made build for my setup'], ['longctx', 'Long context']];
// Graphics-card list: consumer, laptop and workstation cards, then unified-memory machines, data centre, AMD, Intel.
const GPU_GROUPS = [...GPUS.slice(0, 5), UNIFIED_GROUPS[0], ...GPUS.slice(5, 7), UNIFIED_GROUPS[1], ...GPUS.slice(7)];
const PAGE = 10;

const DEFAULT = {
  use: 'chat', agent: 'coding', ragPart: 'both',
  hw: 'gpu', gpu: 'rtx-4090', customVram: 16, customBw: 500, ngpu: 1, gpu2: '', ngpu2: 1, chip: 'm4-max', mac: 64, unified: 'dgx-spark', nunits: 1,
  ram: 32, cpuMem: 'ddr5', offload: false,
  runtime: 'ollama', ctx: 8192, users: 1, kv: 'f16', spec: 'auto', think: 'default',
  sizeLo: 0, sizeHi: SIZE_STOPS.length - 1, priority: 40, archFilter: 'any', must: '', kwh: 0.2,
  lang: '', commercial: false, hideGated: false, uncensored: false, officialOnly: false, sort: 'best',
};
// short URL keys so a configuration can be shared
const KEYS = { use: 'u', agent: 'ag', ragPart: 'rp', hw: 'hw', gpu: 'g', customVram: 'cv', customBw: 'cb', ngpu: 'n', gpu2: 'g2', ngpu2: 'n2', chip: 'ch', mac: 'mm', unified: 'uf', nunits: 'nu',
  ram: 'r', cpuMem: 'cm', offload: 'of', runtime: 'rt', ctx: 'c', users: 'us', kv: 'kv', spec: 'sp', think: 'th', sizeLo: 'lo', sizeHi: 'hi', priority: 'pr', archFilter: 'af', must: 'mu', kwh: 'kw', lang: 'l',
  commercial: 'co', hideGated: 'hg', uncensored: 'un', officialOnly: 'oo', sort: 's' };

let A = null;
let state = { ...DEFAULT };
let shown = PAGE;
let compare = new Set();
const cardOpts = new Map(); // model id → per-model options from the Customize panel
const openCfg = new Set(); // model ids whose Customize panel is open
let ctxBeforeAgents = null; // context before picking Agents raised it
const cardCmds = new Map(); // run-tab contents per card, drawn on demand
const favUi = { open: false, editing: null, confirm: null, msg: '', shared: null }; // saved-compose panel state
let els = {};

/* --------------------------------------------------------------- formatting */

const gb = (x) => (x == null ? '–' : x < 10 ? `${x.toFixed(1)} GB` : `${Math.round(x)} GB`);
const bill = (p) => (p == null ? '?' : p >= 1 ? `${p >= 100 ? Math.round(p) : +p.toFixed(1)}B` : `${Math.round(p * 1000)}M`);
const sizeLabel = (v) => (v >= 1 ? `${v}B` : `${Math.round(v * 1000)}M`);
const ctxLabel = (v) => (v >= 1048576 ? `${+(v / 1048576).toFixed(1)}M` : `${Math.round(v / 1024)}K`);
/** "Reads a 16K prompt in ≈ 4 s": prompts of half the window (at most 32K), the usual size for agents and RAG. */
function ttftText(pp, ctx) {
  const prompt = Math.min(32768, Math.max(1024, 2 ** Math.round(Math.log2(ctx / 2))));
  const t = prompt / pp;
  return `Reads a ${ctxLabel(prompt)}-token prompt in ≈ ${t < 1 ? '<1' : t < 10 ? t.toFixed(1) : int(Math.round(t))} s (${int(Math.round(pp / 10) * 10)} tokens/s)`;
}
const tps = (x) => (x == null ? '–' : x >= 200 ? '200+' : x >= 10 ? `${Math.round(x)}` : x.toFixed(1));

/* --------------------------------------------------------------- state <-> URL */

function readParams(params) {
  const s = { ...DEFAULT };
  for (const [k, short] of Object.entries(KEYS)) {
    const v = params.get(short);
    if (v == null) continue;
    const d = DEFAULT[k];
    s[k] = typeof d === 'boolean' ? v === '1' : typeof d === 'number' ? +v : v;
  }
  return sanitize(s);
}

/** Make any state (from a shared link, a preset or old URLs) valid and coherent. */
function sanitize(input) {
  const s = { ...input };
  const oneOf = (v, list, d) => (list.includes(v) ? v : d);
  const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  if (s.hw === 'unified') { s.hw = 'gpu'; s.gpu = UNIFIED.some((u) => u.id === s.unified) ? s.unified : 'dgx-spark'; s.ngpu = s.nunits || 1; } // old links
  s.use = oneOf(s.use, USES.map((u) => u.v), DEFAULT.use);
  s.agent = oneOf(s.agent, AGENT_KINDS.map((k) => k.v), DEFAULT.agent);
  s.ragPart = oneOf(s.ragPart, ['both', 'embed', 'rerank'], 'both');
  s.hw = oneOf(s.hw, ['gpu', 'mac', 'cpu'], 'gpu');
  s.gpu = s.gpu === 'custom' || gpuById(s.gpu) ? s.gpu : DEFAULT.gpu;
  s.customVram = num(s.customVram, 1, 1024, 16);
  s.customBw = num(s.customBw, 20, 20000, 500);
  const g = gpuById(s.gpu);
  const maxUnits = g?.unified ? (g.cluster || 1) : 8;
  s.ngpu = num(Math.round(s.ngpu), 1, maxUnits, 1);
  // a second, different card: same vendor, discrete GPUs only
  const g2 = gpuById(s.gpu2);
  s.gpu2 = g && g2 && !g.unified && !g2.unified && g2.vendor === g.vendor && g2.id !== g.id && s.hw === 'gpu' ? g2.id : '';
  s.ngpu2 = s.gpu2 ? num(Math.round(s.ngpu2), 1, 8, 1) : 1;
  s.chip = MAC_CHIPS.some((c) => c.id === s.chip) ? s.chip : DEFAULT.chip;
  const sizes = MAC_CHIPS.find((c) => c.id === s.chip).sizes;
  if (!sizes.includes(+s.mac)) s.mac = sizes.find((x) => x >= +s.mac) || sizes[sizes.length - 1];
  s.ram = RAM_SIZES.includes(+s.ram) ? +s.ram : DEFAULT.ram;
  s.cpuMem = oneOf(s.cpuMem, CPU_MEMORY.map((c) => c.id), DEFAULT.cpuMem);
  if (g?.unified || s.hw !== 'gpu') s.offload = false;
  s.runtime = oneOf(s.runtime, ['any', ...Object.keys(RUNTIMES)], DEFAULT.runtime);
  if (s.runtime === 'mlx' && s.hw !== 'mac') s.runtime = s.hw === 'cpu' ? 'ollama' : 'any';
  if (['vllm', 'sglang'].includes(s.runtime) && s.hw !== 'gpu') s.runtime = s.hw === 'mac' ? 'mlx' : 'ollama';
  s.ctx = CTX_STOPS.includes(+s.ctx) ? +s.ctx : DEFAULT.ctx;
  s.users = USER_STOPS.includes(+s.users) ? +s.users : DEFAULT.users;
  s.kv = oneOf(s.kv, ['f16', 'q8', 'q4'], 'f16');
  s.spec = oneOf(s.spec, ['auto', 'off'], 'auto');
  s.think = oneOf(s.think, ['default', 'on', 'off'], 'default');
  s.sizeLo = num(Math.round(s.sizeLo), 0, SIZE_STOPS.length - 1, 0);
  s.sizeHi = num(Math.round(s.sizeHi), 0, SIZE_STOPS.length - 1, SIZE_STOPS.length - 1);
  if (s.sizeLo > s.sizeHi) [s.sizeLo, s.sizeHi] = [s.sizeHi, s.sizeLo];
  s.priority = num(Math.round(s.priority / 10) * 10, 0, 100, DEFAULT.priority);
  s.archFilter = oneOf(s.archFilter, ['any', 'dense', 'moe'], 'any');
  s.kwh = Math.round(num(s.kwh, 0.01, 2, 0.2) * 100) / 100;
  s.must = String(s.must || '').split(',').filter((x) => MUST.some(([k]) => k === x)).join(',');
  s.lang = oneOf(s.lang, ['', ...LANGS], '');
  s.sort = oneOf(s.sort, ['best', 'quality', 'fast'], 'best');
  return s;
}
function writeHash() {
  const p = new URLSearchParams();
  for (const [k, short] of Object.entries(KEYS)) {
    if (state[k] === DEFAULT[k]) continue;
    p.set(short, typeof state[k] === 'boolean' ? (state[k] ? '1' : '0') : String(state[k]));
  }
  const qs = p.toString();
  history.replaceState(null, '', `#advisor${qs ? `?${qs}` : ''}`);
}

/* --------------------------------------------------------------- form */

/** A small "?" next to a label that explains the term (tooltip on hover, focus or tap). */
const help = (key) => `<button type="button" class="term help" data-term="${key}" aria-describedby="tooltip" aria-label="What is ${esc(GLOSSARY[key]?.[0] || key)}?">?</button>`;
const option = (v, label, sel) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(label)}</option>`;

function formHtml() {
  return `
  <div class="presets-block">
    <p class="presets-label" id="hw-presets-label">Quick start with a typical machine</p>
    <div class="presets" role="group" aria-labelledby="hw-presets-label">${PRESETS.map((p, i) => `<button type="button" class="preset" data-preset="${i}">${esc(p.label)}</button>`).join('')}</div>
  </div>
  <form class="advisor-form" id="advisor-form" onsubmit="return false">
    <fieldset class="step">
      <legend><span class="step-n">1</span> What will you use it for?</legend>
      <div class="use-grid">${USES.map((u) => `<label class="use-option"><input type="radio" name="use" value="${u.v}"><span class="use-label">${esc(u.label)}</span><span class="use-hint">${esc(u.hint)}</span></label>`).join('')}</div>
      <div class="sub-step" data-show="agents">
        <p class="sub-label">What kind of agent?</p>
        <div class="use-grid compact">${AGENT_KINDS.map((k) => `<label class="use-option"><input type="radio" name="agent" value="${k.v}"><span class="use-label">${esc(k.label)}</span><span class="use-hint">${esc(k.hint)}</span></label>`).join('')}</div>
      </div>
      <div class="sub-step" data-show="rag">
        <p class="sub-label">Which part of the search pipeline?</p>
        <div class="segmented pill-switch" role="radiogroup" aria-label="RAG component">
          <label><input type="radio" name="ragPart" value="both"> Both</label>
          <label><input type="radio" name="ragPart" value="embed"> Embedding models</label>
          <label><input type="radio" name="ragPart" value="rerank"> Rerankers</label>
        </div>
      </div>
    </fieldset>

    <fieldset class="step">
      <legend><span class="step-n">2</span> Your hardware</legend>
      <div class="segmented pill-switch" role="radiogroup" aria-label="Hardware type">
        <label><input type="radio" name="hw" value="gpu"> Graphics card(s)</label>
        <label><input type="radio" name="hw" value="mac"> Apple Silicon Mac</label>
        <label><input type="radio" name="hw" value="cpu"> CPU only</label>
      </div>
      <div class="filters">
        <div class="field wide2" data-hw="gpu"><label for="a-gpu">Graphics card or machine</label>
          <select id="a-gpu" name="gpu">${GPU_GROUPS.map((g) => `<optgroup label="${esc(g.group)}">${g.items.map((x) => option(x.id, x.unified ? `${x.name} · ~${Math.round(x.mem)} GB usable` : `${x.name} · ${x.mem} GB`, state.gpu)).join('')}</optgroup>`).join('')}${option('custom', 'Other: enter VRAM and bandwidth', state.gpu)}</select></div>
        <div class="field" data-hw="custom"><label for="a-cv">VRAM per card (GB)</label><input type="text" inputmode="decimal" id="a-cv" name="customVram"></div>
        <div class="field" data-hw="custom"><label for="a-cb">Bandwidth (GB/s)</label><input type="text" inputmode="decimal" id="a-cb" name="customBw"></div>
        <div class="field" data-hw="gpu"><label for="a-ngpu" id="a-ngpu-label">Number of cards</label>
          <select id="a-ngpu" name="ngpu"></select></div>
        <div class="field wide2" data-hw="mix"><label for="a-gpu2">Plus a different card <span class="muted">(optional)</span></label>
          <select id="a-gpu2" name="gpu2"></select></div>
        <div class="field" data-hw="mix2"><label for="a-ngpu2">How many of those</label>
          <select id="a-ngpu2" name="ngpu2">${[1, 2, 3, 4].map((n) => option(n, n === 1 ? '1 card' : `${n} cards`, 1)).join('')}</select></div>
        <div class="field" data-hw="mac"><label for="a-chip">Chip</label>
          <select id="a-chip" name="chip">${MAC_CHIPS.map((c) => option(c.id, `${c.name} · ${c.bw} GB/s`, state.chip)).join('')}</select></div>
        <div class="field" data-hw="mac"><label for="a-mac">Unified memory</label>
          <select id="a-mac" name="mac"></select></div>
        <div class="field" data-hw="ram"><label for="a-ram">System RAM</label>
          <select id="a-ram" name="ram">${RAM_SIZES.map((g) => option(g, `${g} GB`, state.ram)).join('')}</select></div>
        <div class="field" data-hw="ram"><label for="a-cm">RAM type</label>
          <select id="a-cm" name="cpuMem">${CPU_MEMORY.map((c) => option(c.id, c.name, state.cpuMem)).join('')}</select></div>
      </div>
      <div class="detect-row"><button type="button" class="btn" id="a-detect">Detect my GPU</button><span class="note" id="a-detect-out" role="status"></span></div>
      <p class="note hw-note" id="hw-note"></p>
      <label class="inline-check" data-hw="offload"><input type="checkbox" name="offload"> Let big models overflow into system RAM (Ollama / llama.cpp). Bigger models, much slower.</label>
    </fieldset>

    <details class="adv" id="a-adv">
      <summary><span class="adv-title">More settings</span> <span class="adv-sum" id="a-adv-sum"></span></summary>
    <fieldset class="step">
      <legend><span class="step-n">3</span> How you will run it</legend>
      <div class="filters">
        <div class="field"><label for="a-runtime">Runtime</label> ${help('runtime')}
          <select id="a-runtime" name="runtime">${option('any', 'No preference', state.runtime)}${Object.entries(RUNTIMES).map(([k, r]) => option(k, r.label, state.runtime)).join('')}</select></div>
        <div class="field" data-llm><label for="a-spec">Speculative decoding</label> ${help('speculative')}
          <select id="a-spec" name="spec">${option('auto', 'Use when available', state.spec)}${option('off', 'Off', state.spec)}</select></div>
        <div class="field" data-llm><label for="a-think">Thinking (hybrid models)</label> ${help('thinking')}
          <select id="a-think" name="think">${option('default', 'Model default', state.think)}${option('on', 'On', state.think)}${option('off', 'Off: answer directly', state.think)}</select></div>
        <div class="field" data-llm><label for="a-kv">KV cache precision</label> ${help('kvcache')}
          <select id="a-kv" name="kv">${option('f16', '16-bit (default)', state.kv)}${option('q8', '8-bit: half the memory', state.kv)}${option('q4', '4-bit: least memory', state.kv)}</select></div>
      </div>
      <p class="note" data-llm id="spec-note"></p>
      <div class="slider-field" data-llm>
        <div class="slider-head"><span><label for="a-ctx">Context window</label> ${help('context')}</span><output id="o-ctx"></output></div>
        <input type="range" id="a-ctx" name="ctxIdx" min="0" max="${CTX_STOPS.length - 1}" step="1">
        <div class="ticks">${CTX_STOPS.map((c) => `<span>${ctxLabel(c)}</span>`).join('')}</div>
        <p class="note">How much text the model sees at once: a long chat, a big document or a codebase. Longer context needs more memory.</p>
      </div>
      <div class="slider-field" data-llm>
        <div class="slider-head"><label for="a-users">Users at the same time</label><output id="o-users"></output></div>
        <input type="range" id="a-users" name="usersIdx" min="0" max="${USER_STOPS.length - 1}" step="1">
        <div class="ticks">${USER_STOPS.map((u) => `<span>${u}</span>`).join('')}</div>
        <p class="note">Serving a team? Each simultaneous conversation needs its own context memory. vLLM and SGLang handle many users best.</p>
      </div>
    </fieldset>

    <fieldset class="step">
      <legend><span class="step-n">4</span> Preferences</legend>
      <div class="slider-field">
        <div class="slider-head"><span class="label" id="size-label">Model size</span><output id="o-size"></output></div>
        <div class="dual-range" role="group" aria-labelledby="size-label">
          <div class="dual-track"><span class="dual-fill" id="size-fill"></span></div>
          <input type="range" id="a-lo" name="sizeLo" min="0" max="${SIZE_STOPS.length - 1}" step="1" aria-label="Smallest model size">
          <input type="range" id="a-hi" name="sizeHi" min="0" max="${SIZE_STOPS.length - 1}" step="1" aria-label="Largest model size">
        </div>
        <div class="ticks size-ticks">${['100M', '1B', '3B', '8B', '14B', '32B', '70B', '235B', '1T'].map((t) => `<span>${t}</span>`).join('')}</div>
        <p class="note">Number of ${term('parameters', 'parameters')}. Drag both ends to set the range you want.</p>
      </div>
      <div class="slider-field" data-llm>
        <div class="slider-head"><label for="a-pr">Quality or speed?</label><output id="o-pr"></output></div>
        <input type="range" id="a-pr" name="priority" min="0" max="100" step="10">
        <div class="ticks two"><span>Best answers</span><span>Balanced</span><span>Fastest replies</span></div>
      </div>
      <div class="sub-block" data-llm>
        <p class="sub-label"><span id="arch-label">Architecture</span> ${help('moe')}</p>
        <div class="segmented pill-switch" role="radiogroup" aria-labelledby="arch-label">
          <label><input type="radio" name="archFilter" value="any"> Any</label>
          <label><input type="radio" name="archFilter" value="dense"> Dense only</label>
          <label><input type="radio" name="archFilter" value="moe"> Mixture of experts only</label>
        </div>
        <p class="sub-label" style="margin-top:12px">Must have</p>
        <div class="checks">${MUST.map(([k, l]) => `<label class="chip-toggle"><input type="checkbox" name="must" value="${k}">${esc(l)}</label>`).join('')}</div>
      </div>
      <div class="filters">
        <div class="field" data-llm><label for="a-kwh">Electricity price ($ per kWh)</label>
          <input type="number" id="a-kwh" name="kwh" min="0.01" max="2" step="0.01" inputmode="decimal"></div>
        <div class="field"><label for="a-lang">Language</label>
          <select id="a-lang" name="lang">${option('', 'Any', state.lang)}${LANGS.map((l) => option(l, language(l), state.lang)).join('')}</select></div>
      </div>
      <div class="checks">
        <label><input type="checkbox" name="commercial"> I need commercial use</label>
        <label><input type="checkbox" name="officialOnly"> Only models from the original labs</label>
        <label><input type="checkbox" name="hideGated"> Hide gated models</label>
        <label><input type="checkbox" name="uncensored"> Include uncensored variants</label>
      </div>
    </fieldset>
    </details>
    <div class="form-actions"><button type="button" class="btn" id="a-share">Copy link to these settings</button><button type="button" class="btn" id="a-reset">Start over</button><span class="note" id="a-shared" role="status" aria-live="polite"></span></div>
  </form>`;
}

function syncForm() {
  const f = els.form;
  const check = (name, v) => { const x = f.querySelector(`input[name="${name}"][value="${v}"]`); if (x) x.checked = true; };
  check('use', state.use); check('agent', state.agent); check('ragPart', state.ragPart); check('hw', state.hw);
  f.gpu.value = state.gpu; f.customVram.value = state.customVram; f.customBw.value = state.customBw;
  // options that depend on the hardware: units for unified machines, memory sizes for the Mac chip
  const g = gpuById(state.gpu);
  const units = g?.unified ? (g.cluster || 1) : 8;
  f.ngpu.innerHTML = (g?.unified ? [1, 2].slice(0, units) : [1, 2, 3, 4, 6, 8]).map((n) => option(n, g?.unified ? (n === 1 ? '1 unit' : `${n} units linked`) : (n === 1 ? '1 card' : `${n} cards`), state.ngpu)).join('');
  els.ngpuLabel.textContent = g?.unified ? 'Units' : 'Number of cards';
  // second card: same vendor, discrete only
  f.gpu2.innerHTML = option('', 'None', state.gpu2) + GPU_GROUPS.filter((grp) => !grp.items[0]?.unified)
    .map((grp) => ({ ...grp, items: grp.items.filter((x) => g && x.vendor === g.vendor && x.id !== g.id) }))
    .filter((grp) => grp.items.length)
    .map((grp) => `<optgroup label="${esc(grp.group)}">${grp.items.map((x) => option(x.id, `${x.name} · ${x.mem} GB`, state.gpu2)).join('')}</optgroup>`).join('');
  f.ngpu2.value = String(state.ngpu2);
  f.chip.value = state.chip;
  f.mac.innerHTML = MAC_CHIPS.find((c) => c.id === state.chip).sizes.map((x) => option(x, `${x} GB`, state.mac)).join('');
  f.ram.value = String(state.ram); f.cpuMem.value = state.cpuMem;
  f.offload.checked = state.offload; f.runtime.value = state.runtime; f.kv.value = state.kv; f.spec.value = state.spec; f.think.value = state.think;
  check('archFilter', state.archFilter);
  const must = state.must.split(',');
  f.querySelectorAll('input[name="must"]').forEach((x) => { x.checked = must.includes(x.value); });
  f.ctxIdx.value = String(Math.max(0, CTX_STOPS.indexOf(state.ctx)));
  f.usersIdx.value = String(Math.max(0, USER_STOPS.indexOf(state.users)));
  f.sizeLo.value = String(state.sizeLo); f.sizeHi.value = String(state.sizeHi); f.priority.value = String(state.priority);
  f.lang.value = state.lang; f.kwh.value = String(state.kwh); f.commercial.checked = state.commercial; f.officialOnly.checked = state.officialOnly;
  f.hideGated.checked = state.hideGated; f.uncensored.checked = state.uncensored;
  decorate();
}

function readForm(changed) {
  const f = els.form;
  const val = (n) => f.querySelector(`input[name="${n}"]:checked`)?.value;
  const prevUse = state.use, prevAgent = state.agent;
  let lo = +f.sizeLo.value, hi = +f.sizeHi.value;
  if (lo > hi) { if (changed === 'sizeLo') hi = lo; else lo = hi; }
  state = {
    ...state,
    use: val('use') || 'chat', agent: val('agent') || 'coding', ragPart: val('ragPart') || 'both', hw: val('hw') || 'gpu',
    gpu: f.gpu.value, gpu2: changed === 'gpu' ? '' : f.gpu2.value, ngpu2: +f.ngpu2.value, customVram: Math.max(1, parseFloat(f.customVram.value) || 8), customBw: Math.max(20, parseFloat(f.customBw.value) || 400),
    ngpu: changed === 'gpu' ? 1 : +f.ngpu.value, chip: f.chip.value, mac: +f.mac.value,
    ram: +f.ram.value, cpuMem: f.cpuMem.value, offload: f.offload.checked, runtime: f.runtime.value, kv: f.kv.value, spec: f.spec.value, think: f.think.value,
    archFilter: val('archFilter') || 'any', must: [...f.querySelectorAll('input[name="must"]:checked')].map((x) => x.value).join(','),
    ctx: CTX_STOPS[+f.ctxIdx.value], users: USER_STOPS[+f.usersIdx.value], sizeLo: lo, sizeHi: hi, priority: +f.priority.value,
    kwh: parseFloat(f.kwh.value) || 0.2, lang: f.lang.value, commercial: f.commercial.checked, officialOnly: f.officialOnly.checked, hideGated: f.hideGated.checked, uncensored: f.uncensored.checked,
  };
  // Picking an agent type sets a sensible context for it (still adjustable).
  if (state.use === 'agents' && (prevUse !== 'agents' || prevAgent !== state.agent) && (changed === 'use' || changed === 'agent')) {
    if (prevUse !== 'agents') ctxBeforeAgents = state.ctx;
    state.ctx = Math.max(state.ctx, agentKind(state.agent).ctx);
  } else if (changed === 'use' && prevUse === 'agents' && ctxBeforeAgents != null) {
    state.ctx = ctxBeforeAgents; // the agent's longer context was not the visitor's choice
    ctxBeforeAgents = null;
  }
  if (changed === 'ctxIdx') ctxBeforeAgents = null;
  // Runtimes that cannot work on the chosen hardware, Mac memory sizes that do not exist for the chip, etc.
  state = sanitize(state);
  syncForm();
}

function decorate() {
  const f = els.form;
  const s = state;
  const isLLM = LLM_USES.has(s.use);
  f.querySelectorAll('[data-show]').forEach((x) => { x.hidden = x.dataset.show !== s.use; });
  f.querySelectorAll('[data-hw]').forEach((x) => {
    const k = x.dataset.hw;
    const uni = s.hw === 'gpu' && gpuById(s.gpu)?.unified;
    x.hidden = !(k === s.hw || (k === 'custom' && s.hw === 'gpu' && s.gpu === 'custom') || (k === 'ram' && ((s.hw === 'gpu' && !uni) || s.hw === 'cpu'))
      || (k === 'offload' && s.hw === 'gpu' && !uni)
      || (k === 'mix' && s.hw === 'gpu' && !uni && s.gpu !== 'custom')
      || (k === 'mix2' && s.hw === 'gpu' && !!s.gpu2));
  });
  f.querySelectorAll('[data-llm]').forEach((x) => { x.hidden = !isLLM; });
  [...f.runtime.options].forEach((o) => {
    o.disabled = (o.value === 'mlx' && s.hw !== 'mac') || (['vllm', 'sglang'].includes(o.value) && (s.hw === 'cpu' || s.hw === 'mac'));
  });
  const g = s.hw === 'gpu' ? gpuById(s.gpu) : null;
  els.hwNote.textContent = g?.unified ? g.note : s.hw === 'mac' ? 'MLX is usually the fastest way to run models on a Mac; Ollama and LM Studio also work well.' : '';
  els.hwNote.hidden = !els.hwNote.textContent;
  const specNote = f.querySelector('#spec-note');
  specNote.textContent = s.spec === 'off' ? ''
    : ['vllm', 'sglang'].includes(s.runtime) ? 'Speculative decoding: uses a DFlash2 / DFlash / DSpark / EAGLE-3 draft model or the model’s built-in MTP heads when one exists; typically 1.5–2.5× faster for one user.'
      : s.runtime === 'llamacpp' ? 'Speculative decoding in llama.cpp: MTP with MTP-preserving GGUF builds (single user, text only), or DFlash2 GGUF drafts with a build that supports them.'
        : s.runtime === 'any' ? 'Speculative decoding is applied with vLLM / SGLang / llama.cpp when a draft or MTP heads exist.'
          : 'This runtime does not do speculative decoding; pick vLLM, SGLang or llama.cpp for it.';
  specNote.hidden = !specNote.textContent || !isLLM;
  // slider readouts
  const lo = SIZE_STOPS[s.sizeLo], hi = SIZE_STOPS[s.sizeHi];
  const full = s.sizeLo === 0 && s.sizeHi === SIZE_STOPS.length - 1;
  els.o.size.textContent = full ? 'Any size' : s.sizeHi === SIZE_STOPS.length - 1 ? `${sizeLabel(lo)} and up` : s.sizeLo === 0 ? `Up to ${sizeLabel(hi)}` : `${sizeLabel(lo)} – ${sizeLabel(hi)}`;
  const max = SIZE_STOPS.length - 1;
  els.sizeFill.style.left = `${(s.sizeLo / max) * 100}%`;
  els.sizeFill.style.right = `${100 - (s.sizeHi / max) * 100}%`;
  els.o.ctx.textContent = `${ctxLabel(s.ctx)} tokens ≈ ${s.ctx >= 1048576 ? '750K' : int(Math.round(s.ctx * 0.75 / 100) * 100)} words`;
  els.o.users.textContent = s.users === 1 ? 'Just me' : `${s.users} at once`;
  els.o.pr.textContent = s.priority <= 20 ? 'Best answers' : s.priority >= 80 ? 'Fastest replies' : s.priority < 50 ? 'Leaning to quality' : s.priority > 50 ? 'Leaning to speed' : 'Balanced';
  // what "More settings" holds right now, readable while it is closed
  const filters = [s.archFilter !== 'any', !!s.must, !!s.lang, s.commercial, s.officialOnly, s.hideGated, s.uncensored].filter(Boolean).length;
  els.advSum.textContent = [isLLM && (s.runtime === 'any' ? 'Any runtime' : RUNTIMES[s.runtime]?.label), isLLM && `${ctxLabel(s.ctx)} context`, isLLM && (s.users > 1 ? `${s.users} users` : '1 user'),
    els.o.size.textContent, isLLM && els.o.pr.textContent, filters && `${filters} filter${filters > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
}

/* --------------------------------------------------------------- results */

/** Customize panel: per-model settings that rewrite this card's commands and estimates. */
function cfgHtml(r, o, b) {
  const { m, kind } = r;
  const isLLM = LLM_USES.has(state.use);
  if (!isLLM) return '';
  const think = thinkingOf({ ...m, reasoning: r.reasoning });
  const server = kind === 'st';
  const sel = (k, label, opts, hint = '') => `<label class="cfg-field"><span>${esc(label)}</span><select data-k="${k}">${opts.map(([v, l]) => option(v, l, o[k])).join('')}</select>${hint ? `<small>${hint}</small>` : ''}</label>`;
  const chk = (k, label, hint = '') => `<label class="cfg-check"><input type="checkbox" data-k="${k}"${o[k] ? ' checked' : ''}> ${esc(label)}${hint ? ` <small>${hint}</small>` : ''}</label>`;
  const txt = (k, label, ph, hint = '') => `<label class="cfg-field"><span>${esc(label)}</span><input type="text" data-k="${k}" value="${esc(o[k] ?? '')}" placeholder="${esc(ph)}" spellcheck="false">${hint ? `<small>${hint}</small>` : ''}</label>`;
  const specs = r.specs || [];
  const fields = [];
  fields.push(specs.length
    ? sel('spec', 'Speculative decoding', [['off', 'Off'], ...specs.map((x) => [x.method, `${x.label}${x.draft ? ` · ${x.draft.split('/')[0]}` : ''}`])])
    : `<p class="cfg-note">No speculative option for this model on ${esc(RUNTIMES[r.rt]?.label || 'this runtime')}${['ollama', 'lmstudio', 'mlx'].includes(r.rt) ? ' (switch the runtime to vLLM, SGLang or llama.cpp)' : ''}.</p>`);
  if (o.spec !== 'off' && specs.length) fields.push(sel('specTokens', 'Speculative tokens', [1, 2, 3, 4, 5, 6, 7, 8, 10, 12].map((n) => [n, String(n)]), 'More tokens help when drafts are often right.'));
  if (think?.mode === 'hybrid') fields.push(sel('think', 'Thinking', [['default', 'Model default (on)'], ['on', 'On'], ['off', 'Off: answer directly']]));
  else if (think?.mode === 'effort') fields.push(sel('think', 'Reasoning effort', [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High (best answers)']]));
  else if (think?.mode === 'always') fields.push('<p class="cfg-note">This model always thinks before answering.</p>');
  if (think && (think.vllmParser || think.sglangParser) && server) fields.push(chk('reasoningParser', 'Separate the thinking from the answer', '(reasoning parser)'));
  const ctxStops = CTX_STOPS.filter((c) => !m.mc || c <= m.mc);
  if (m.mc && !ctxStops.includes(m.mc)) ctxStops.push(m.mc);
  fields.push(sel('ctx', 'Context window', ctxStops.map((c) => [c, `${ctxLabel(c)} tokens`]), m.mc ? `This model handles up to ${ctxLabel(m.mc)}.` : ''));
  fields.push(sel('users', 'Users at once', USER_STOPS.map((u) => [u, String(u)])));
  fields.push(sel('kv', 'KV cache', [['f16', '16-bit'], ['q8', '8-bit'], ['q4', '4-bit']]));
  if (server) {
    fields.push(`<label class="cfg-field"><span>GPU memory for the server</span><input type="range" data-k="gpuUtil" min="0.5" max="0.95" step="0.05" value="${o.gpuUtil}"><small>${Math.round(o.gpuUtil * 100)}% of ${b.kind === 'unified' ? 'unified memory (leave room for the OS)' : 'VRAM'} · weights + KV cache</small></label>`);
    fields.push(chk('prefixCache', 'Prefix caching', '(reuses shared prompt prefixes)'));
    if ((m.a || m.moe) && b.n > 1) fields.push(chk('expertParallel', 'Expert parallelism', '(spread MoE experts across GPUs)'));
  }
  fields.push(chk('tools', 'Tool calling'));
  fields.push(`<label class="cfg-field"><span>Port</span><input type="number" min="1" max="65535" data-k="port" value="${esc(o.port ?? '')}" placeholder="default"></label>`);
  fields.push(txt('servedName', 'Model name in the API', m.id.split('/').pop().toLowerCase()));
  fields.push(chk('apiKey', 'Require an API key'));
  fields.push(txt('imageTag', 'Docker image tag', 'latest', 'Pin a version for reproducible deploys.'));
  fields.push(chk('restart', 'Restart automatically'));
  fields.push(chk('healthcheck', 'Health check'));
  fields.push('<p class="cfg-note"><strong>Full stack compose</strong></p>');
  fields.push(chk('stackUi', 'Open WebUI chat interface', '(port 3000)'));
  fields.push(chk('stackRag', 'Embeddings + reranker for documents', '(TEI)'));
  return `<div class="cfg" data-cfg-for="${esc(m.id)}">
    <div class="cfg-grid">${fields.join('')}</div>
    <button type="button" class="btn cfg-reset">Reset to recommended</button>
  </div>`;
}

function resultCard(r, i) {
  const s = state;
  const b = els.lastBudget;
  const { m } = r;
  const isLLMCard = LLM_USES.has(s.use);
  const custom = cardOpts.get(m.id);
  const o = { ...defaultOptions(r, s, b), ...(custom || {}) };
  const specObj = o.spec === 'off' ? null : (r.specs || []).find((x) => x.method === o.spec) || null;
  // Per-model settings change memory and speed: recompute with the same quantization.
  const fit = custom && isLLMCard ? refit(r, { ...s, ctx: +o.ctx, users: +o.users, kv: o.kv }, b, specObj) : { ...r.fit, fits: true };
  const [author, ...rest] = m.id.split('/');
  const isLLM = LLM_USES.has(s.use);
  // the repository you would actually download for this setup
  const dl = r.kind === 'gguf' ? m.gguf : r.kind === 'mlx' ? m.mlx : fit.repo;
  const pool = fit.where === 'gpu' ? (b.fast || b.slow) : b.fast + b.slow;
  const used = fit.need ? Math.min(100, (fit.need.total / pool) * 100) : null;
  const status = !fit.fits ? ['bad', 'Does not fit with these settings: lower the context, users or KV precision']
    : fit.where === 'split' ? ['warn', 'Part of it runs from system RAM']
    : fit.where === 'moe-cpu' ? ['warn', 'Experts in system RAM, the rest on the GPU']
    : fit.where === 'cpu' && b.kind !== 'cpu' ? ['warn', 'Runs on the CPU']
      : used > 92 ? ['tight', 'Fits, but tight'] : ['ok', 'Fits comfortably'];
  const sp = fit.tps != null ? speedLabel(fit.tps) : null;
  const lf = LICENSE_FAMILY[m.lf];
  const cmds = commandsFor(r, state, b, A.caps, custom, r.specs, isLLMCard ? stackPicks() : null);
  cardCmds.set(`cmd-${i}`, cmds); // other tabs are drawn when opened
  const id = `cmd-${i}`;
  return `<article class="advice" data-id="${esc(m.id)}">
    <div class="advice-head">
      <span class="advice-rank">${i + 1}</span>
      <div class="advice-title">
        <h3><a href="${esc(hfUrl(m.id))}" rel="noopener"><span class="author">${esc(author)}/</span>${esc(rest.join('/'))}</a></h3>
        ${dl && dl !== m.id ? `<p class="repo-line">Download: <a href="${esc(hfUrl(dl))}" rel="noopener"><code>${esc(dl)}</code></a> <span class="muted">(${esc(fit.quant)} build of this model)</span></p>` : ''}
        <div class="chips">
          <span class="chip">${esc(task(m.task))}</span>
          ${m.p ? `<span class="chip">${bill(m.p)}${m.a ? ` · ${m.a}B active` : ''}</span>` : ''}
          <span class="chip ${m.lf === 'oss' ? 'ok' : m.lf === 'non-commercial' ? 'nc' : ''}" title="${esc(m.lic || '')}">${esc(lf.short)}</span>
          ${(m.caps >> A.caps.indexOf('tools')) & 1 ? '<span class="chip">Tool calling</span>' : ''}
          ${fit.spec ? `<span class="chip ok">${esc(fit.spec.label)}</span>` : m.mtp ? '<span class="chip">MTP heads</span>' : ''}
          ${m.gated ? '<span class="chip gated">Gated</span>' : ''}
        </div>
      </div>
      <div class="advice-actions">
        <label class="compare-check"><input type="checkbox" data-compare="${esc(m.id)}"${compare.has(m.id) ? ' checked' : ''}> Compare</label>
        ${isLLMCard ? `<button type="button" class="btn cfg-toggle" aria-expanded="${openCfg.has(m.id)}">${custom ? 'Customized ✓' : 'Customize'}</button>` : ''}
      </div>
    </div>
    ${m.ev || m.mteb ? `<p class="note evals" title="Numbers the model's developers published on its model card; they are not measured by this site and are not comparable across different test setups">Reported by its developers: ${[...(m.ev || []).map(([d, metric, v]) => `${esc(d)}${metric ? ` · ${esc(metric)}` : ''} <strong>${v}</strong>`), m.mteb ? `MTEB results on ${m.mteb >= 50 ? '50+' : m.mteb} tasks (see the model card)` : ''].filter(Boolean).join(' · ')}</p>` : ''}
    ${isLLMCard && openCfg.has(m.id) ? cfgHtml(r, o, b) : ''}
    <div class="advice-metrics">
      <div class="metric fit-${status[0]}">
        <span class="metric-label">Memory</span>
        <span class="metric-value">${fit.need ? `≈ ${gb(fit.need.total)}` : 'small'}</span>
        <span class="metric-sub">${isLLM ? term('quantlevel', fit.quant) : esc(fit.quant)}${isLLM && fit.need ? ` · ${gb(fit.need.weights)} weights + ${gb(fit.need.kv)} context${fit.need.draft ? ` + ${gb(fit.need.draft)} ${fit.spec?.draft ? 'draft' : 'MTP'}` : ''}` : ''}${fit.where === 'moe-cpu' && fit.need?.ram ? ` · ${gb(fit.need.gpu)} on the GPU, ${gb(fit.need.ram)} of experts in RAM` : ''}</span>
        ${used != null ? `<div class="meter" role="img" aria-label="Uses about ${Math.round(used)}% of your memory"><span style="width:${used.toFixed(1)}%"></span></div>` : ''}
        <span class="metric-status">${status[1]}</span>
      </div>
      ${isLLM && sp ? `<div class="metric speed-${sp[0]}">
        ${+o.users > 1 ? `<span class="metric-label">Throughput for ${o.users} users ${help('tps')}</span>
        <span class="metric-value">${int(Math.round(fit.tps * o.users))} <small>tokens/s in total</small></span>
        <span class="metric-sub">≈ ${tps(fit.tps)} tokens/s for each user (≈ ${int(Math.round(fit.tps * 0.75 * 60))} words per minute)${fit.spec ? ` · ${tps(fit.tpsBase)} without ${esc(fit.spec.label)}` : ''}</span>`
    : `<span class="metric-label">Speed (estimate) ${help('tps')}</span>
        <span class="metric-value">${tps(fit.tps)} <small>tokens/s</small></span>
        <span class="metric-sub">≈ ${int(Math.round(fit.tps * 0.75 * 60))} words per minute${fit.spec ? ` · ${tps(fit.tpsBase)} without ${esc(fit.spec.label)}` : ''}</span>`}
        ${measuredHtml(m)}
        ${fit.pp ? `<span class="metric-sub" title="Time to first token: reading the prompt is limited by compute (TFLOPS), not memory bandwidth">${ttftText(fit.pp, +o.ctx)}</span>` : ''}
        <span class="metric-status">${sp[1]}</span>
      </div>` : ''}
      <div class="metric">
        <span class="metric-label">Download</span>
        <span class="metric-value">${fit.download ? `≈ ${gb(fit.download)}` : '–'}</span>
        <span class="metric-sub">${compact(m.dl)} downloads/month · ${int(m.likes)} likes</span>
        ${isLLM ? costHtml(m, fit, b, +o.users) : ''}
      </div>
    </div>
    ${fit.low ? '<p class="note warn-note">This quantization loses noticeable quality; a smaller model at higher precision may answer better.</p>' : ''}
    ${cmds.length ? `<div class="run">
      <div class="run-tabs" role="tablist" aria-label="Ways to run ${esc(m.id)}">${cmds.map((c, k) => `<button type="button" role="tab" class="run-tab" id="${id}-${k}-tab" data-tab="${id}-${k}" aria-controls="${id}-${k}" aria-selected="${k === 0}" tabindex="${k === 0 ? 0 : -1}">${esc(c.label)}</button>`).join('')}</div>
      ${cmds.map((c, k) => (k ? `<div class="run-panel" role="tabpanel" id="${id}-${k}" aria-labelledby="${id}-${k}-tab" hidden data-lazy></div>` : `<div class="run-panel" role="tabpanel" id="${id}-${k}" aria-labelledby="${id}-${k}-tab">${panelHtml(c)}</div>`)).join('')}
    </div>` : ''}
    ${r.why.length ? `<ul class="why">${r.why.slice(0, 5).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${r.parts ? scoreHtml(r, i) : ''}
  </article>`;
}

/** A published or community measurement of this model on this exact machine, when one exists. */
function measuredHtml(m) {
  const hw = state.hw === 'mac' ? state.chip : state.gpu;
  const r = (m.meas || []).find((x) => x.hw === hw);
  if (!r) return '';
  return `<span class="metric-sub measured">Measured here: ${tps(r.tg)} tokens/s${r.pp ? ` · prompt ${int(Math.round(r.pp))} tokens/s` : ''} <span class="muted">(${esc(r.rt)}${r.q ? ` ${esc(r.q)}` : ''}, <a href="${esc(r.src)}" rel="noopener">source</a>)</span></span>`;
}

/** Running cost here (electricity) next to what the same model costs through an API, per million tokens. */
function costHtml(m, fit, b, users) {
  const e = energyPerMillion(fit, b, users, state.kwh);
  if (e == null && !m.api) return '';
  const money = (x) => (x < 0.01 ? '<$0.01' : x < 10 ? `$${x.toFixed(2)}` : `$${Math.round(x)}`);
  return `<span class="metric-sub cost" title="Electricity at $${state.kwh}/kWh (change it in More settings): the machine's power while generating. The API price is OpenRouter's for this exact model, output tokens.">${e != null ? `≈ ${money(e)} of electricity per million tokens` : ''}${m.api ? `${e != null ? ' · ' : ''}API: ${money(m.api)} per million output tokens` : ''}</span>`;
}

/** One run tab: the code with Copy / Download / Save, and its note. Copy and Download read the code from the page. */
function panelHtml(c) {
  const lines = c.code ? c.code.split('\n').length : 0;
  return `${c.code ? `<div class="code-row"><pre${lines > 22 ? ' class="long"' : ''}><code>${esc(c.code)}</code>${lines > 22 ? `<button type="button" class="btn code-more">Show all ${lines} lines</button>` : ''}</pre><div class="code-actions"><button type="button" class="btn copy">Copy</button>${c.yaml ? `<button type="button" class="btn dl">Download</button><button type="button" class="btn fav-save" data-label="${esc(c.label)}" title="Keep this compose in your saved list to edit or reuse later">☆ Save</button>` : ''}</div></div>` : ''}
        ${c.note ? `<p class="note">${c.note}</p>` : ''}`;
}

/** Show a run tab, drawing its panel the first time. */
function activateTab(run, tab) {
  run.querySelectorAll('.run-tab').forEach((t) => { t.setAttribute('aria-selected', String(t === tab)); t.tabIndex = t === tab ? 0 : -1; });
  run.querySelectorAll('.run-panel').forEach((p) => {
    p.hidden = p.id !== tab.dataset.tab;
    if (!p.hidden && p.hasAttribute('data-lazy')) {
      const [, i, k] = /^(cmd-\d+)-(\d+)$/.exec(p.id) || [];
      const c = cardCmds.get(i)?.[+k];
      if (c) p.innerHTML = panelHtml(c);
      p.removeAttribute('data-lazy');
    }
  });
}

/** "Why #3": every term of the ranking score, as signed bars. */
function scoreHtml(r, i) {
  const rows = r.parts.filter(([, v]) => Math.abs(v) >= 0.05);
  const max = Math.max(...rows.map(([, v]) => Math.abs(v)), 1);
  return `<details class="score">
    <summary>Why it ranks #${i + 1}: score ${r.score.toFixed(1)}</summary>
    <ul class="score-list">${rows.map(([label, v]) => `<li class="${v < 0 ? 'neg' : 'pos'}"><span class="score-label">${esc(label)}</span><span class="score-bar"><span style="width:${((Math.abs(v) / max) * 100).toFixed(1)}%"></span></span><span class="score-val">${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}</span></li>`).join('')}</ul>
    <p class="note">Higher is better. The quality ↔ speed slider changes how much answer quality and speed weigh; your filters decide which models take part.</p>
  </details>`;
}

/** Re-render one card in place (after a Customize change), keeping its open tab. */
function rerenderCard(id) {
  const i = (els.lastList || []).findIndex((r) => r.m.id === id);
  const el = els.results.querySelector(`.advice[data-id="${CSS.escape(id)}"]`);
  if (i < 0 || !el) return;
  const tab = el.querySelector('.run-tab[aria-selected="true"]')?.textContent;
  const focusKey = document.activeElement?.closest?.('.cfg') ? document.activeElement.dataset.k : null;
  el.outerHTML = resultCard(els.lastList[i], i);
  const fresh = els.results.querySelector(`.advice[data-id="${CSS.escape(id)}"]`);
  const t = [...fresh.querySelectorAll('.run-tab')].find((x) => x.textContent === tab);
  if (t) activateTab(fresh.querySelector('.run'), t);
  if (focusKey) fresh.querySelector(`.cfg [data-k="${focusKey}"]`)?.focus();
}

function readCfg(panel) {
  const o = {};
  panel.querySelectorAll('[data-k]').forEach((x) => {
    const k = x.dataset.k;
    if (x.type === 'checkbox') o[k] = x.checked;
    else if (['ctx', 'users', 'specTokens'].includes(k)) o[k] = +x.value;
    else if (k === 'gpuUtil') o[k] = +(+x.value).toFixed(2);
    else if (k === 'port') o[k] = x.value ? Math.min(65535, Math.max(1, Math.round(+x.value) || 0)) || null : null;
    else if (k === 'servedName') o[k] = x.value.trim().replace(/[^\w.\-/:]/g, '-').slice(0, 80);
    else if (k === 'imageTag') o[k] = x.value.trim().replace(/[^\w.\-]/g, '').slice(0, 64) || 'latest';
    else o[k] = x.value;
  });
  return o;
}

function summaryHtml(b) {
  const s = state;
  const isLLM = LLM_USES.has(s.use);
  const kind = runtimeKinds(s)[0];
  const cap = isLLM ? capacity(kind, s, b) : [];
  return `<div class="budget">
    <div><p class="eyebrow">Your setup</p><p class="budget-main">${esc(b.label)}</p><p class="note">${esc(b.detail)}</p>
      ${isLLM && b.kind !== 'mac' && b.kind !== 'cpu' && ['vllm', 'sglang', 'any'].includes(s.runtime) ? `<p class="note"><strong>Best GPU-server formats here:</strong> ${b.arch === 'blackwell' ? 'NVFP4 (native FP4 tensor cores) and FP8' : ['hopper', 'ada', 'cdna3', 'cdna4'].includes(b.arch) ? 'FP8 (native), AWQ / GPTQ for 4-bit' : 'INT8 and AWQ / GPTQ 4-bit (no FP8 hardware)'}${b.arch === 'blackwell' ? '; MXFP4 for gpt-oss' : ''}.</p>` : ''}</div>
    ${isLLM ? `<div><p class="eyebrow">Biggest model that fits ${b.fast ? 'fully in fast memory' : ''} · ${ctxLabel(s.ctx)} context${s.users > 1 ? ` × ${s.users} users` : ''}</p>
      <ul class="cap-list">${cap.map(([n, p]) => `<li><span>${esc(n)}</span><strong>${p >= 1 ? `≈ ${p >= 10 ? Math.round(p) : p.toFixed(1)}B` : '< 1B'}</strong></li>`).join('')}</ul>
      ${finetuneHtml(b)}</div>` : ''}
  </div>
  ${isLLM ? `<div class="upgrade">
    <button type="button" class="btn" id="a-upgrade" aria-expanded="false">What would a better machine run?</button>
    <div id="a-upgrade-out" hidden></div>
  </div>` : ''}`;
}

/** Biggest model this machine can fine-tune (Unsloth-style estimates). */
function finetuneHtml(b) {
  const ft = finetuneCapacity(b);
  if (!ft || b.kind === 'cpu') return '';
  const size = (p) => (p >= 1 ? `≈ ${p >= 10 ? Math.round(p) : p.toFixed(1)}B` : '< 1B');
  return `<p class="note finetune" title="Short sequences, batch 1–2, with Unsloth-style memory savings; longer sequences need more">Fine-tuning here: QLoRA up to <strong>${size(ft.qlora)}</strong> · LoRA <strong>${size(ft.lora)}</strong> · full <strong>${size(ft.full)}</strong></p>`;
}

/** The machines that would run a better model for the same job, cheapest first (launch prices). */
function upgradeHtml(rows) {
  if (!rows.length) return '<p class="note">No single card or unified-memory machine with a launch price runs a clearly better model for these settings.</p>';
  return `<div class="table-wrap"><table class="upgrade-table">
    <thead><tr><th scope="col">Machine</th><th scope="col">Launch price</th><th scope="col">Best model there</th><th scope="col">Speed</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr><th scope="row">${esc(r.gpu.name)} <span class="muted">· ${Math.round(r.gpu.mem)} GB</span></th><td>$${int(r.price)}</td>
      <td><a href="${esc(hfUrl(r.top.m.id))}" rel="noopener">${esc(r.top.m.id.split('/').pop())}</a> <span class="muted">${esc(r.top.fit.quant)}</span></td>
      <td>${tps(r.top.fit.tps)} tok/s</td><td><button type="button" class="btn" data-try-gpu="${esc(r.gpu.id)}">Try it</button></td></tr>`).join('')}</tbody>
  </table></div>
  <p class="note">Each step up is the cheapest machine (US launch price) that runs a clearly better model for the same job and settings. Used cards and street prices vary.</p>`;
}

function agentTipsHtml() {
  if (state.use !== 'agents') return '';
  const k = agentKind(state.agent);
  return `<div class="agent-tips">
    <p class="eyebrow">${esc(k.label)}</p>
    <p>${esc(k.advice)}</p>
    <p class="note"><strong>Frameworks that work with local models:</strong> ${k.frameworks.map((f) => `<a href="${esc(f.url)}" rel="noopener">${esc(f.name)}</a> <span class="muted">(${esc(f.what)})</span>`).join(' · ')}</p>
  </div>`;
}

function compareHtml(list) {
  const rows = [...compare].map((id) => list.find((r) => r.m.id === id)).filter(Boolean);
  if (rows.length < 2) return rows.length ? '<p class="note">Tick “Compare” on one more model to compare them side by side.</p>' : '';
  const isLLM = LLM_USES.has(state.use);
  const line = (label, f) => `<tr><th scope="row">${esc(label)}</th>${rows.map((r) => `<td>${f(r)}</td>`).join('')}</tr>`;
  return `<div class="card compare-card">
    <div class="card-head"><h2>Side by side</h2><button type="button" class="btn" id="a-clear-compare">Clear</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th></th>${rows.map((r) => `<th scope="col">${esc(r.m.id)}</th>`).join('')}</tr></thead>
      <tbody>
        ${line('Size', (r) => `${bill(r.m.p)}${r.m.a ? ` (${r.m.a}B active)` : ''}`)}
        ${line('Quantization', (r) => esc(r.fit.quant))}
        ${line('Download repo', (r) => `<code>${esc(r.kind === 'gguf' ? r.m.gguf || '–' : r.kind === 'mlx' ? r.m.mlx || '–' : r.fit.repo)}</code>`)}
        ${isLLM ? line('Speculative', (r) => (r.fit.spec ? esc(r.fit.spec.label) : '–')) : ''}
        ${line('Memory', (r) => (r.fit.need ? gb(r.fit.need.total) : '–'))}
        ${isLLM ? line('Speed', (r) => `${tps(r.fit.tps)} tok/s`) : ''}
        ${line('Download', (r) => (r.fit.download ? gb(r.fit.download) : '–'))}
        ${line('License', (r) => esc(r.m.lic || LICENSE_FAMILY[r.m.lf].label))}
        ${line('Downloads / month', (r) => compact(r.m.dl))}
        ${line('Tool calling', (r) => ((r.m.caps >> A.caps.indexOf('tools')) & 1 ? 'Tagged' : '–'))}
        ${line('Languages', (r) => esc(r.m.lang.slice(0, 5).map(language).join(', ') || '–'))}
      </tbody>
    </table></div>
  </div>`;
}

function refresh(resetPage = true) {
  if (resetPage) { shown = PAGE; cardOpts.clear(); openCfg.clear(); }
  writeHash();
  const lang = state.lang ? language(state.lang) : '';
  const { budget, list, total } = recommend(A, { ...state, langName: lang });
  els.lastBudget = budget;
  els.lastList = list;
  els.summary.innerHTML = summaryHtml(budget);
  els.tips.innerHTML = agentTipsHtml();
  els.sorts.hidden = !LLM_USES.has(state.use);
  els.sorts.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sort === state.sort)));
  const use = USES.find((u) => u.v === state.use);
  const what = state.use === 'agents' ? agentKind(state.agent).label.toLowerCase() : use.label.toLowerCase();
  els.count.textContent = list.length ? `${int(total)} models fit your setup. Showing the top ${Math.min(shown, list.length)} for ${what}.` : '';
  els.results.innerHTML = list.length
    ? list.slice(0, shown).map(resultCard).join('')
    : emptyHtml();
  els.more.hidden = list.length <= shown;
  els.compare.innerHTML = compareHtml(list);
  if (!els.favs.firstChild) renderFavs(); // drawn once; fav actions redraw it (and never mid-edit)
}

/* --------------------------------------------------------------- full stack */

/**
 * Retrieval models for the "Full stack" compose: the advisor's own top embedding model and reranker
 * for this machine (small ones, they share the GPU or run on the CPU). Cached per machine.
 */
function stackPicks() {
  const key = JSON.stringify([state.hw, state.gpu, state.ngpu, state.gpu2, state.chip, state.mac, state.ram, state.lang]);
  if (stackPicks.key === key) return stackPicks.val;
  const small = SIZE_STOPS.indexOf(1); // up to 1B parameters
  // TEI loads safetensors / PyTorch weights, not GGUF or ONNX-only uploads
  const pick = (part) => recommend(A, sanitize({ ...state, use: 'rag', ragPart: part, runtime: 'any', sizeLo: 0, sizeHi: small, must: '', archFilter: 'any', commercial: true, hideGated: true }))
    .list.find((x) => x.m.st && !/gguf|onnx|openvino|mlx/i.test(x.m.id))?.m.id || null;
  stackPicks.key = key;
  stackPicks.val = { embed: pick('embed'), rerank: pick('rerank') };
  return stackPicks.val;
}

/* --------------------------------------------------------------- nothing fits */

/** Try relaxing one setting at a time and offer the ones that bring results back. */
function emptyHtml() {
  const s = state;
  const tries = [
    s.must && ['Remove the must-have filters', { must: '' }],
    s.archFilter !== 'any' && ['Allow both dense and MoE models', { archFilter: 'any' }],
    (s.sizeLo > 0 || s.sizeHi < SIZE_STOPS.length - 1) && ['Any model size', { sizeLo: 0, sizeHi: SIZE_STOPS.length - 1 }],
    s.ctx > 8192 && [`Context ${ctxLabel(Math.max(8192, s.ctx / 4))} instead of ${ctxLabel(s.ctx)}`, { ctx: Math.max(8192, s.ctx / 4) }],
    s.ctx > 32768 && s.kv === 'f16' && [`32K context with an 8-bit KV cache`, { ctx: 32768, kv: 'q8' }],
    s.users > 1 && ['One user at a time', { users: 1 }],
    s.kv === 'f16' && ['8-bit KV cache', { kv: 'q8' }],
    s.hw === 'gpu' && !gpuById(s.gpu)?.unified && !s.offload && ['Allow overflow into system RAM', { offload: true }],
    s.runtime !== 'any' && ['Any runtime', { runtime: 'any' }],
    (s.commercial || s.hideGated || s.officialOnly) && ['Drop the license / gated / official filters', { commercial: false, hideGated: false, officialOnly: false }],
    s.lang && ['Any language', { lang: '' }],
  ].filter(Boolean);
  els.fixes = [];
  const lang = s.lang ? language(s.lang) : '';
  const found = tries.map(([label, patch]) => [label, patch, recommend(A, sanitize({ ...s, ...patch, langName: lang })).total])
    .filter((x) => x[2] > 0).sort((a, b) => b[2] - a[2]).slice(0, 5);
  els.fixes = found.map((x) => x[1]);
  // say why, with numbers: usually the context cache or the smallest size allowed
  const b = els.lastBudget;
  const pool = b ? b.fast || b.slow : 0;
  const kv = LLM_USES.has(s.use) ? memNeeded(8, 0.6, s).kv : 0;
  const smallest = SIZE_STOPS[s.sizeLo];
  const cause = !pool ? ''
    : kv > pool * 0.5 ? `${ctxLabel(s.ctx)} of context${s.users > 1 ? ` for ${s.users} users` : ''} alone needs ≈ ${gb(kv)} for an 8B model, and your machine has ≈ ${gb(pool)} for models.`
      : s.sizeLo > 0 && smallest * 0.6 > pool ? `Even at 4-bit, a ${sizeLabel(smallest)} model needs ≈ ${gb(smallest * 0.6)}, and your machine has ≈ ${gb(pool)} for models.` : '';
  return `<div class="empty">
    <p><strong>Nothing fits these settings.</strong>${cause ? ` ${esc(cause)}` : ''}</p>
    ${found.length ? `<p>Changing one thing brings models back:</p>
      <div class="fix-list">${found.map(([label, , n], i) => `<button type="button" class="btn fix" data-fix="${i}">${esc(label)} <span class="muted">→ ${int(n)} models</span></button>`).join('')}</div>`
    : '<p>Try a bigger machine, a smaller context or fewer filters.</p>'}
  </div>`;
}

/* --------------------------------------------------------------- saved composes */

const shortRuntime = (label) => label.replace(/\s*\(Docker Compose\)/, '').replace(' (pip)', '');
const when = (t) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function favHtml(f) {
  const editing = favUi.editing === f.id;
  const issues = editing ? lintCompose(f.yaml) : [];
  return `<li class="fav" data-fav="${esc(f.id)}">
    <div class="fav-head">
      <input class="fav-name" type="text" value="${esc(f.name)}" aria-label="Name of this saved compose" maxlength="120" spellcheck="false">
      ${isEdited(f) ? '<span class="chip">Edited</span>' : ''}
    </div>
    <p class="note fav-meta"><a href="${esc(hfUrl(f.model))}" rel="noopener">${esc(f.model)}</a> · ${esc(shortRuntime(f.runtime))}${f.machine ? ` · ${esc(f.machine)}` : ''} · ${f.updatedAt > f.savedAt + 1000 ? 'edited' : 'saved'} ${esc(when(f.updatedAt))}</p>
    ${editing ? `<div class="fav-editor">
        <label class="sr-only" for="fe-${esc(f.id)}">Compose file</label>
        <textarea id="fe-${esc(f.id)}" class="fav-text" spellcheck="false" rows="${Math.min(40, f.yaml.split('\n').length + 2)}">${esc(f.yaml)}</textarea>
        <label class="fav-note-field"><span>Notes</span><input type="text" class="fav-note" value="${esc(f.note)}" placeholder="What this setup is for, what to change next…" maxlength="2000"></label>
        ${issues.length ? `<ul class="fav-lint">${issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <div class="fav-actions">
          <button type="button" class="btn btn-primary" data-fav-act="save">Save changes</button>
          <button type="button" class="btn" data-fav-act="cancel">Cancel</button>
          ${isEdited(f) ? '<button type="button" class="btn" data-fav-act="restore">Restore the generated version</button>' : ''}
        </div>
      </div>`
    : `${f.note ? `<p class="fav-notes">${esc(f.note)}</p>` : ''}
      <details class="fav-preview"><summary>Show the file</summary><pre><code>${esc(f.yaml)}</code></pre></details>
      <div class="fav-actions">
        <button type="button" class="btn" data-fav-act="edit">Edit</button>
        ${f.params ? '<button type="button" class="btn" data-fav-act="open" title="Load the machine and settings it was made with, and its Customize options">Open in the advisor</button>' : ''}
        <button type="button" class="btn" data-fav-act="copy">Copy</button>
        <button type="button" class="btn" data-fav-act="share" title="A link that carries this compose and its settings: whoever opens it can save it">Share link</button>
        <a class="btn" download="${esc(f.name.replace(/[^\w.-]+/g, '-').toLowerCase() || 'docker-compose')}.yml" href="data:text/yaml;charset=utf-8,${encodeURIComponent(f.yaml)}">Download</a>
        <button type="button" class="btn danger" data-fav-act="delete">${favUi.confirm === f.id ? 'Click again to delete' : 'Delete'}</button>
      </div>`}
  </li>`;
}

function renderFavs() {
  // Replacing the list blurs a focused name field, whose change event would render again mid-way.
  if (renderFavs.busy) return;
  renderFavs.busy = true;
  try { drawFavs(); } finally { renderFavs.busy = false; }
}
function drawFavs() {
  const list = loadFavorites();
  // nothing saved yet: no empty panel in the way (it appears with the first ☆ Save or a shared link)
  if (!list.length && !favUi.shared && !favUi.msg) { els.favs.innerHTML = ''; return; }
  const keep = persistent();
  els.favs.innerHTML = `<details class="card favs"${favUi.open ? ' open' : ''}>
    <summary><span class="favs-title">★ Saved composes</span> <span class="count-pill">${list.length}</span></summary>
    ${favUi.msg ? `<p class="note fav-msg" role="status">${esc(favUi.msg)}</p>` : ''}
    ${favUi.shared ? `<div class="fav-shared" role="region" aria-label="Shared compose">
      <p><strong>Shared with you:</strong> “${esc(favUi.shared.name)}” · <a href="${esc(hfUrl(favUi.shared.model))}" rel="noopener">${esc(favUi.shared.model)}</a> · ${esc(shortRuntime(favUi.shared.runtime))}${favUi.shared.machine ? ` · ${esc(favUi.shared.machine)}` : ''}</p>
      ${favUi.shared.note ? `<p class="fav-notes">${esc(favUi.shared.note)}</p>` : ''}
      <details class="fav-preview"><summary>Show the file</summary><pre><code>${esc(favUi.shared.yaml)}</code></pre></details>
      <div class="fav-actions"><button type="button" class="btn btn-primary" data-fav-act="shared-save">Save to my composes</button><button type="button" class="btn" data-fav-act="shared-dismiss">Dismiss</button></div>
    </div>` : ''}
    ${list.length ? `<ul class="fav-list">${list.map(favHtml).join('')}</ul>`
      : '<p class="note">Press <strong>☆ Save</strong> under any Docker Compose file to keep it here. You can rename it, edit the YAML and reopen it later with the same settings.</p>'}
    <div class="fav-tools">
      ${list.length ? '<button type="button" class="btn" data-fav-act="export">Export all (JSON)</button>' : ''}
      <label class="btn">Import<input type="file" accept="application/json,.json" class="fav-import" hidden></label>
      <span class="note">${keep ? 'Kept in this browser only: export them to back up or move to another device.' : 'Your browser is blocking storage here, so saved composes last until you close this page: export them to keep them.'}</span>
    </div>
  </details>`;
}

function favFlash(msg, redraw = true) {
  favUi.msg = msg;
  if (redraw) renderFavs();
  else {
    let el = els.favs.querySelector('.fav-msg');
    if (!el) { el = Object.assign(document.createElement('p'), { className: 'note fav-msg' }); el.setAttribute('role', 'status'); els.favs.querySelector('summary').after(el); }
    el.textContent = msg;
  }
  clearTimeout(favFlash.t);
  favFlash.t = setTimeout(() => { favUi.msg = ''; if (els.favs.querySelector('.fav-msg')) els.favs.querySelector('.fav-msg').remove(); }, 5000);
}

function saveFromCard(btn) {
  const card = btn.closest('.advice');
  const id = card.dataset.id;
  const code = btn.closest('.code-row').querySelector('pre code').textContent;
  const label = btn.dataset.label;
  const short = id.split('/').pop();
  const f = addFavorite({
    name: `${short} · ${shortRuntime(label)}`,
    model: id, runtime: label, machine: els.lastBudget?.label || '',
    yaml: code, generated: code,
    params: location.hash.split('?')[1] || '',
    opts: cardOpts.get(id) || null,
  });
  favUi.open = true;
  btn.textContent = '★ Saved';
  favFlash(`Saved “${f.name}”.`);
}

/** Load a saved compose's settings back into the advisor and show its card. */
function openFavorite(f) {
  state = readParams(new URLSearchParams(f.params));
  syncForm();
  refresh();
  let i = els.lastList.findIndex((r) => r.m.id === f.model);
  if (i < 0) { favFlash(`${f.model} is no longer recommended for these settings (the data changes every day); the saved file is unchanged.`); return; }
  if (i >= shown) { shown = Math.ceil((i + 1) / PAGE) * PAGE; refresh(false); i = els.lastList.findIndex((r) => r.m.id === f.model); }
  if (f.opts) cardOpts.set(f.model, f.opts);
  openCfg.add(f.model);
  rerenderCard(f.model);
  const card = els.results.querySelector(`.advice[data-id="${CSS.escape(f.model)}"]`);
  const t = [...card.querySelectorAll('.run-tab')].find((x) => x.textContent === f.runtime);
  if (t) t.click();
  card.classList.add('flash');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => card.classList.remove('flash'), 2000);
}

async function onFavClick(e) {
  if (e.target.closest('summary')) { favUi.open = !e.target.closest('details').open; return; }
  const btn = e.target.closest('[data-fav-act]');
  if (!btn) return;
  const act = btn.dataset.favAct;
  if (act === 'export') {
    const url = URL.createObjectURL(new Blob([exportFavorites()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'hf-observatory-composes.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (act === 'shared-save' && favUi.shared) {
    const { id: _ignored, ...rest } = favUi.shared;
    const f = addFavorite(rest);
    favUi.shared = null;
    favFlash(`Saved “${f.name}” to your composes.`);
    return;
  }
  if (act === 'shared-dismiss') { favUi.shared = null; renderFavs(); return; }
  const li = btn.closest('.fav');
  const id = li?.dataset.fav;
  const f = loadFavorites().find((x) => x.id === id);
  if (!f) return;
  if (act !== 'delete') favUi.confirm = null;
  if (act === 'edit') { favUi.editing = id; renderFavs(); els.favs.querySelector('.fav-text')?.focus(); return; }
  if (act === 'cancel') { favUi.editing = null; renderFavs(); return; }
  if (act === 'restore') { li.querySelector('.fav-text').value = f.generated; return; }
  if (act === 'save') {
    const yaml = li.querySelector('.fav-text').value.replace(/\r\n/g, '\n');
    updateFavorite(id, { yaml, note: li.querySelector('.fav-note').value.trim() });
    const issues = lintCompose(yaml);
    favUi.editing = issues.length ? id : null;
    favFlash(issues.length ? 'Saved, but check the warnings below.' : 'Changes saved.');
    return;
  }
  if (act === 'open') { openFavorite(f); return; }
  if (act === 'share') {
    const url = `${location.origin}${location.pathname}#advisor?${f.params ? `${f.params}&` : ''}fav=${await packFavorite(f)}`;
    try { await navigator.clipboard.writeText(url); favFlash('Link copied: whoever opens it can save this compose.'); } catch { favFlash(url); }
    return;
  }
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(f.yaml); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
    return;
  }
  if (act === 'delete') {
    if (favUi.confirm !== id) { favUi.confirm = id; renderFavs(); return; }
    favUi.confirm = null;
    removeFavorite(id);
    favFlash(`Deleted “${f.name}”.`);
  }
}

/* --------------------------------------------------------------- GPU detection */

// WebGPU adapter architecture → the GPU list group to suggest (browsers rarely expose the exact model)
const ARCH_GROUP = { blackwell: 'RTX 50', lovelace: 'RTX 40', ada: 'RTX 40', ampere: 'RTX 30', turing: 'RTX 30 / 20', 'rdna-4': 'AMD', 'rdna-3': 'AMD', 'rdna-2': 'AMD' };

/** Ask the browser's WebGPU adapter what GPU this is; nothing leaves the page. */
async function detectGpu() {
  if (!navigator.gpu) return { msg: 'This browser does not expose WebGPU, so pick your card from the list.' };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const info = adapter?.info || (await adapter?.requestAdapterInfo?.()) || {};
    const vendor = (info.vendor || '').toLowerCase();
    const desc = (info.description || info.device || '').toLowerCase();
    if (vendor === 'apple' || /apple/.test(desc)) return { mac: true, msg: 'Apple Silicon detected: pick your chip and memory.' };
    // an exact name (some browsers give it), else the architecture family
    const exact = allGpus().filter((g) => !g.unified).find((g) => desc && desc.includes(g.name.toLowerCase()));
    if (exact) return { gpu: exact.id, msg: `Detected ${exact.name}.` };
    const arch = (info.architecture || '').toLowerCase();
    const label = [vendor && vendor[0].toUpperCase() + vendor.slice(1), arch].filter(Boolean).join(' ');
    return { msg: label ? `Detected an ${label} GPU (${ARCH_GROUP[arch] ? `${ARCH_GROUP[arch]} series` : 'model not shared by the browser'}): pick the exact card below.` : 'The browser did not share the GPU model: pick it from the list.' };
  } catch { return { msg: 'GPU detection failed: pick your card from the list.' }; }
}

/* --------------------------------------------------------------- render */

export async function render(section, params) {
  A = await load('advisor.json');
  state = readParams(params || new URLSearchParams());
  section.replaceChildren(pageHeader({
    id: 'h-advisor', eyebrow: 'Model advisor', title: 'What should I run on my hardware?',
    lead: `Tell us the job and the machine. We rank the open models that fit, choose the best ${term('quantization', 'quantization')} for each one, estimate memory and speed, and give you the exact command to run it.`,
    howTo: [
      `<strong>Memory</strong> = ${term('parameters', 'parameters')} × bytes per parameter for the quantization + the context cache (more context or more users = more memory) + ~0.5 GB.`,
      '<strong>Speed</strong> is estimated from your memory bandwidth: generating each word reads the whole active model once. Real speed varies ±30% with drivers, batch size and runtime.',
      '<strong>Mixture-of-experts</strong> models (e.g. “30B-A3B”) must fit entirely in memory but only use a few billion parameters per word, so they are much faster than their size suggests.',
      '<strong>Agents</strong>: pick the kind of agent to get models tagged and trained for that job, plus the frameworks and the right tool-calling settings.',
      'Your settings are saved in the page address: use “Copy link” to share them.',
    ],
  }));
  section.insertAdjacentHTML('beforeend', `
    <div class="advisor-layout">
      <div class="advisor-left">${formHtml()}</div>
      <section class="advisor-results" aria-labelledby="h-recs">
        <h2 id="h-recs" class="block-title">Recommendations</h2>
        <div id="a-summary"></div>
        <div id="a-tips"></div>
        <div class="filter-bar">
          <div class="segmented" role="group" aria-label="Order" id="a-sorts">
            <button type="button" data-sort="best">Best match</button>
            <button type="button" data-sort="quality">Highest quality</button>
            <button type="button" data-sort="fast">Fastest</button>
          </div>
        </div>
        <p class="result-count" id="a-count" role="status" aria-live="polite"></p>
        <div id="a-favs"></div>
        <div id="a-compare"></div>
        <div id="a-results" class="advice-list"></div>
        <div class="more-row" id="a-more" hidden><button type="button" class="btn btn-primary" id="a-more-btn">Show more</button></div>
        <p class="note">Based on the models tracked by the dataset and their public metadata. Estimates are approximate; check each model card for recommended settings and license terms.</p>
      </section>
    </div>
    <button type="button" class="btn btn-primary jump-results" id="a-jump" hidden>See recommendations ↓</button>`);

  els = {
    form: section.querySelector('#advisor-form'),
    summary: section.querySelector('#a-summary'),
    tips: section.querySelector('#a-tips'),
    sorts: section.querySelector('#a-sorts'),
    count: section.querySelector('#a-count'),
    compare: section.querySelector('#a-compare'),
    favs: section.querySelector('#a-favs'),
    results: section.querySelector('#a-results'),
    more: section.querySelector('#a-more'),
    hwNote: section.querySelector('#hw-note'),
    ngpuLabel: section.querySelector('#a-ngpu-label'),
    sizeFill: section.querySelector('#size-fill'),
    advSum: section.querySelector('#a-adv-sum'),
    o: { size: section.querySelector('#o-size'), ctx: section.querySelector('#o-ctx'), users: section.querySelector('#o-users'), pr: section.querySelector('#o-pr') },
  };
  // "More settings" stays as the visitor left it; a shared link with such settings opens it
  const adv = section.querySelector('#a-adv');
  const advKeys = ['runtime', 'spec', 'think', 'kv', 'ctx', 'users', 'sizeLo', 'sizeHi', 'priority', 'archFilter', 'must', 'lang', 'commercial', 'officialOnly', 'hideGated', 'uncensored'];
  let advOpen = false;
  try { advOpen = localStorage.getItem('hfo-advisor-adv') === '1'; } catch { /* storage blocked */ }
  adv.open = advOpen || advKeys.some((k) => params?.has(KEYS[k]));
  adv.addEventListener('toggle', () => { try { localStorage.setItem('hfo-advisor-adv', adv.open ? '1' : '0'); } catch { /* storage blocked */ } });
  syncForm();
  refresh();
  receiveShared(params);

  // Phones: a floating shortcut from the long form to the results, hidden once they are on screen.
  const jump = section.querySelector('#a-jump');
  const resultsEl = section.querySelector('.advisor-results');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([e]) => { jump.hidden = e.isIntersecting || section.hidden; }, { threshold: 0 });
    io.observe(resultsEl);
  }
  jump.addEventListener('click', () => resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' }));

  let timer;
  const onChange = (e) => {
    const name = e.target.name;
    if (!name) return;
    clearTimeout(timer);
    const run = () => { readForm(name); refresh(); };
    if (e.type === 'input' && ['customVram', 'customBw'].includes(name)) timer = setTimeout(run, 250);
    else if (e.type === 'input' && e.target.type === 'range') { readForm(name); timer = setTimeout(refresh, 60); } else run();
  };
  els.form.addEventListener('change', onChange);
  els.form.addEventListener('input', onChange);
  section.querySelector('.presets-block').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const p = PRESETS[+b.dataset.preset].state;
    state = sanitize({ ...state, offload: false, ngpu: 1, gpu2: '', ngpu2: 1, ...p, runtime: p.runtime || (p.hw === 'mac' ? 'mlx' : state.runtime === 'mlx' ? 'ollama' : state.runtime) });
    syncForm();
    b.setAttribute('aria-pressed', 'true');
    refresh();
  });
  els.sorts.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    state.sort = b.dataset.sort;
    refresh();
  });
  section.querySelector('#a-more-btn').addEventListener('click', () => { shown += PAGE; refresh(false); });
  section.querySelector('#a-detect').addEventListener('click', async () => {
    const out = section.querySelector('#a-detect-out');
    out.textContent = 'Asking the browser…';
    const d = await detectGpu();
    out.textContent = d.msg;
    if (d.gpu) { state = sanitize({ ...state, hw: 'gpu', gpu: d.gpu, ngpu: 1, gpu2: '' }); syncForm(); refresh(); }
    else if (d.mac) { state = sanitize({ ...state, hw: 'mac', runtime: state.runtime === 'vllm' || state.runtime === 'sglang' ? 'mlx' : state.runtime }); syncForm(); refresh(); }
  });
  section.querySelector('#a-reset').addEventListener('click', () => { state = sanitize({ ...DEFAULT }); compare.clear(); syncForm(); refresh(); });
  section.querySelector('#a-share').addEventListener('click', async () => {
    const out = section.querySelector('#a-shared');
    try { await navigator.clipboard.writeText(location.href); out.textContent = 'Link copied.'; } catch (err) { out.textContent = location.href; }
    setTimeout(() => { out.textContent = ''; }, 4000);
  });
  section.querySelector('.advisor-results').addEventListener('click', async (e) => {
    const tab = e.target.closest('.run-tab');
    if (tab) {
      activateTab(tab.closest('.run'), tab);
      return;
    }
    const more = e.target.closest('.code-more');
    if (more) { more.closest('pre').classList.remove('long'); more.remove(); return; }
    if (e.target.id === 'a-clear-compare') { compare.clear(); refresh(false); return; }
    const toggle = e.target.closest('.cfg-toggle');
    if (toggle) {
      const id = toggle.closest('.advice').dataset.id;
      if (openCfg.has(id)) openCfg.delete(id); else openCfg.add(id);
      rerenderCard(id);
      return;
    }
    if (e.target.closest('#a-favs')) { onFavClick(e); return; }
    const up = e.target.closest('#a-upgrade');
    if (up) {
      const out = section.querySelector('#a-upgrade-out');
      const open = up.getAttribute('aria-expanded') !== 'true';
      up.setAttribute('aria-expanded', String(open));
      out.hidden = !open;
      if (open) {
        out.innerHTML = '<p class="note">Comparing machines…</p>';
        setTimeout(() => { out.innerHTML = upgradeHtml(upgradeOptions(A, state, els.lastList?.[0], allGpus())); }, 30);
      }
      return;
    }
    const tryGpu = e.target.closest('[data-try-gpu]');
    if (tryGpu) { state = sanitize({ ...state, hw: 'gpu', gpu: tryGpu.dataset.tryGpu, ngpu: 1, gpu2: '' }); syncForm(); refresh(); els.results.scrollIntoView({ block: 'start' }); return; }
    const fix = e.target.closest('[data-fix]');
    if (fix) { state = sanitize({ ...state, ...els.fixes[+fix.dataset.fix] }); syncForm(); refresh(); return; }
    const save = e.target.closest('.fav-save');
    if (save) { saveFromCard(save); return; }
    const reset = e.target.closest('.cfg-reset');
    if (reset) {
      const id = reset.closest('.advice').dataset.id;
      cardOpts.delete(id);
      rerenderCard(id);
      return;
    }
    const dl = e.target.closest('.dl');
    if (dl) {
      const url = URL.createObjectURL(new Blob([dl.closest('.code-row').querySelector('code').textContent], { type: 'text/yaml' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'docker-compose.yml' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    const b = e.target.closest('.copy');
    if (!b) return;
    try { await navigator.clipboard.writeText(b.closest('.code-row').querySelector('code').textContent); b.textContent = 'Copied'; } catch (err) {
      const pre = b.closest('.code-row').querySelector('pre');
      const range = document.createRange(); range.selectNodeContents(pre);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      b.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { b.textContent = 'Copy'; }, 1800);
  });
  // Run tabs follow the ARIA tabs pattern: arrows / Home / End move between them
  section.querySelector('.advisor-results').addEventListener('keydown', (e) => {
    const tab = e.target.closest?.('.run-tab');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = [...tab.parentElement.querySelectorAll('.run-tab')];
    const i = tabs.indexOf(tab);
    const next = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    e.preventDefault();
    activateTab(tab.closest('.run'), next);
    next.focus();
  });
  // Customize panel: any change rewrites that card's estimates and commands
  let cfgTimer;
  const onCfg = (e) => {
    const panel = e.target.closest('.cfg');
    if (!panel || !e.target.dataset.k) return;
    const id = panel.dataset.cfgFor;
    const r = (els.lastList || []).find((x) => x.m.id === id);
    if (!r) return;
    const next = { ...defaultOptions(r, state, els.lastBudget), ...(cardOpts.get(id) || {}), ...readCfg(panel) };
    if (e.target.dataset.k === 'spec') next.specTokens = defaultSpecTokens(next.spec);
    cardOpts.set(id, next);
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => rerenderCard(id), e.type === 'input' && e.target.type === 'text' ? 400 : 0);
  };
  section.querySelector('.advisor-results').addEventListener('change', onCfg);
  section.querySelector('.advisor-results').addEventListener('input', (e) => { if (e.target.type === 'range' || e.target.type === 'text') onCfg(e); });
  section.querySelector('.advisor-results').addEventListener('change', async (e) => {
    if (e.target.classList.contains('fav-name')) {
      const name = e.target.value.trim() || 'Untitled compose';
      updateFavorite(e.target.closest('.fav').dataset.fav, { name });
      e.target.value = name;
      favFlash(`Renamed to “${name}”.`, false);
      return;
    }
    if (e.target.classList.contains('fav-import')) {
      const file = e.target.files[0];
      if (!file) return;
      try { const n = importFavorites(await file.text()); favUi.open = true; favFlash(n ? `Imported ${n} saved compose${n > 1 ? 's' : ''}.` : 'Nothing new to import.'); } catch (err) { favFlash(`Could not import: ${err.message}`); }
      return;
    }
    const id = e.target.dataset?.compare;
    if (!id) return;
    if (e.target.checked) {
      if (compare.size >= 3) { e.target.checked = false; return; }
      compare.add(id);
    } else compare.delete(id);
    els.compare.innerHTML = compareHtml(els.lastList || []);
  });
}

/** A link with ?fav= carries someone's saved compose: offer to save it. */
async function receiveShared(params) {
  const packed = params?.get('fav');
  if (!packed) return;
  try {
    favUi.shared = await unpackFavorite(packed);
    favUi.open = true;
    renderFavs();
    els.favs.scrollIntoView({ block: 'start' });
  } catch (err) { favUi.open = true; favFlash(`Could not read the shared compose: ${err.message}`); }
}

export function update(section, params) {
  if (!A) return;
  if (params?.get('fav')) { receiveShared(params); }
  const next = readParams(params);
  if (Object.keys(KEYS).every((k) => next[k] === state[k])) return;
  state = next;
  syncForm();
  refresh();
}
