import { load } from '../data.js';
import { compact, esc, hfUrl, int, language, LICENSE_FAMILY, task } from '../format.js';
import { term } from '../glossary.js';
import { pageHeader } from '../ui.js';
import { CPU_MEMORY, GPUS, MAC_CHIPS, PRESETS, RAM_SIZES, UNIFIED } from '../advisor/hardware.js';
import {
  AGENT_KINDS, CTX_STOPS, LLM_USES, QUANTS, RUNTIMES, SIZE_STOPS, TOOL_PARSERS, USER_STOPS, USES,
  agentKind, budgetOf, capacity, recommend, runtimeKinds, speedLabel,
} from '../advisor/engine.js';

const LANGS = ['en', 'es', 'zh', 'fr', 'de', 'ja', 'ko', 'pt', 'it', 'ru', 'ar', 'hi'];
const MAC_SIZES = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512];
const PAGE = 10;

const DEFAULT = {
  use: 'chat', agent: 'coding', ragPart: 'both',
  hw: 'gpu', gpu: 'rtx-4090', customVram: 16, customBw: 500, ngpu: 1, chip: 'm4-max', mac: 64, unified: 'dgx-spark', nunits: 1,
  ram: 32, cpuMem: 'ddr5', offload: false,
  runtime: 'ollama', ctx: 8192, users: 1, kv: 'f16',
  sizeLo: 0, sizeHi: SIZE_STOPS.length - 1, priority: 40,
  lang: '', commercial: false, hideGated: false, uncensored: false, officialOnly: false, sort: 'best',
};
// short URL keys so a configuration can be shared
const KEYS = { use: 'u', agent: 'ag', ragPart: 'rp', hw: 'hw', gpu: 'g', customVram: 'cv', customBw: 'cb', ngpu: 'n', chip: 'ch', mac: 'mm', unified: 'uf', nunits: 'nu',
  ram: 'r', cpuMem: 'cm', offload: 'of', runtime: 'rt', ctx: 'c', users: 'us', kv: 'kv', sizeLo: 'lo', sizeHi: 'hi', priority: 'pr', lang: 'l',
  commercial: 'co', hideGated: 'hg', uncensored: 'un', officialOnly: 'oo', sort: 's' };

let A = null;
let state = { ...DEFAULT };
let shown = PAGE;
let compare = new Set();
let els = {};

/* --------------------------------------------------------------- formatting */

const gb = (x) => (x == null ? '–' : x < 10 ? `${x.toFixed(1)} GB` : `${Math.round(x)} GB`);
const bill = (p) => (p == null ? '?' : p >= 1 ? `${p >= 100 ? Math.round(p) : +p.toFixed(1)}B` : `${Math.round(p * 1000)}M`);
const sizeLabel = (v) => (v >= 1 ? `${v}B` : `${Math.round(v * 1000)}M`);
const ctxLabel = (v) => (v >= 1048576 ? '1M' : `${v / 1024}K`);
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
        <label><input type="radio" name="hw" value="unified"> DGX Spark / unified memory</label>
        <label><input type="radio" name="hw" value="cpu"> CPU only</label>
      </div>
      <div class="filters">
        <div class="field" data-hw="gpu"><label for="a-gpu">Graphics card</label>
          <select id="a-gpu" name="gpu">${GPUS.map((g) => `<optgroup label="${esc(g.group)}">${g.items.map((x) => option(x.id, `${x.name} · ${x.mem} GB`, state.gpu)).join('')}</optgroup>`).join('')}${option('custom', 'Other: enter VRAM and bandwidth', state.gpu)}</select></div>
        <div class="field" data-hw="custom"><label for="a-cv">VRAM per card (GB)</label><input type="text" inputmode="decimal" id="a-cv" name="customVram"></div>
        <div class="field" data-hw="custom"><label for="a-cb">Bandwidth (GB/s)</label><input type="text" inputmode="decimal" id="a-cb" name="customBw"></div>
        <div class="field" data-hw="gpu"><label for="a-ngpu">Number of cards</label>
          <select id="a-ngpu" name="ngpu">${[1, 2, 3, 4, 6, 8].map((n) => option(n, n === 1 ? '1 card' : `${n} cards`, state.ngpu)).join('')}</select></div>
        <div class="field" data-hw="mac"><label for="a-chip">Chip</label>
          <select id="a-chip" name="chip">${MAC_CHIPS.map((c) => option(c.id, `${c.name} · ${c.bw} GB/s`, state.chip)).join('')}</select></div>
        <div class="field" data-hw="mac"><label for="a-mac">Unified memory</label>
          <select id="a-mac" name="mac">${MAC_SIZES.map((g) => option(g, `${g} GB`, state.mac)).join('')}</select></div>
        <div class="field wide2" data-hw="unified"><label for="a-unified">Machine</label>
          <select id="a-unified" name="unified">${UNIFIED.map((u) => option(u.id, u.name, state.unified)).join('')}</select></div>
        <div class="field" data-hw="cluster"><label for="a-nunits">Units linked</label>
          <select id="a-nunits" name="nunits">${option(1, '1 unit', state.nunits)}${option(2, '2 units (ConnectX-7 link)', state.nunits)}</select></div>
        <div class="field" data-hw="ram"><label for="a-ram">System RAM</label>
          <select id="a-ram" name="ram">${RAM_SIZES.map((g) => option(g, `${g} GB`, state.ram)).join('')}</select></div>
        <div class="field" data-hw="ram"><label for="a-cm">RAM type</label>
          <select id="a-cm" name="cpuMem">${CPU_MEMORY.map((c) => option(c.id, c.name, state.cpuMem)).join('')}</select></div>
      </div>
      <p class="note hw-note" id="hw-note"></p>
      <label class="inline-check" data-hw="gpu"><input type="checkbox" name="offload"> Let big models overflow into system RAM (Ollama / llama.cpp). Bigger models, much slower.</label>
    </fieldset>

    <fieldset class="step">
      <legend><span class="step-n">3</span> How you will run it</legend>
      <div class="filters">
        <div class="field"><label for="a-runtime">Runtime</label>
          <select id="a-runtime" name="runtime">${option('any', 'No preference', state.runtime)}${Object.entries(RUNTIMES).map(([k, r]) => option(k, r.label, state.runtime)).join('')}</select></div>
        <div class="field" data-llm><label for="a-kv">KV cache precision</label>
          <select id="a-kv" name="kv">${option('f16', '16-bit (default)', state.kv)}${option('q8', '8-bit: half the memory', state.kv)}${option('q4', '4-bit: least memory', state.kv)}</select></div>
      </div>
      <div class="slider-field" data-llm>
        <div class="slider-head"><label for="a-ctx">Context window</label><output id="o-ctx"></output></div>
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
      <div class="filters">
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
    <div class="form-actions"><button type="button" class="btn" id="a-share">Copy link to these settings</button><button type="button" class="btn" id="a-reset">Start over</button><span class="note" id="a-shared" role="status" aria-live="polite"></span></div>
  </form>`;
}

function syncForm() {
  const f = els.form;
  const check = (name, v) => { const x = f.querySelector(`input[name="${name}"][value="${v}"]`); if (x) x.checked = true; };
  check('use', state.use); check('agent', state.agent); check('ragPart', state.ragPart); check('hw', state.hw);
  f.gpu.value = state.gpu; f.customVram.value = state.customVram; f.customBw.value = state.customBw;
  f.ngpu.value = String(state.ngpu); f.chip.value = state.chip; f.mac.value = String(state.mac);
  f.unified.value = state.unified; f.nunits.value = String(state.nunits); f.ram.value = String(state.ram); f.cpuMem.value = state.cpuMem;
  f.offload.checked = state.offload; f.runtime.value = state.runtime; f.kv.value = state.kv;
  f.ctxIdx.value = String(Math.max(0, CTX_STOPS.indexOf(state.ctx)));
  f.usersIdx.value = String(Math.max(0, USER_STOPS.indexOf(state.users)));
  f.sizeLo.value = String(state.sizeLo); f.sizeHi.value = String(state.sizeHi); f.priority.value = String(state.priority);
  f.lang.value = state.lang; f.commercial.checked = state.commercial; f.officialOnly.checked = state.officialOnly;
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
    gpu: f.gpu.value, customVram: Math.max(1, parseFloat(f.customVram.value) || 8), customBw: Math.max(20, parseFloat(f.customBw.value) || 400),
    ngpu: +f.ngpu.value, chip: f.chip.value, mac: +f.mac.value, unified: f.unified.value, nunits: +f.nunits.value,
    ram: +f.ram.value, cpuMem: f.cpuMem.value, offload: f.offload.checked, runtime: f.runtime.value, kv: f.kv.value,
    ctx: CTX_STOPS[+f.ctxIdx.value], users: USER_STOPS[+f.usersIdx.value], sizeLo: lo, sizeHi: hi, priority: +f.priority.value,
    lang: f.lang.value, commercial: f.commercial.checked, officialOnly: f.officialOnly.checked, hideGated: f.hideGated.checked, uncensored: f.uncensored.checked,
  };
  // Picking an agent type sets a sensible context for it (still adjustable).
  if (state.use === 'agents' && (prevUse !== 'agents' || prevAgent !== state.agent) && (changed === 'use' || changed === 'agent')) {
    state.ctx = Math.max(state.ctx, agentKind(state.agent).ctx);
  }
  // Runtimes that cannot work on the chosen hardware
  if (state.runtime === 'mlx' && state.hw !== 'mac') state.runtime = state.hw === 'cpu' ? 'ollama' : 'any';
  if (['vllm', 'sglang'].includes(state.runtime) && state.hw === 'cpu') state.runtime = 'ollama';
  syncForm();
}

function decorate() {
  const f = els.form;
  const s = state;
  const isLLM = LLM_USES.has(s.use);
  f.querySelectorAll('[data-show]').forEach((x) => { x.hidden = x.dataset.show !== s.use; });
  f.querySelectorAll('[data-hw]').forEach((x) => {
    const k = x.dataset.hw;
    x.hidden = !(k === s.hw || (k === 'custom' && s.hw === 'gpu' && s.gpu === 'custom') || (k === 'ram' && (s.hw === 'gpu' || s.hw === 'cpu'))
      || (k === 'cluster' && s.hw === 'unified' && (UNIFIED.find((u) => u.id === s.unified)?.cluster || 1) > 1));
  });
  f.querySelectorAll('[data-llm]').forEach((x) => { x.hidden = !isLLM; });
  [...f.runtime.options].forEach((o) => {
    o.disabled = (o.value === 'mlx' && s.hw !== 'mac') || (['vllm', 'sglang'].includes(o.value) && (s.hw === 'cpu' || s.hw === 'mac'));
  });
  const u = UNIFIED.find((x) => x.id === s.unified);
  els.hwNote.textContent = s.hw === 'unified' && u ? u.note : s.hw === 'mac' ? 'MLX is usually the fastest way to run models on a Mac; Ollama and LM Studio also work well.' : '';
  els.hwNote.hidden = !els.hwNote.textContent;
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
}

/* --------------------------------------------------------------- results */

function commands(r) {
  const s = state;
  const { m, fit, kind } = r;
  const q = fit.quant;
  const search = (x) => `https://huggingface.co/models?search=${encodeURIComponent(x)}`;
  const base = m.id.split('/').pop();
  const ctxK = s.ctx;
  const out = [];
  if (!LLM_USES.has(s.use)) {
    if (s.use === 'rag') {
      const isRerank = (m.caps >> A.caps.indexOf('rerank')) & 1;
      out.push({ label: 'Python', code: isRerank
        ? `pip install sentence-transformers\npython -c "from sentence_transformers import CrossEncoder as C; print(C('${m.id}').predict([('query', 'passage')]))"`
        : `pip install sentence-transformers\npython -c "from sentence_transformers import SentenceTransformer as S; print(S('${m.id}').encode(['hello world']).shape)"` });
      out.push({ label: 'Text Embeddings Inference', code: `docker run --gpus all -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:latest --model-id ${m.id}` });
      if (!isRerank) out.push({ label: 'Ollama', note: `Many embedding models are also in Ollama's library. <a href="${search(`${base} gguf`)}" rel="noopener">Search GGUF builds</a>.` });
    } else if (s.use === 'asr') {
      out.push({ label: 'Python', code: `pip install transformers torch\npython -c "from transformers import pipeline; print(pipeline('automatic-speech-recognition', model='${m.id}')('audio.mp3'))"` });
      if (/whisper/i.test(m.id)) out.push({ label: 'whisper.cpp', note: 'Whisper models also run very fast with whisper.cpp or faster-whisper.' });
    } else if (s.use === 'image') {
      out.push({ label: 'Python', code: `pip install diffusers transformers torch\npython -c "from diffusers import DiffusionPipeline as P; P.from_pretrained('${m.id}').to('${s.hw === 'mac' ? 'mps' : 'cuda'}')('a lighthouse at dawn').images[0].save('out.png')"` });
      out.push({ label: 'ComfyUI', note: 'ComfyUI (and Draw Things on Mac) load most of these models with a visual workflow editor.' });
    } else {
      out.push({ label: 'Model page', note: 'Text-to-speech models each ship their own runner: follow the instructions on the model page.' });
    }
    return out;
  }
  const ggufQ = QUANTS.gguf.find(([n]) => n === q) ? q : 'Q4_K_M';
  const repo = m.gguf;
  const env = [];
  if (ctxK > 8192) env.push(`OLLAMA_CONTEXT_LENGTH=${ctxK}`);
  if (s.kv !== 'f16') env.push(`OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=${s.kv === 'q8' ? 'q8_0' : 'q4_0'}`);
  if (s.users > 1) env.push(`OLLAMA_NUM_PARALLEL=${Math.min(s.users, 16)}`);
  const parser = /qwen3-coder/i.test(m.id) ? 'qwen3_coder' : TOOL_PARSERS[m.fam];
  const tp = s.hw === 'gpu' && s.ngpu > 1 ? ` --tensor-parallel-size ${s.ngpu}` : '';
  const vllmQ = q === 'BF16' ? '' : q === 'FP8' ? ' --quantization fp8' : '';
  const toolFlags = s.use === 'agents' ? (parser ? ` \\\n  --enable-auto-tool-choice --tool-call-parser ${parser}` : ' \\\n  --enable-auto-tool-choice --tool-call-parser <see model card>') : '';
  const awqNote = q.includes('AWQ') ? `Needs an AWQ build to fit: <a href="${search(`${base} awq`)}" rel="noopener">search one</a> and serve that instead.` : '';

  const gguf = repo
    ? {
      ollama: { label: 'Ollama', code: `${env.length ? `${env.join(' ')} ollama serve   # in one terminal\n` : ''}ollama run hf.co/${repo}:${ggufQ}`, note: s.use === 'agents' ? 'Ollama exposes an OpenAI-compatible API with tool calling at http://localhost:11434/v1.' : '' },
      llamacpp: { label: 'llama.cpp', code: `llama-server -hf ${repo}:${ggufQ} -c ${ctxK} -ngl 99${s.kv !== 'f16' ? ` -fa on -ctk ${s.kv === 'q8' ? 'q8_0' : 'q4_0'} -ctv ${s.kv === 'q8' ? 'q8_0' : 'q4_0'}` : ''}${s.users > 1 ? ` -np ${s.users}` : ''}${s.use === 'agents' ? ' --jinja' : ''}`, note: 'Chat UI and OpenAI-compatible API at http://localhost:8080.' },
      lmstudio: { label: 'LM Studio', code: `lms get ${repo}`, note: `Or search “${esc(repo)}” in LM Studio and pick the <strong>${esc(ggufQ)}</strong> file.` },
    }
    : {
      ollama: { label: 'Ollama', note: `No GGUF build of this model is tracked yet. <a href="${search(`${base} gguf`)}" rel="noopener">Search GGUF builds on Hugging Face</a>, then run <code>ollama run hf.co/&lt;repo&gt;:${esc(ggufQ)}</code>.` },
    };
  const mlx = s.hw === 'mac'
    ? { label: 'MLX', code: m.mlx ? `pip install mlx-lm\nmlx_lm.chat --model ${m.mlx}` : `pip install mlx-lm\nmlx_lm.convert --hf-path ${m.id} -q\nmlx_lm.chat --model mlx_model`, note: m.mlx ? '' : 'No MLX build tracked: this converts the original to 4-bit locally.' }
    : null;
  const vllm = m.st && s.hw !== 'mac' && s.hw !== 'cpu'
    ? { label: 'vLLM', code: `vllm serve ${m.id} --max-model-len ${ctxK}${tp}${vllmQ}${s.kv !== 'f16' ? ' --kv-cache-dtype fp8' : ''}${toolFlags}`, note: awqNote || 'OpenAI-compatible API at http://localhost:8000/v1.' }
    : null;
  const sglang = m.st && s.hw !== 'mac' && s.hw !== 'cpu'
    ? { label: 'SGLang', code: `python -m sglang.launch_server --model-path ${m.id} --context-length ${ctxK}${s.hw === 'gpu' && s.ngpu > 1 ? ` --tp ${s.ngpu}` : ''}`, note: awqNote }
    : null;

  const primary = s.runtime !== 'any' ? s.runtime : kind === 'mlx' ? 'mlx' : kind === 'st' ? 'vllm' : 'ollama';
  const all = { ...gguf, mlx, vllm, sglang };
  if (all[primary]) out.push(all[primary]);
  for (const [k, v] of Object.entries(all)) if (v && k !== primary && v.code) out.push(v);
  return out;
}

function resultCard(r, i) {
  const s = state;
  const b = els.lastBudget;
  const { m, fit } = r;
  const [author, ...rest] = m.id.split('/');
  const isLLM = LLM_USES.has(s.use);
  const pool = fit.where === 'gpu' ? (b.fast || b.slow) : b.fast + b.slow;
  const used = fit.need ? Math.min(100, (fit.need.total / pool) * 100) : null;
  const status = fit.where === 'split' ? ['warn', 'Part of it runs from system RAM']
    : fit.where === 'cpu' && b.kind !== 'cpu' ? ['warn', 'Runs on the CPU']
      : used > 92 ? ['tight', 'Fits, but tight'] : ['ok', 'Fits comfortably'];
  const sp = fit.tps != null ? speedLabel(fit.tps) : null;
  const lf = LICENSE_FAMILY[m.lf];
  const cmds = commands(r);
  const id = `cmd-${i}`;
  return `<article class="advice" data-id="${esc(m.id)}">
    <div class="advice-head">
      <span class="advice-rank">${i + 1}</span>
      <div class="advice-title">
        <h3><a href="${esc(hfUrl(m.id))}" rel="noopener"><span class="author">${esc(author)}/</span>${esc(rest.join('/'))}</a></h3>
        <div class="chips">
          <span class="chip">${esc(task(m.task))}</span>
          ${m.p ? `<span class="chip">${bill(m.p)}${m.a ? ` · ${m.a}B active` : ''}</span>` : ''}
          <span class="chip ${m.lf === 'oss' ? 'ok' : m.lf === 'non-commercial' ? 'nc' : ''}" title="${esc(m.lic || '')}">${esc(lf.short)}</span>
          ${(m.caps >> A.caps.indexOf('tools')) & 1 ? '<span class="chip">Tool calling</span>' : ''}
          ${m.gated ? '<span class="chip gated">Gated</span>' : ''}
        </div>
      </div>
      <label class="compare-check"><input type="checkbox" data-compare="${esc(m.id)}"${compare.has(m.id) ? ' checked' : ''}> Compare</label>
    </div>
    <div class="advice-metrics">
      <div class="metric fit-${status[0]}">
        <span class="metric-label">Memory</span>
        <span class="metric-value">${fit.need ? `≈ ${gb(fit.need.total)}` : 'small'}</span>
        <span class="metric-sub">${esc(fit.quant)}${isLLM && fit.need ? ` · ${gb(fit.need.weights)} weights + ${gb(fit.need.kv)} context` : ''}</span>
        ${used != null ? `<div class="meter" role="img" aria-label="Uses about ${Math.round(used)}% of your memory"><span style="width:${used.toFixed(1)}%"></span></div>` : ''}
        <span class="metric-status">${status[1]}</span>
      </div>
      ${isLLM ? `<div class="metric speed-${sp[0]}">
        <span class="metric-label">Speed (estimate)</span>
        <span class="metric-value">${tps(fit.tps)} <small>tokens/s</small></span>
        <span class="metric-sub">≈ ${int(Math.round(fit.tps * 0.75 * 60))} words per minute</span>
        <span class="metric-status">${sp[1]}</span>
      </div>` : ''}
      <div class="metric">
        <span class="metric-label">Download</span>
        <span class="metric-value">${fit.download ? `≈ ${gb(fit.download)}` : '–'}</span>
        <span class="metric-sub">${compact(m.dl)} downloads/month · ${int(m.likes)} likes</span>
      </div>
    </div>
    ${fit.low ? '<p class="note warn-note">This quantization loses noticeable quality; a smaller model at higher precision may answer better.</p>' : ''}
    ${r.why.length ? `<ul class="why">${r.why.slice(0, 5).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${cmds.length ? `<div class="run">
      <div class="run-tabs" role="tablist">${cmds.map((c, k) => `<button type="button" role="tab" class="run-tab" data-tab="${id}-${k}" aria-selected="${k === 0}">${esc(c.label)}</button>`).join('')}</div>
      ${cmds.map((c, k) => `<div class="run-panel" id="${id}-${k}"${k ? ' hidden' : ''}>
        ${c.code ? `<div class="code-row"><pre><code>${esc(c.code)}</code></pre><button type="button" class="btn copy" data-copy="${esc(c.code)}">Copy</button></div>` : ''}
        ${c.note ? `<p class="note">${c.note}</p>` : ''}
      </div>`).join('')}
    </div>` : ''}
  </article>`;
}

function summaryHtml(b) {
  const s = state;
  const isLLM = LLM_USES.has(s.use);
  const kind = runtimeKinds(s)[0];
  const cap = isLLM ? capacity(kind, s, b) : [];
  return `<div class="budget">
    <div><p class="eyebrow">Your setup</p><p class="budget-main">${esc(b.label)}</p><p class="note">${esc(b.detail)}</p></div>
    ${isLLM ? `<div><p class="eyebrow">Biggest model that fits ${b.fast ? 'fully in fast memory' : ''} · ${ctxLabel(s.ctx)} context${s.users > 1 ? ` × ${s.users} users` : ''}</p>
      <ul class="cap-list">${cap.map(([n, p]) => `<li><span>${esc(n)}</span><strong>${p >= 1 ? `≈ ${p >= 10 ? Math.round(p) : p.toFixed(1)}B` : '< 1B'}</strong></li>`).join('')}</ul></div>` : ''}
  </div>`;
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
  if (resetPage) shown = PAGE;
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
    : `<div class="empty">Nothing fits these settings. Try widening the size range, a shorter context, fewer users, ${state.hw === 'gpu' ? 'allowing system RAM overflow, ' : ''}or removing a filter.</div>`;
  els.more.hidden = list.length <= shown;
  els.compare.innerHTML = compareHtml(list);
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
    results: section.querySelector('#a-results'),
    more: section.querySelector('#a-more'),
    hwNote: section.querySelector('#hw-note'),
    sizeFill: section.querySelector('#size-fill'),
    o: { size: section.querySelector('#o-size'), ctx: section.querySelector('#o-ctx'), users: section.querySelector('#o-users'), pr: section.querySelector('#o-pr') },
  };
  syncForm();
  refresh();

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
    state = { ...state, offload: false, ngpu: 1, nunits: 1, ...p, runtime: p.runtime || (p.hw === 'mac' ? 'mlx' : state.runtime === 'mlx' ? 'ollama' : state.runtime) };
    if (state.hw === 'cpu' && ['vllm', 'sglang', 'mlx'].includes(state.runtime)) state.runtime = 'ollama';
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
  section.querySelector('#a-reset').addEventListener('click', () => { state = { ...DEFAULT }; compare.clear(); syncForm(); refresh(); });
  section.querySelector('#a-share').addEventListener('click', async () => {
    const out = section.querySelector('#a-shared');
    try { await navigator.clipboard.writeText(location.href); out.textContent = 'Link copied.'; } catch (err) { out.textContent = location.href; }
    setTimeout(() => { out.textContent = ''; }, 4000);
  });
  section.querySelector('.advisor-results').addEventListener('click', async (e) => {
    const tab = e.target.closest('.run-tab');
    if (tab) {
      const run = tab.closest('.run');
      run.querySelectorAll('.run-tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      run.querySelectorAll('.run-panel').forEach((p) => { p.hidden = p.id !== tab.dataset.tab; });
      return;
    }
    if (e.target.id === 'a-clear-compare') { compare.clear(); refresh(false); return; }
    const b = e.target.closest('.copy');
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch (err) {
      const pre = b.previousElementSibling;
      const range = document.createRange(); range.selectNodeContents(pre);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      b.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { b.textContent = 'Copy'; }, 1800);
  });
  section.querySelector('.advisor-results').addEventListener('change', (e) => {
    const id = e.target.dataset?.compare;
    if (!id) return;
    if (e.target.checked) {
      if (compare.size >= 3) { e.target.checked = false; return; }
      compare.add(id);
    } else compare.delete(id);
    els.compare.innerHTML = compareHtml(els.lastList || []);
  });
}

export function update(section, params) {
  if (!A) return;
  const next = readParams(params);
  if (Object.keys(KEYS).every((k) => next[k] === state[k])) return;
  state = next;
  syncForm();
  refresh();
}
