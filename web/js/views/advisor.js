import { load } from '../data.js';
import { compact, date, esc, hfUrl, int, language, LICENSE_FAMILY, task } from '../format.js';
import { term } from '../glossary.js';
import { pageHeader } from '../ui.js';

/* ------------------------------------------------------------------ inputs */

const USES = [
  { v: 'chat', label: 'General assistant / chat', hint: 'Answer questions, summarise, write emails', tasks: ['text-generation', 'image-text-to-text', 'any-to-any'] },
  { v: 'code', label: 'Coding', hint: 'Autocomplete, code review, generate functions', tasks: ['text-generation', 'image-text-to-text'] },
  { v: 'agents', label: 'Agents & tool calling', hint: 'Call APIs and tools, multi-step tasks, MCP', tasks: ['text-generation', 'image-text-to-text', 'any-to-any'] },
  { v: 'reasoning', label: 'Reasoning & math', hint: 'Step-by-step thinking, maths, logic puzzles', tasks: ['text-generation', 'image-text-to-text'] },
  { v: 'vision', label: 'Images + text', hint: 'Describe photos, read documents and screenshots', tasks: ['image-text-to-text', 'any-to-any'] },
  { v: 'rag', label: 'Search & RAG (embeddings)', hint: 'Turn documents into vectors for semantic search', tasks: ['feature-extraction', 'sentence-similarity'] },
  { v: 'writing', label: 'Creative writing / roleplay', hint: 'Stories, characters, brainstorming', tasks: ['text-generation'] },
  { v: 'asr', label: 'Speech to text', hint: 'Transcribe meetings, podcasts, voice notes', tasks: ['automatic-speech-recognition'] },
  { v: 'tts', label: 'Text to speech', hint: 'Generate natural-sounding voices', tasks: ['text-to-speech'] },
  { v: 'image', label: 'Image generation', hint: 'Create images from a text prompt', tasks: ['text-to-image'] },
];
const LLM_USES = new Set(['chat', 'code', 'agents', 'reasoning', 'vision', 'writing']);

// VRAM in GB. Grouped for the <select>.
const GPUS = [
  ['NVIDIA GeForce', [['RTX 3060 (12 GB)', 12], ['RTX 3060 Ti / 3070 (8 GB)', 8], ['RTX 3080 (10 GB)', 10], ['RTX 3080 12 GB', 12], ['RTX 3090 / 3090 Ti (24 GB)', 24],
    ['RTX 4060 / 4060 Ti 8 GB', 8], ['RTX 4060 Ti 16 GB', 16], ['RTX 4070 / 4070 Super (12 GB)', 12], ['RTX 4070 Ti Super (16 GB)', 16], ['RTX 4080 / 4080 Super (16 GB)', 16], ['RTX 4090 (24 GB)', 24],
    ['RTX 5060 Ti 16 GB', 16], ['RTX 5070 (12 GB)', 12], ['RTX 5070 Ti (16 GB)', 16], ['RTX 5080 (16 GB)', 16], ['RTX 5090 (32 GB)', 32]]],
  ['NVIDIA workstation & data centre', [['RTX A4000 (16 GB)', 16], ['RTX A5000 (24 GB)', 24], ['RTX A6000 / 6000 Ada (48 GB)', 48], ['RTX PRO 6000 Blackwell (96 GB)', 96],
    ['L4 (24 GB)', 24], ['L40S (48 GB)', 48], ['A100 40 GB', 40], ['A100 / H100 80 GB', 80], ['H200 (141 GB)', 141], ['B200 (192 GB)', 192]]],
  ['AMD', [['Radeon RX 7600 (8 GB)', 8], ['Radeon RX 7800 XT / 9070 XT (16 GB)', 16], ['Radeon RX 7900 XT (20 GB)', 20], ['Radeon RX 7900 XTX (24 GB)', 24], ['Instinct MI300X (192 GB)', 192]]],
  ['Intel', [['Arc B580 (12 GB)', 12], ['Arc A770 (16 GB)', 16]]],
];
const MAC_MEMORY = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512];
const RAM = [8, 16, 32, 64, 128, 256];
const CONTEXTS = [[4096, '4K tokens (short chats)'], [8192, '8K tokens (default)'], [32768, '32K tokens (long documents)'], [131072, '128K tokens (whole codebases)']];
const SIZES = [['', 'Any'], ['1', '1B'], ['3', '3B'], ['7', '7B'], ['13', '13B'], ['30', '30B'], ['70', '70B'], ['120', '120B'], ['400', '400B']];

const RUNTIMES = {
  ollama: { label: 'Ollama', kind: 'gguf' },
  lmstudio: { label: 'LM Studio', kind: 'gguf' },
  llamacpp: { label: 'llama.cpp', kind: 'gguf' },
  mlx: { label: 'MLX (Apple Silicon)', kind: 'mlx' },
  vllm: { label: 'vLLM', kind: 'st' },
  transformers: { label: 'Transformers / Python', kind: 'st' },
};

// Bytes per parameter for each quantization a runtime can load, best quality first.
const QUANTS = {
  gguf: [['Q8_0', 1.07], ['Q6_K', 0.83], ['Q5_K_M', 0.72], ['Q4_K_M', 0.61], ['Q3_K_M', 0.49], ['IQ2_M', 0.34]],
  mlx: [['8-bit', 1.06], ['6-bit', 0.81], ['4-bit', 0.56], ['3-bit', 0.44]],
  st: [['BF16', 2.0], ['FP8 (8-bit)', 1.05], ['AWQ/GPTQ 4-bit', 0.6]],
};
const LOW_QUALITY = new Set(['Q3_K_M', 'IQ2_M', '3-bit']);
const OFFICIAL = new Set(['qwen', 'meta-llama', 'mistralai', 'google', 'microsoft', 'deepseek-ai', 'openai', 'nvidia', 'zai-org', 'ibm-granite', 'huggingfacetb',
  'allenai', 'liquidai', 'moonshotai', 'minimaxai', 'tencent', 'baidu', 'cohereforai', 'coherelabs', 'tiiuae', 'stepfun-ai', 'baai', 'sentence-transformers',
  'intfloat', 'nomic-ai', 'jinaai', 'mixedbread-ai', 'black-forest-labs', 'stabilityai', 'hexgrad', 'kyutai', 'resemble-ai', 'canopylabs', 'apple', 'xai-org']);

/* ------------------------------------------------------------- estimation */

/** KV cache in GB for `ctx` tokens: ~1 GB per 8K tokens for an 8B model, growing sub-linearly with size. */
const kvGB = (p, ctx) => (ctx / 8192) * Math.pow(Math.max(p, 0.5) / 8, 0.45);

/** Memory for an LLM at a given quantization (GB). */
const llmGB = (p, bpp, ctx) => p * bpp + kvGB(p, ctx) + 0.5;

/** Memory for non-LLM models (embeddings, speech, image) run at 16-bit. */
const otherGB = (p, use) => p * 2 + (use === 'image' ? 3 : 0.6);

function budgetOf(s) {
  if (s.hw === 'mac') {
    const usable = s.mac * (s.mac >= 64 ? 0.75 : 0.67);
    return { fast: usable, slow: 0, label: `Mac with ${s.mac} GB unified memory`, detail: `macOS lets the GPU use about ${Math.round(usable)} GB of it` };
  }
  if (s.hw === 'cpu') {
    const usable = Math.max(1, s.ram * 0.7 - 2);
    return { fast: 0, slow: usable, label: `CPU only with ${s.ram} GB RAM`, detail: `about ${Math.round(usable)} GB usable; expect a few words per second on mid-size models` };
  }
  const vram = s.vram * s.ngpu;
  const usable = Math.max(1, vram * (s.ngpu > 1 ? 0.93 : 0.96) - 0.8);
  const slow = s.offload ? Math.max(0, s.ram * 0.7 - 4) : 0;
  return {
    fast: usable, slow,
    label: `${s.ngpu > 1 ? `${s.ngpu}× ` : ''}${s.gpuName || `${s.vram} GB GPU`}${s.ngpu > 1 ? ` = ${vram} GB VRAM` : ''}`,
    detail: `about ${Math.round(usable)} GB usable for the model${slow ? `, plus ~${Math.round(slow)} GB of system RAM for overflow (slower)` : ''}`,
  };
}

/** Pick the best quantization that fits; returns null if nothing fits. */
function fitLLM(p, kind, ctx, budget) {
  for (const [name, bpp] of QUANTS[kind]) {
    const need = llmGB(p, bpp, ctx);
    if (need <= budget.fast) return { quant: name, need, where: 'gpu', low: LOW_QUALITY.has(name) };
  }
  if (budget.slow) {
    for (const [name, bpp] of QUANTS[kind]) {
      const need = llmGB(p, bpp, ctx);
      if (need <= budget.fast + budget.slow) return { quant: name, need, where: budget.fast ? 'split' : 'cpu', low: LOW_QUALITY.has(name) };
    }
  }
  return null;
}

/** Largest model (B params) that fits fully in fast memory at each quantization. */
function capacity(kind, ctx, budget) {
  const mem = budget.fast || budget.slow;
  return QUANTS[kind].map(([name, bpp]) => {
    let lo = 0, hi = 2000;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (llmGB(mid, bpp, ctx) <= mem) lo = mid; else hi = mid; }
    return [name, lo];
  });
}

/* ---------------------------------------------------------------- scoring */

let A = null;
let state = null;
let els = {};

const has = (m, cap) => (m.caps >> A.caps.indexOf(cap)) & 1;
const DAY = 86400000;

function runtimeKinds(s) {
  if (s.runtime !== 'any') return [RUNTIMES[s.runtime].kind];
  if (s.hw === 'mac') return ['mlx', 'gguf'];
  if (s.hw === 'cpu') return ['gguf'];
  return ['gguf', 'st'];
}

function recommend(s) {
  const use = USES.find((u) => u.v === s.use);
  const budget = budgetOf(s);
  const isLLM = LLM_USES.has(s.use);
  const today = Math.floor(Date.now() / DAY);
  const kinds = runtimeKinds(s);
  const minP = s.minB ? +s.minB : 0;
  const maxP = s.maxB ? +s.maxB : Infinity;
  const out = [];

  for (const m of A.models) {
    if (!use.tasks.includes(m.task)) continue;
    if (s.commercial && m.lf !== 'oss') continue;
    if (s.hideGated && m.gated) continue;
    if (!s.uncensored && has(m, 'uncensored')) continue;
    if (m.p != null && (m.p < minP * 0.85 || m.p > maxP * 1.15)) continue;
    if ((minP || maxP < Infinity) && m.p == null) continue;
    const name = m.id.toLowerCase();
    if (isLLM && /(^|[-_/])base([-_]|$)/.test(name) && !has(m, 'chat')) continue; // raw base models are not assistants
    if (s.use === 'vision' && !has(m, 'vision')) continue;
    if (s.use === 'code' && !has(m, 'code') && !(has(m, 'chat') && A.tool_families.includes(m.fam))) continue;

    // How it would run
    let fit = null, kind = null;
    if (isLLM || s.use === 'writing') {
      if (m.p == null) continue;
      for (const k of kinds) {
        if (k === 'gguf' && !m.gguf && s.runtime === 'any' && kinds.length > 1) continue;
        if (k === 'mlx' && !m.mlx && s.runtime === 'any' && kinds.length > 1) continue;
        if (k === 'st' && !m.st) continue;
        const f = fitLLM(m.p, k, s.ctx, budget);
        if (f && (!fit || rankFit(f) > rankFit(fit))) { fit = f; kind = k; }
      }
      if (!fit) continue;
    } else {
      const need = m.p != null ? otherGB(m.p, s.use) : null;
      const mem = budget.fast || budget.slow;
      if (need != null && need > mem) continue;
      fit = { quant: '16-bit', need, where: budget.fast ? 'gpu' : 'cpu', low: false };
      kind = 'st';
    }

    // Score: popularity + fit for the job + using the hardware well
    let score = Math.log10(m.dl + 10) * 1.2 + Math.log10(m.likes + 1) * 0.8 + (m.tr > 0 ? Math.log10(m.tr + 1) * 0.8 : 0);
    const age = m.c != null ? today - m.c : 9999;
    score += age < 120 ? 1.2 : age < 365 ? 0.5 : 0;
    if (OFFICIAL.has(m.id.split('/')[0].toLowerCase())) score += 1.2;
    const why = [];
    if (s.use === 'code') { if (has(m, 'code')) { score += 4; why.push('Built for code'); } else why.push('General model that also handles code'); }
    if (s.use === 'agents') {
      if (has(m, 'tools')) { score += 4; why.push('Tagged for tool calling / agents'); } else if (A.tool_families.includes(m.fam) && has(m, 'chat')) { score += 2; why.push(`${m.fam} instruct models support tool calling`); }
      if (has(m, 'reasoning')) score += 1;
      if (m.p != null && m.p < 7) score -= 1.5;
    }
    if (s.use === 'reasoning') { if (has(m, 'reasoning')) { score += 4; why.push('Thinking / reasoning model'); } if (has(m, 'math')) score += 1; }
    if (s.use === 'writing' && has(m, 'roleplay')) { score += 3; why.push('Tuned for creative writing'); }
    if (['chat', 'agents', 'writing'].includes(s.use)) score += has(m, 'chat') ? 1 : -1.5;
    if (s.lang) {
      if (m.lang.includes(s.lang) || m.lang.includes('multilingual')) { score += 1.5; why.push(`Declares ${language(s.lang)}`); } else if (m.lang.length) score -= 1;
    }
    if (isLLM && m.p) {
      const cap = capacity(kind, s.ctx, budget).find(([n]) => n === fit.quant)?.[1] || m.p;
      score += 2 * Math.min(1, m.p / Math.max(cap, 0.1));
      if (fit.where !== 'gpu') score -= 1.5;
      if (fit.low) score -= 1.5;
      else if (/^(Q4|AWQ|4-bit)/.test(fit.quant)) score -= 0.3;
    }
    if (kind === 'gguf' && !m.gguf) { score -= 1.5; why.push('No GGUF build tracked yet: use the search link below'); }
    if (kind === 'mlx' && !m.mlx) score -= 1;
    if (m.dl >= 10000) why.push(`${compact(m.dl)} downloads last month`);
    else if (m.likes >= 50) why.push(`${int(m.likes)} likes`);
    if (age < 120) why.push(`New (${date(m.c * DAY)})`);
    if (m.a) why.push(`Mixture of experts: only ${m.a}B active per token, so it runs fast for its size`);
    out.push({ m, fit, kind, score, why });
  }
  out.sort((a, b) => b.score - a.score);
  // Avoid ten near-copies of the same model: at most two per base name.
  const seen = new Map();
  return { budget, list: out.filter((r) => {
    const key = r.m.id.split('/').pop().toLowerCase().replace(/[-_.]?(instruct|it|chat|gguf|awq|fp8|bf16|nvfp4|mlx).*$/, '');
    seen.set(key, (seen.get(key) || 0) + 1);
    return seen.get(key) <= 2;
  }) };
}
const rankFit = (f) => (f.where === 'gpu' ? 100 : f.where === 'split' ? 50 : 0) - (f.low ? 20 : 0) + (QUANT_ORDER.get(f.quant) ?? 0);
const QUANT_ORDER = new Map(Object.values(QUANTS).flatMap((list) => list.map(([n], i) => [n, 10 - i])));

/* ----------------------------------------------------------------- output */

function runCommand(r, s) {
  const { m, fit, kind } = r;
  const ggufQuant = fit.quant;
  const search = (q) => `https://huggingface.co/models?search=${encodeURIComponent(q)}`;
  const base = m.id.split('/').pop();
  if (!LLM_USES.has(s.use)) {
    if (s.use === 'rag') return { code: `pip install sentence-transformers\npython -c "from sentence_transformers import SentenceTransformer as S; print(S('${m.id}').encode(['hello world']).shape)"`, note: 'Works with most vector databases (Chroma, Qdrant, pgvector…).' };
    if (s.use === 'asr') return { code: `pip install transformers torch\npython -c "from transformers import pipeline; print(pipeline('automatic-speech-recognition', model='${m.id}')('audio.mp3'))"`, note: 'Some speech models ship their own runner: check the model page.' };
    if (s.use === 'image') return { code: `pip install diffusers transformers torch\npython -c "from diffusers import DiffusionPipeline as P; P.from_pretrained('${m.id}').to('cuda')('a lighthouse at dawn').images[0].save('out.png')"`, note: 'ComfyUI and Draw Things (Mac) can load many of these models too.' };
    return { code: null, note: 'Text-to-speech models each have their own runner: follow the instructions on the model page.' };
  }
  if (kind === 'gguf') {
    if (!m.gguf) return { code: null, note: `No GGUF build found in the dataset. <a href="${search(`${base} gguf`)}" rel="noopener">Search GGUF builds on Hugging Face</a>.` };
    const repo = m.gguf;
    if (s.runtime === 'lmstudio') return { code: repo, note: `In LM Studio, search for this repository and download the <strong>${esc(ggufQuant)}</strong> file.` };
    if (s.runtime === 'llamacpp') return { code: `llama-server -hf ${repo}:${ggufQuant} -c ${s.ctx}`, note: 'Then open http://localhost:8080 for a chat UI and an OpenAI-compatible API.' };
    return {
      code: `ollama run hf.co/${repo}:${ggufQuant}`,
      note: `Raise the context with <code>/set parameter num_ctx ${s.ctx}</code> inside the chat.${fit.where === 'split' ? ' Ollama will place the layers that do not fit on the GPU in system RAM automatically.' : ''}${s.ngpu > 1 ? ' Ollama spreads the model across all your GPUs automatically.' : ''}`,
    };
  }
  if (kind === 'mlx') {
    if (!m.mlx) return { code: `pip install mlx-lm\nmlx_lm.convert --hf-path ${m.id} -q`, note: 'No MLX build found in the dataset, so this converts the original to 4-bit MLX locally.' };
    return { code: `pip install mlx-lm\nmlx_lm.chat --model ${m.mlx}`, note: `Pick a ${esc(fit.quant)} build if the repository offers several.` };
  }
  const tp = s.hw === 'gpu' && s.ngpu > 1 ? ` --tensor-parallel-size ${s.ngpu}` : '';
  if (s.runtime === 'transformers') return { code: `pip install transformers accelerate torch\npython -c "from transformers import pipeline; p = pipeline('text-generation', model='${m.id}', device_map='auto'); print(p([{'role': 'user', 'content': 'Hello!'}], max_new_tokens=100))"`, note: fit.quant === 'BF16' ? '' : `Needs ${esc(fit.quant)} weights to fit: <a href="${search(`${base} ${fit.quant.includes('4') ? 'awq' : 'fp8'}`)}" rel="noopener">search a quantized build</a>.` };
  return {
    code: `pip install vllm\nvllm serve ${m.id} --max-model-len ${s.ctx}${tp}`,
    note: `${fit.quant === 'BF16' ? '' : `Needs ${esc(fit.quant)} weights to fit: <a href="${search(`${base} ${fit.quant.includes('4') ? 'awq' : 'fp8'}`)}" rel="noopener">search a quantized build</a>. `}vLLM serves an OpenAI-compatible API on port 8000${s.use === 'agents' ? '; add <code>--enable-auto-tool-choice</code> and the model’s <code>--tool-call-parser</code> for tool calling' : ''}.`,
  };
}

function resultCard(r, i, s, budget) {
  const { m, fit } = r;
  const [author, ...rest] = m.id.split('/');
  const total = budget.fast + budget.slow || 1;
  const pctUsed = fit.need != null ? Math.min(100, (fit.need / (fit.where === 'gpu' ? budget.fast || budget.slow : total)) * 100) : null;
  const status = fit.where === 'split' ? ['warn', 'Partly in system RAM: works, but 3–10× slower']
    : fit.where === 'cpu' ? ['warn', 'Runs on the CPU: slow but usable for small models']
      : pctUsed > 90 ? ['tight', 'Fits, but tight: close other apps or lower the context'] : ['ok', 'Fits comfortably'];
  const run = runCommand(r, s);
  const lf = LICENSE_FAMILY[m.lf];
  return `<article class="advice">
    <div class="advice-head">
      <span class="advice-rank">${i + 1}</span>
      <div class="advice-title">
        <h3><a href="${esc(hfUrl(m.id))}" rel="noopener"><span class="author">${esc(author)}/</span>${esc(rest.join('/'))}</a></h3>
        <div class="chips">
          <span class="chip">${esc(task(m.task))}</span>
          ${m.p ? `<span class="chip">${m.p >= 1 ? `${+m.p.toFixed(1)}B` : `${Math.round(m.p * 1000)}M`} params${m.a ? ` · ${m.a}B active` : ''}</span>` : ''}
          <span class="chip ${m.lf === 'oss' ? 'ok' : m.lf === 'non-commercial' ? 'nc' : ''}" title="${esc(m.lic || '')}">${esc(lf.short)}</span>
          ${m.gated ? '<span class="chip gated">Gated</span>' : ''}
        </div>
      </div>
    </div>
    <div class="fit fit-${status[0]}">
      <div class="fit-line"><strong>${esc(fit.quant)}</strong>${fit.need != null ? ` · ≈ ${fit.need.toFixed(1)} GB` : ''}${LLM_USES.has(s.use) ? ` with ${int(s.ctx / 1024)}K context` : ''}<span class="fit-status">${status[1]}</span></div>
      ${pctUsed != null ? `<div class="meter" role="img" aria-label="Uses about ${Math.round(pctUsed)}% of your memory"><span style="width:${pctUsed.toFixed(1)}%"></span></div>` : ''}
      ${fit.low ? '<p class="note">This quantization loses noticeable quality; a smaller model at higher precision may answer better.</p>' : ''}
    </div>
    ${r.why.length ? `<ul class="why">${r.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <div class="run">
      ${run.code ? `<div class="code-row"><pre><code>${esc(run.code)}</code></pre><button type="button" class="btn copy" data-copy="${esc(run.code)}">Copy</button></div>` : ''}
      ${run.note ? `<p class="note">${run.note}</p>` : ''}
    </div>
  </article>`;
}

function summaryHtml(s, budget) {
  const isLLM = LLM_USES.has(s.use);
  const kind = runtimeKinds(s)[0];
  const cap = isLLM ? capacity(kind, s.ctx, budget) : [];
  return `<div class="budget">
    <div><p class="eyebrow">Your setup</p><p class="budget-main">${esc(budget.label)}</p><p class="note">${esc(budget.detail)}</p></div>
    ${isLLM ? `<div><p class="eyebrow">Largest model that fits${budget.fast ? ' fully on the GPU' : ''} (${int(s.ctx / 1024)}K context)</p>
      <ul class="cap-list">${cap.map(([n, p]) => `<li><span>${esc(n)}</span><strong>${p >= 1 ? `≈ ${p >= 10 ? Math.round(p) : p.toFixed(1)}B` : '< 1B'}</strong></li>`).join('')}</ul></div>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------- form */

const DEFAULT = { use: 'chat', hw: 'gpu', gpu: 'RTX 4090 (24 GB)', vram: 24, gpuName: 'RTX 4090 (24 GB)', ngpu: 1, mac: 32, ram: 32, offload: false, runtime: 'ollama', ctx: 8192, minB: '', maxB: '', commercial: false, lang: '', hideGated: false, uncensored: false };

function readForm() {
  const f = els.form;
  const gpuOpt = f.gpu.selectedOptions[0];
  const custom = f.gpu.value === 'custom';
  state = {
    use: f.querySelector('input[name="use"]:checked')?.value || 'chat',
    hw: f.querySelector('input[name="hw"]:checked')?.value || 'gpu',
    gpu: f.gpu.value,
    vram: custom ? Math.max(1, +f.vram.value || 8) : +gpuOpt.dataset.vram,
    gpuName: custom ? `${f.vram.value || 8} GB GPU` : f.gpu.value,
    ngpu: +f.ngpu.value,
    mac: +f.mac.value,
    ram: +f.ram.value,
    offload: f.offload.checked,
    runtime: f.runtime.value,
    ctx: +f.ctx.value,
    minB: f.minB.value,
    maxB: f.maxB.value,
    commercial: f.commercial.checked,
    lang: f.lang.value,
    hideGated: f.gated.checked,
    uncensored: f.uncensored.checked,
  };
  // Runtimes that make no sense for the hardware
  const macOnly = state.runtime === 'mlx';
  if (macOnly && state.hw !== 'mac') { state.runtime = 'any'; f.runtime.value = 'any'; }
  f.querySelector('[data-hw="gpu"]').hidden = state.hw !== 'gpu';
  f.querySelector('[data-hw="mac"]').hidden = state.hw !== 'mac';
  f.querySelector('[data-hw="custom"]').hidden = !(state.hw === 'gpu' && custom);
  f.querySelector('[data-hw="offload"]').hidden = state.hw !== 'gpu';
  f.querySelector('[data-llm]').hidden = !LLM_USES.has(state.use);
  [...f.runtime.options].forEach((o) => { if (o.value === 'mlx') o.disabled = state.hw !== 'mac'; });
}

let shown = 8;
function refresh(reset = true) {
  if (reset) shown = 8;
  const { budget, list } = recommend(state);
  els.summary.innerHTML = summaryHtml(state, budget);
  const use = USES.find((u) => u.v === state.use);
  els.count.textContent = list.length ? `${int(list.length)} models fit. Showing the best ${Math.min(shown, list.length)} for “${use.label.toLowerCase()}”.` : '';
  els.results.innerHTML = list.length
    ? list.slice(0, shown).map((r, i) => resultCard(r, i, state, budget)).join('')
    : `<div class="empty">Nothing fits these settings. Try a smaller size range, a shorter context, ${state.hw === 'gpu' ? 'allowing system RAM overflow, ' : ''}or removing the license filter.</div>`;
  els.more.hidden = list.length <= shown;
}

export async function render(section) {
  A = await load('advisor.json');
  const langs = ['en', 'es', 'zh', 'fr', 'de', 'ja', 'ko', 'pt', 'it', 'ru', 'ar', 'hi'];
  section.replaceChildren(pageHeader({
    id: 'h-advisor', eyebrow: 'Model advisor', title: 'What should I run on my hardware?',
    lead: `Tell us what you want to do and what machine you have. We recommend open models that fit in your memory, pick the best ${term('quantization', 'quantization')} for each one and give you the command to run it.`,
    howTo: [
      `Memory needed = ${term('parameters', 'parameters')} × bytes per parameter for the chosen quantization + the context (KV cache) + about 0.5 GB of overhead. These are estimates: leave some margin.`,
      `“Allow system RAM” lets Ollama / llama.cpp keep part of a large model in normal RAM. It works, but generation becomes several times slower.`,
      'Mixture-of-experts (MoE) models must fit entirely in memory, but only a fraction of their parameters work per word, so they run much faster than their size suggests.',
      'Ranking combines how well the model matches your use, how popular and recent it is, whether it comes from the original lab, and how well it uses the memory you have.',
    ],
  }));

  section.insertAdjacentHTML('beforeend', `
    <form class="advisor-form" id="advisor-form" onsubmit="return false">
      <fieldset class="step">
        <legend><span class="step-n">1</span> What will you use it for?</legend>
        <div class="use-grid">${USES.map((u) => `<label class="use-option"><input type="radio" name="use" value="${u.v}"><span class="use-label">${esc(u.label)}</span><span class="use-hint">${esc(u.hint)}</span></label>`).join('')}</div>
      </fieldset>

      <fieldset class="step">
        <legend><span class="step-n">2</span> What hardware do you have?</legend>
        <div class="segmented hw-switch" role="radiogroup" aria-label="Hardware type">
          <label><input type="radio" name="hw" value="gpu"> GPU (NVIDIA / AMD / Intel)</label>
          <label><input type="radio" name="hw" value="mac"> Apple Silicon Mac</label>
          <label><input type="radio" name="hw" value="cpu"> CPU only</label>
        </div>
        <div class="filters">
          <div class="field" data-hw="gpu"><label for="a-gpu">Graphics card</label>
            <select id="a-gpu" name="gpu">${GPUS.map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(([n, v]) => `<option value="${esc(n)}" data-vram="${v}">${esc(n)}</option>`).join('')}</optgroup>`).join('')}<option value="custom">Other (enter VRAM)</option></select></div>
          <div class="field" data-hw="custom" hidden><label for="a-vram">VRAM per card (GB)</label><input type="text" inputmode="numeric" id="a-vram" name="vram" value="16"></div>
          <div class="field" data-hw="gpu"><label for="a-ngpu">Number of cards</label>
            <select id="a-ngpu" name="ngpu">${[1, 2, 3, 4, 6, 8].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></div>
          <div class="field" data-hw="mac" hidden><label for="a-mac">Unified memory</label>
            <select id="a-mac" name="mac">${MAC_MEMORY.map((g) => `<option value="${g}">${g} GB</option>`).join('')}</select></div>
          <div class="field"><label for="a-ram">System RAM</label>
            <select id="a-ram" name="ram">${RAM.map((g) => `<option value="${g}">${g} GB</option>`).join('')}</select></div>
        </div>
        <label class="inline-check" data-hw="offload"><input type="checkbox" name="offload"> Allow overflow into system RAM (Ollama / llama.cpp; bigger models, slower)</label>
      </fieldset>

      <fieldset class="step">
        <legend><span class="step-n">3</span> How will you run it?</legend>
        <div class="filters">
          <div class="field"><label for="a-runtime">Runtime</label>
            <select id="a-runtime" name="runtime">
              <option value="any">No preference</option>
              ${Object.entries(RUNTIMES).map(([k, r]) => `<option value="${k}">${esc(r.label)}</option>`).join('')}
            </select></div>
          <div class="field" data-llm><label for="a-ctx">Context you need</label>
            <select id="a-ctx" name="ctx">${CONTEXTS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
          <div class="field"><label for="a-min">Minimum size</label>
            <select id="a-min" name="minB">${SIZES.map(([v, l]) => `<option value="${v}">${esc(l === 'Any' ? 'No minimum' : l)}</option>`).join('')}</select></div>
          <div class="field"><label for="a-max">Maximum size</label>
            <select id="a-max" name="maxB">${SIZES.map(([v, l]) => `<option value="${v}">${esc(l === 'Any' ? 'No maximum' : l)}</option>`).join('')}</select></div>
          <div class="field"><label for="a-lang">Language</label>
            <select id="a-lang" name="lang"><option value="">Any</option>${langs.map((l) => `<option value="${l}">${esc(language(l))}</option>`).join('')}</select></div>
        </div>
        <div class="checks">
          <label><input type="checkbox" name="commercial"> I need commercial use</label>
          <label><input type="checkbox" name="gated"> Hide gated models</label>
          <label><input type="checkbox" name="uncensored"> Include uncensored / abliterated variants</label>
        </div>
      </fieldset>
    </form>

    <section class="advisor-results" aria-labelledby="h-recs">
      <h2 id="h-recs" class="block-title">Recommendations</h2>
      <div id="a-summary"></div>
      <p class="result-count" id="a-count" role="status" aria-live="polite"></p>
      <div id="a-results" class="advice-list"></div>
      <div class="more-row" id="a-more" hidden><button type="button" class="btn btn-primary" id="a-more-btn">Show more</button></div>
      <p class="note">Recommendations come from the models tracked by the dataset and their public metadata. Always check the model card for the recommended settings and license.</p>
    </section>`);

  els = {
    form: section.querySelector('#advisor-form'),
    summary: section.querySelector('#a-summary'),
    count: section.querySelector('#a-count'),
    results: section.querySelector('#a-results'),
    more: section.querySelector('#a-more'),
  };
  const f = els.form;
  f.querySelector(`input[name="use"][value="${DEFAULT.use}"]`).checked = true;
  f.querySelector(`input[name="hw"][value="${DEFAULT.hw}"]`).checked = true;
  f.gpu.value = DEFAULT.gpu;
  f.mac.value = String(DEFAULT.mac);
  f.ram.value = String(DEFAULT.ram);
  f.runtime.value = DEFAULT.runtime;
  f.ctx.value = String(DEFAULT.ctx);
  readForm();
  refresh();
  f.addEventListener('change', () => { readForm(); refresh(); });
  f.addEventListener('input', (e) => { if (e.target.name === 'vram') { readForm(); refresh(); } });
  section.querySelector('#a-more-btn').addEventListener('click', () => { shown += 8; refresh(false); });
  els.results.addEventListener('click', async (e) => {
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
}
