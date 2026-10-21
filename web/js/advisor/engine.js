// Model advisor engine: memory budgets, quantization choice, KV cache, speed and ranking.
// Pure functions with no DOM access, so they can be unit-tested with `node --test`.

import { MAC_CHIPS, UNIFIED, CPU_MEMORY, gpuById } from './hardware.js';

/* ------------------------------------------------------------------ catalogues */

export const USES = [
  { v: 'chat', label: 'General assistant / chat', hint: 'Answer questions, summarise, write', tasks: ['text-generation', 'image-text-to-text', 'any-to-any'] },
  { v: 'agents', label: 'Agents & tool calling', hint: 'Call tools and APIs, multi-step work', tasks: ['text-generation', 'image-text-to-text', 'any-to-any'] },
  { v: 'code', label: 'Coding assistant', hint: 'Autocomplete, explain and write code', tasks: ['text-generation', 'image-text-to-text'] },
  { v: 'reasoning', label: 'Reasoning & math', hint: 'Step-by-step thinking, maths, logic', tasks: ['text-generation', 'image-text-to-text'] },
  { v: 'vision', label: 'Images + text', hint: 'Photos, documents, screenshots, OCR', tasks: ['image-text-to-text', 'any-to-any'] },
  { v: 'rag', label: 'Search & RAG', hint: 'Embeddings and rerankers for your documents', tasks: ['feature-extraction', 'sentence-similarity', 'text-ranking'] },
  { v: 'writing', label: 'Creative writing / roleplay', hint: 'Stories, characters, brainstorming', tasks: ['text-generation'] },
  { v: 'asr', label: 'Speech to text', hint: 'Transcribe meetings and voice notes', tasks: ['automatic-speech-recognition'] },
  { v: 'tts', label: 'Text to speech', hint: 'Natural-sounding voices', tasks: ['text-to-speech'] },
  { v: 'image', label: 'Image generation', hint: 'Images from a text prompt', tasks: ['text-to-image'] },
];
export const LLM_USES = new Set(['chat', 'agents', 'code', 'reasoning', 'vision', 'writing']);

const fw = (name, url, what) => ({ name, url, what });
export const AGENT_KINDS = [
  {
    v: 'coding', label: 'Coding agent', hint: 'Edits a repository, runs tests, fixes bugs',
    weights: { swe: 5, code: 3, tools: 2, reasoning: 0.5, longctx: 0.5 }, minP: 7, ctx: 32768,
    advice: 'Coding agents send long prompts (files, diffs, tool output): plan for 32K–128K context. Models under ~14B often lose track of multi-step edits.',
    frameworks: [fw('OpenHands', 'https://github.com/All-Hands-AI/OpenHands', 'autonomous software agent'), fw('Cline', 'https://github.com/cline/cline', 'VS Code agent'), fw('Aider', 'https://github.com/Aider-AI/aider', 'pair programming in the terminal'), fw('Continue', 'https://github.com/continuedev/continue', 'IDE assistant'), fw('Roo Code', 'https://github.com/RooCodeInc/Roo-Code', 'VS Code agent')],
  },
  {
    v: 'computer', label: 'Browser / computer use', hint: 'Clicks, types and navigates GUIs and websites',
    weights: { computer: 6, vision: 2, tools: 1.5, reasoning: 0.5 }, requires: 'vision', minP: 3, ctx: 32768,
    advice: 'Needs a vision model that can read screenshots and point at elements. Dedicated GUI models (UI-TARS, Holo, UI-Venus, OpenCUA…) are far more reliable than general chat models.',
    frameworks: [fw('browser-use', 'https://github.com/browser-use/browser-use', 'web automation'), fw('UI-TARS Desktop', 'https://github.com/bytedance/UI-TARS-desktop', 'desktop control'), fw('Agent S', 'https://github.com/simular-ai/Agent-S', 'computer-use framework')],
  },
  {
    v: 'functions', label: 'Function calling & APIs', hint: 'Structured JSON tool calls to your own functions',
    weights: { tools: 5, chat: 1, reasoning: 0.5 }, minP: 3, ctx: 8192,
    advice: 'Small models can do reliable single tool calls; chains of several calls need ~8B+. Use the OpenAI-compatible tools API that Ollama, llama.cpp, LM Studio and vLLM all expose.',
    frameworks: [fw('Pydantic AI', 'https://github.com/pydantic/pydantic-ai', 'typed tool calling'), fw('smolagents', 'https://github.com/huggingface/smolagents', 'lightweight agents'), fw('LangGraph', 'https://github.com/langchain-ai/langgraph', 'agent workflows')],
  },
  {
    v: 'mcp', label: 'MCP / multi-tool assistant', hint: 'Desktop assistant connected to many MCP servers',
    weights: { tools: 5, reasoning: 1, longctx: 1, chat: 1 }, minP: 7, ctx: 32768,
    advice: 'Every connected MCP server adds its tool descriptions to the prompt, so many tools quickly need 16K–32K context.',
    frameworks: [fw('Goose', 'https://github.com/block/goose', 'desktop agent with MCP'), fw('LM Studio', 'https://lmstudio.ai', 'local app with MCP support'), fw('Open WebUI', 'https://github.com/open-webui/open-webui', 'web UI, MCP via mcpo')],
  },
  {
    v: 'research', label: 'Research agent', hint: 'Searches the web, reads pages, writes a report',
    weights: { reasoning: 3, tools: 2.5, longctx: 2, chat: 0.5 }, minP: 7, ctx: 65536,
    advice: 'Reading many pages needs a long context (64K+) and a model that reasons well about what it has read.',
    frameworks: [fw('smolagents (Open Deep Research)', 'https://github.com/huggingface/smolagents', 'search-and-browse agent'), fw('GPT Researcher', 'https://github.com/assafelovic/gpt-researcher', 'research reports'), fw('LangGraph', 'https://github.com/langchain-ai/langgraph', 'custom research graphs')],
  },
  {
    v: 'data', label: 'Data analysis & SQL', hint: 'Writes SQL and Python over your data',
    weights: { sql: 5, code: 2.5, tools: 1.5, reasoning: 1 }, minP: 3, ctx: 16384,
    advice: 'Give the model your table schemas in the prompt. Code-capable models also handle pandas analysis well.',
    frameworks: [fw('Vanna', 'https://github.com/vanna-ai/vanna', 'text-to-SQL'), fw('PandasAI', 'https://github.com/sinaptik-ai/pandas-ai', 'chat with dataframes'), fw('smolagents CodeAgent', 'https://github.com/huggingface/smolagents', 'agents that write Python')],
  },
];
export const agentKind = (v) => AGENT_KINDS.find((k) => k.v === v) || AGENT_KINDS[0];

export const RUNTIMES = {
  ollama: { label: 'Ollama', kind: 'gguf' },
  lmstudio: { label: 'LM Studio', kind: 'gguf' },
  llamacpp: { label: 'llama.cpp', kind: 'gguf' },
  mlx: { label: 'MLX (Apple)', kind: 'mlx' },
  vllm: { label: 'vLLM', kind: 'st' },
  sglang: { label: 'SGLang', kind: 'st' },
  transformers: { label: 'Transformers', kind: 'st' },
};

// [name, bytes per parameter, quality factor] — best quality first.
export const QUANTS = {
  gguf: [['F16', 2.0, 1], ['Q8_0', 1.07, 0.995], ['Q6_K', 0.83, 0.985], ['Q5_K_M', 0.72, 0.97], ['Q4_K_M', 0.61, 0.94], ['Q3_K_M', 0.49, 0.85], ['IQ2_M', 0.34, 0.7]],
  mlx: [['bf16', 2.0, 1], ['8-bit', 1.06, 0.995], ['6-bit', 0.81, 0.985], ['4-bit', 0.56, 0.94], ['3-bit', 0.44, 0.84]],
  st: [['BF16', 2.0, 1], ['FP8', 1.05, 0.99], ['AWQ 4-bit', 0.6, 0.94]],
};
export const LOW_QUALITY = new Set(['Q3_K_M', 'IQ2_M', '3-bit']);
const KV_FACTOR = { f16: 1, q8: 0.5, q4: 0.28 };

// Size slider stops (billions of parameters) and context stops (tokens).
export const SIZE_STOPS = [0.1, 0.3, 0.5, 1, 1.5, 2, 3, 4, 7, 8, 9, 12, 14, 20, 24, 27, 32, 35, 49, 70, 80, 120, 235, 405, 700, 1000];
export const CTX_STOPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 1048576];
export const USER_STOPS = [1, 2, 4, 8, 16, 32, 64, 128];

const OFFICIAL = new Set(['qwen', 'meta-llama', 'mistralai', 'google', 'microsoft', 'deepseek-ai', 'openai', 'nvidia', 'zai-org', 'ibm-granite', 'huggingfacetb',
  'allenai', 'liquidai', 'moonshotai', 'minimaxai', 'tencent', 'baidu', 'cohereforai', 'coherelabs', 'tiiuae', 'stepfun-ai', 'baai', 'sentence-transformers',
  'intfloat', 'nomic-ai', 'jinaai', 'mixedbread-ai', 'black-forest-labs', 'stabilityai', 'hexgrad', 'kyutai', 'resemble-ai', 'canopylabs', 'apple', 'xai-org',
  'bytedance-seed', 'bytedance', 'xiaomimimo', 'openbmb', 'inclusionai', 'hcompany', 'all-hands', 'kwaipilot', 'cross-encoder', 'alibaba-nlp']);

// vLLM `--tool-call-parser` per family (only where the parser name is well established).
export const TOOL_PARSERS = { Qwen: 'hermes', Llama: 'llama3_json', Mistral: 'mistral', 'GPT-OSS': 'openai', Granite: 'granite', DeepSeek: 'deepseek_v3', Kimi: 'kimi_k2', GLM: 'glm45' };

/* ------------------------------------------------------------------ memory */

/** KV cache (GB) for one sequence of `ctx` tokens at FP16: ~1 GB per 8K tokens for an 8B model, sub-linear in size. */
export const kvGB = (p, ctx) => (ctx / 8192) * Math.pow(Math.max(p, 0.5) / 8, 0.45);

export function memNeeded(p, bpp, s) {
  const kv = kvGB(p, s.ctx) * (KV_FACTOR[s.kv] ?? 1) * Math.max(1, s.users);
  return { weights: p * bpp, kv, total: p * bpp + kv + 0.5 };
}

/** What the machine offers: fast pool (GPU / unified) and optional slow pool (system RAM). */
export function budgetOf(s) {
  const cpu = CPU_MEMORY.find((c) => c.id === s.cpuMem) || CPU_MEMORY[1];
  if (s.hw === 'mac') {
    const chip = MAC_CHIPS.find((c) => c.id === s.chip) || MAC_CHIPS[0];
    const usable = s.mac * (s.mac >= 64 ? 0.75 : 0.67);
    return { kind: 'mac', fast: usable, fastBw: chip.bw, slow: 0, slowBw: 0, n: 1,
      label: `${chip.name} Mac · ${s.mac} GB unified memory`,
      detail: `macOS lets the GPU use about ${Math.round(usable)} GB of it (raise it with sudo sysctl iogpu.wired_limit_mb). Bandwidth ${chip.bw} GB/s.` };
  }
  if (s.hw === 'unified') {
    const u = UNIFIED.find((x) => x.id === s.unified) || UNIFIED[0];
    const n = Math.min(Math.max(1, s.nunits || 1), u.cluster || 1);
    return { kind: 'unified', fast: u.usable * n, fastBw: u.bw, slow: 0, slowBw: 0, n,
      label: `${n > 1 ? `${n}× ` : ''}${u.name}`,
      detail: `about ${Math.round(u.usable * n)} GB usable for models, ${u.bw} GB/s${n > 1 ? ' per unit' : ''}. ${u.note}` };
  }
  if (s.hw === 'cpu') {
    const usable = Math.max(1, s.ram * 0.7 - 2);
    return { kind: 'cpu', fast: 0, fastBw: 0, slow: usable, slowBw: cpu.bw, n: 1,
      label: `CPU only · ${s.ram} GB RAM`, detail: `about ${Math.round(usable)} GB usable, ${cpu.bw} GB/s (${cpu.name}). Fine for small models; large ones run at a few words per second.` };
  }
  const g = s.gpu === 'custom' ? { name: `${s.customVram} GB GPU`, mem: +s.customVram || 8, bw: +s.customBw || 400 } : (gpuById(s.gpu) || gpuById('rtx-4090'));
  const n = Math.max(1, s.ngpu || 1);
  const usable = Math.max(1, g.mem * n * (n > 1 ? 0.94 : 0.96) - 0.8 * n);
  const slow = s.offload ? Math.max(0, s.ram * 0.7 - 4) : 0;
  return { kind: 'gpu', fast: usable, fastBw: g.bw, slow, slowBw: cpu.bw, n,
    label: `${n > 1 ? `${n}× ` : ''}${g.name}${n > 1 ? ` · ${g.mem * n} GB VRAM` : ` · ${g.mem} GB VRAM`}`,
    detail: `about ${Math.round(usable)} GB usable for the model, ${g.bw} GB/s per card${slow ? `; plus ~${Math.round(slow)} GB of system RAM for overflow (much slower)` : ''}.` };
}

/** Effective bandwidth for one generation stream on the fast pool. */
function fastBandwidth(b, runtime) {
  // Tensor parallel (vLLM / SGLang): all cards read their slice at once. Ollama / llama.cpp split
  // layers across cards, which take turns, so a single stream gets one card's bandwidth.
  if (b.n > 1 && ['vllm', 'sglang'].includes(runtime)) return b.fastBw * (1 + (b.n - 1) * 0.6);
  return b.fastBw;
}

/** Estimated tokens per second for one user. */
export function speedOf(activeP, bpp, s, b, where, runtime) {
  const kvRead = kvGB(activeP, s.ctx) * (KV_FACTOR[s.kv] ?? 1) * 0.5;
  const perToken = activeP * bpp + kvRead;
  const eff = b.kind === 'cpu' ? 0.5 : b.kind === 'unified' ? 0.65 : 0.7;
  if (where === 'gpu') return Math.min(250, (eff * fastBandwidth(b, runtime)) / perToken);
  if (where === 'cpu') return Math.min(250, (0.45 * b.slowBw) / perToken);
  // split: the share that does not fit runs from system RAM
  const totalNeed = perToken;
  const fastShare = Math.min(1, Math.max(0.05, b.fast / (b.fast + (b.slowNeed || b.slow))));
  const t = (totalNeed * fastShare) / (eff * b.fastBw) + (totalNeed * (1 - fastShare)) / (0.45 * b.slowBw);
  return Math.min(250, 1 / t);
}

export function speedLabel(tps) {
  if (tps >= 40) return ['fast', 'Very fast'];
  if (tps >= 15) return ['ok', 'Comfortable'];
  if (tps >= 6) return ['slow', 'Usable, a bit slow'];
  return ['vslow', 'Slow'];
}

/** Target speed (tokens/s) for the quality ↔ speed slider: 8 tok/s at "best answers", 40 at "fastest". */
export const targetSpeed = (priority) => 8 + priority * 0.32;

/**
 * Choose the quantization. Among the options that fit in fast memory, take the most precise one that
 * still reaches the target speed; if none does, the fastest one that keeps acceptable quality (≥ 4-bit).
 * 16-bit weights are skipped for GGUF/MLX models above 2B: 8-bit is practically lossless and twice as fast.
 */
export function fitModel(m, kind, s, b, runtime) {
  const p = m.p;
  // Unknown-active MoE (tagged "moe" but no "A3B" in the name): assume ~12% of parameters are active.
  const active = m.a || (m.moe ? p * 0.12 : p);
  const ladder = QUANTS[kind].filter(([q]) => !(['F16', 'bf16'].includes(q) && p > 2 && s.priority > 10));
  const options = [];
  for (const [quant, bpp, q] of ladder) {
    if (kind === 'st' && runtime === 'transformers' && quant === 'AWQ 4-bit') continue;
    const need = memNeeded(p, bpp, s);
    let where = null;
    if (b.fast && need.total <= b.fast) where = 'gpu';
    else if (b.slow && need.total <= b.fast + b.slow) where = b.fast ? 'split' : 'cpu';
    if (!where) continue;
    const bb = where === 'split' ? { ...b, slowNeed: need.total - b.fast } : b;
    // MoE routing and less regular memory access cost some of the theoretical speed-up.
    const t = speedOf(active, bpp, s, bb, where, runtime) * (active < p ? 0.7 : 1);
    options.push({ quant, bpp, qf: q, need, where, low: LOW_QUALITY.has(quant), tps: t, download: p * bpp });
  }
  if (!options.length) return null;
  const target = targetSpeed(s.priority);
  const pick = (opts) => {
    const good = opts.filter((o) => !o.low);
    return good.find((o) => o.tps >= target) || good[good.length - 1] || opts[opts.length - 1];
  };
  const fast = options.filter((o) => o.where === 'gpu');
  return fast.length ? pick(fast) : pick(options);
}

/** Largest dense model (B) that fits fully in fast memory at each quantization. */
export function capacity(kind, s, b) {
  const mem = b.fast || b.slow;
  return QUANTS[kind].filter(([q]) => !['F16', 'bf16'].includes(q) || kind === 'st').map(([name, bpp]) => {
    let lo = 0, hi = 3000;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (memNeeded(mid, bpp, s).total <= mem) lo = mid; else hi = mid; }
    return [name, lo];
  });
}

/* ------------------------------------------------------------------ ranking */

const capIndex = (caps, name) => caps.indexOf(name);
export const hasCap = (data, m, name) => { const i = capIndex(data.caps, name); return i >= 0 && ((m.caps >> i) & 1) === 1; };

export function runtimeKinds(s) {
  if (s.runtime !== 'any') return [RUNTIMES[s.runtime].kind];
  if (s.hw === 'mac') return ['mlx', 'gguf'];
  if (s.hw === 'cpu') return ['gguf'];
  if (s.hw === 'unified') return ['gguf', 'st'];
  return ['gguf', 'st'];
}

/** Rough "how capable" proxy: bigger and less compressed is better; MoE counts between active and total. */
export const qualityOf = (m, fit) => Math.log2(1 + (m.a ? Math.sqrt(m.a * m.p) : m.p)) * (fit ? fit.qf : 1);

export function recommend(data, s, today = Math.floor(Date.now() / 86400000)) {
  const use = USES.find((u) => u.v === s.use) || USES[0];
  const kindCfg = s.use === 'agents' ? agentKind(s.agent) : null;
  const b = budgetOf(s);
  const isLLM = LLM_USES.has(s.use);
  const kinds = runtimeKinds(s);
  const lo = SIZE_STOPS[s.sizeLo ?? 0], hi = SIZE_STOPS[s.sizeHi ?? SIZE_STOPS.length - 1];
  const sizeFiltered = (s.sizeLo ?? 0) > 0 || (s.sizeHi ?? SIZE_STOPS.length - 1) < SIZE_STOPS.length - 1;
  const has = (m, c) => hasCap(data, m, c);
  const wQ = 1.8 * (1 - s.priority / 100) + 0.4;
  const wS = 1.8 * (s.priority / 100) + 0.2;
  const out = [];

  for (const m of data.models) {
    if (!use.tasks.includes(m.task)) continue;
    if (s.commercial && m.lf !== 'oss') continue;
    if (s.hideGated && m.gated) continue;
    if (!s.uncensored && has(m, 'uncensored')) continue;
    if (s.officialOnly && !OFFICIAL.has(m.id.split('/')[0].toLowerCase())) continue;
    if (sizeFiltered) {
      if (m.p == null) continue;
      if (m.p < lo * 0.9 || m.p > hi * 1.1) continue;
    }
    const name = m.id.toLowerCase();
    if (isLLM && /(^|[-_/])base([-_]|$)/.test(name) && !has(m, 'chat')) continue;
    if (s.use === 'vision' && !has(m, 'vision')) continue;
    if (s.use === 'code' && !has(m, 'code') && !(has(m, 'chat') && data.tool_families.includes(m.fam))) continue;
    if (kindCfg?.requires && !has(m, kindCfg.requires)) continue;
    if (s.use === 'rag' && s.ragPart && s.ragPart !== 'both') {
      if (s.ragPart === 'rerank' && !has(m, 'rerank')) continue;
      if (s.ragPart === 'embed' && has(m, 'rerank')) continue;
    }

    let fit = null, kind = null;
    if (isLLM) {
      if (m.p == null) continue;
      for (const k of kinds) {
        if (kinds.length > 1 && k === 'gguf' && !m.gguf) continue;
        if (kinds.length > 1 && k === 'mlx' && !m.mlx) continue;
        if (k === 'st' && !m.st) continue;
        const f = fitModel({ ...m, moe: has(m, 'moe') }, k, s, b, s.runtime);
        if (!f) continue;
        if (!fit || (f.where === 'gpu' && fit.where !== 'gpu') || (f.where === fit.where && f.tps > fit.tps * 1.15)) { fit = f; kind = k; }
      }
      if (!fit) continue;
    } else {
      const p = m.p;
      const need = p != null ? p * 2 + (s.use === 'image' ? 3 : 0.6) : null;
      const mem = b.fast || b.slow;
      if (need != null && need > mem) continue;
      fit = { quant: '16-bit', bpp: 2, qf: 1, need: need != null ? { total: need, weights: p * 2, kv: 0 } : null, where: b.fast ? 'gpu' : 'cpu', low: false, tps: null, download: p != null ? p * 2 : null };
      kind = 'st';
    }

    const why = [];
    let rel = 0;
    // relevance to the job
    if (kindCfg) {
      for (const [cap, w] of Object.entries(kindCfg.weights)) if (has(m, cap)) rel += w;
      if (!has(m, 'tools') && data.tool_families.includes(m.fam) && has(m, 'chat')) { rel += 2; why.push(`${m.fam} instruct models support tool calling`); }
      if (m.p != null && m.p < kindCfg.minP) rel -= 2;
      if (has(m, 'swe') && s.agent === 'coding') why.push('Trained or evaluated for agentic coding (SWE-style tasks)');
      if (has(m, 'computer') && s.agent === 'computer') why.push('Built for GUI / computer use');
      if (has(m, 'sql') && s.agent === 'data') why.push('Trained for text-to-SQL');
      if (has(m, 'tools')) why.push('Tagged for tool calling');
    }
    if (s.use === 'code') { if (has(m, 'code')) { rel += 4; why.push('Built for code'); } if (has(m, 'swe')) rel += 1; }
    if (s.use === 'reasoning') { if (has(m, 'reasoning')) { rel += 4; why.push('Thinking / reasoning model'); } if (has(m, 'math')) rel += 1; }
    if (s.use === 'writing' && has(m, 'roleplay')) { rel += 3; why.push('Tuned for creative writing'); }
    if (s.use === 'vision' && has(m, 'computer')) rel += 0.5;
    if (['chat', 'agents', 'writing', 'reasoning'].includes(s.use)) rel += has(m, 'chat') ? 1 : -1.5;
    if (s.ctx >= 65536 && has(m, 'longctx')) { rel += 1.5; why.push('Designed for long contexts'); }
    if (s.lang) {
      if (m.lang.includes(s.lang) || m.lang.includes('multilingual')) { rel += 1.5; why.push(`Declares ${s.langName || s.lang}`); } else if (m.lang.length) rel -= 1;
    }

    // popularity, freshness, provenance
    const pop = Math.log10(m.dl + 10) * 1.1 + Math.log10(m.likes + 1) * 0.7 + (m.tr > 0 ? Math.log10(m.tr + 1) * 0.8 : 0);
    const age = m.c != null ? today - m.c : 9999;
    const fresh = age < 120 ? 1.2 : age < 365 ? 0.5 : 0;
    const official = OFFICIAL.has(m.id.split('/')[0].toLowerCase()) ? 1.2 : 0;

    // quality vs speed
    const quality = isLLM ? qualityOf(m, fit) : 0;
    const speed = fit.tps ? Math.log2(1 + fit.tps) : 0;
    let score = rel + pop + fresh + official + (isLLM ? wQ * quality * 0.9 + wS * speed * 0.8 : 0);
    if (fit.where === 'split') score -= 1.5;
    if (fit.where === 'cpu' && b.kind !== 'cpu') score -= 1;
    if (fit.low) score -= 1.5;
    if (isLLM && fit.tps != null) score -= fit.tps < 3 ? 3.5 : fit.tps < 6 ? 2 : fit.tps < 10 ? 0.8 : 0;
    if (kind === 'gguf' && !m.gguf) { score -= 1.5; why.push('No GGUF build tracked yet: use the search link below'); }
    if (kind === 'mlx' && !m.mlx) score -= 1;

    if (m.dl >= 10000) why.push(`${fmtCompact(m.dl)} downloads last month`);
    else if (m.likes >= 50) why.push(`${m.likes} likes`);
    if (age < 120) why.push('Released in the last 4 months');
    if (official) why.push('From the original lab');
    if (m.a) why.push(`Mixture of experts: ${m.a}B of ${round1(m.p)}B parameters work per token, so it runs like a ${m.a}B model`);
    else if (has(m, 'moe') && isLLM) why.push('Mixture of experts (active size not published): speed estimated at ~12% active');
    out.push({ m, fit, kind, score, quality, why });
  }

  out.sort((a, c) => c.score - a.score);
  // At most two near-copies of the same model (e.g. -Instruct and -FP8 uploads).
  const seen = new Map();
  const list = out.filter((r) => {
    const key = r.m.id.split('/').pop().toLowerCase().replace(/[-_.]?(instruct|it|chat|gguf|awq|fp8|bf16|nvfp4|mlx|\d+bit).*$/, '');
    seen.set(key, (seen.get(key) || 0) + 1);
    return seen.get(key) <= 2;
  });
  if (s.sort === 'fast' && isLLM) {
    const pool = list.slice(0, 80);
    pool.sort((a, c) => (c.fit.tps ?? 0) - (a.fit.tps ?? 0));
    return { budget: b, list: pool, total: list.length };
  }
  if (s.sort === 'quality' && isLLM) {
    const pool = list.slice(0, 80);
    pool.sort((a, c) => c.quality - a.quality);
    return { budget: b, list: pool, total: list.length };
  }
  return { budget: b, list, total: list.length };
}

const round1 = (x) => Math.round(x * 10) / 10;
function fmtCompact(n) {
  if (n >= 1e6) return `${round1(n / 1e6)}M`;
  if (n >= 1e3) return `${round1(n / 1e3)}K`;
  return String(n);
}
