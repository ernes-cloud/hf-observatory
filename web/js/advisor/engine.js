// Model advisor engine: memory budgets, quantization choice, KV cache, speed and ranking.
// Pure functions with no DOM access, so they can be unit-tested with `node --test`.

import { ARCH_LABEL, MAC_CHIPS, UNIFIED, CPU_MEMORY, gpuById } from './hardware.js';

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

/**
 * Formats a GPU server (vLLM / SGLang / Transformers) can run natively depend on the architecture:
 * Blackwell has FP4 tensor cores (NVFP4), Hopper / Ada / CDNA3 have FP8, Ampere and older use INT8 / INT4.
 * Each entry: [label, bytes per parameter, quality factor, pre-quantized repo key (null = runs from the original)].
 */
const SELF_FORMATS = {
  nvfp4: ['NVFP4', 0.56, 0.95, 'nvfp4'], fp8: ['FP8', 1.05, 0.99, 'fp8'], int8: ['INT8 (W8A16)', 1.05, 0.985, 'int8'],
  awq: ['AWQ / GPTQ 4-bit', 0.6, 0.94, 'awq'], gptq: ['AWQ / GPTQ 4-bit', 0.6, 0.94, 'awq'],
};
export function serverLadder(arch, m = {}) {
  if (m.fam === 'GPT-OSS' || (m.q && m.q.mxfp4 === m.id)) return [['MXFP4 (native)', 0.55, 1, null]];
  // A repository that is itself a quantized upload runs only in its own format (NVFP4 needs Blackwell).
  const self = m.q && Object.keys(m.q).find((k) => m.q[k] === m.id);
  if (self) return SELF_FORMATS[self] && (self !== 'nvfp4' || arch === 'blackwell') ? [SELF_FORMATS[self]] : [];
  const half = arch === 'turing' ? 'FP16' : 'BF16';
  if (arch === 'blackwell') return [[half, 2.0, 1, null], ['FP8', 1.05, 0.99, 'fp8'], ['NVFP4', 0.56, 0.95, 'nvfp4']];
  if (['hopper', 'ada', 'cdna3', 'cdna4'].includes(arch)) return [[half, 2.0, 1, null], ['FP8', 1.05, 0.99, 'fp8'], ['AWQ / GPTQ 4-bit', 0.6, 0.94, 'awq']];
  return [[half, 2.0, 1, null], ['INT8 (W8A16)', 1.05, 0.985, 'int8'], ['AWQ / GPTQ 4-bit', 0.6, 0.94, 'awq']];
}
export const isGptOss = (m) => m.fam === 'GPT-OSS' || /(^|\/)gpt-oss-\d+b$/i.test(m.id || '');

/** Pre-quantized repository for a server format (FP8 can also be applied on the fly to the original weights). */
export function serverRepo(m, key) {
  if (!key) return { repo: m.id, onTheFly: false };
  const q = m.q || {};
  const repo = key === 'awq' ? q.awq || q.gptq : q[key];
  if (repo) return { repo, onTheFly: false };
  if (key === 'fp8') return { repo: m.id, onTheFly: true };
  return { repo: null, onTheFly: false };
}

/* ------------------------------------------------------------------ speculative decoding */

// Approximate single-user decode speed-ups (they depend on the acceptance rate of each prompt).
export const SPEC = {
  dflash2: { label: 'DFlash2 draft', speedup: 2.3 },
  dflash: { label: 'DFlash draft', speedup: 2.0 },
  dspark: { label: 'DSpark draft', speedup: 2.1 },
  eagle3: { label: 'EAGLE-3 draft', speedup: 1.7 },
  eagle: { label: 'EAGLE draft', speedup: 1.5 },
  mtp: { label: 'MTP (built-in heads)', speedup: 1.5 },
};

/** vLLM speculative "method" name for built-in MTP heads. */
export function mtpMethod(m) {
  const id = m.id.toLowerCase();
  if (/qwen3-(coder-)?next/.test(id)) return 'qwen3_next_mtp';
  if (/qwen3\.[5-9]|qwen3\.\d{2}/.test(id) || m.fam === 'Qwen') return 'qwen3_5_mtp';
  if (m.fam === 'DeepSeek' || /kimi|mimo/.test(id)) return 'deepseek_mtp';
  return 'mtp';
}

/**
 * Speculative-decoding options for a model on a runtime, best first.
 * vLLM: MTP heads, DFlash / DFlash2 and EAGLE-3 drafts. SGLang: also DSpark. llama.cpp: MTP with an
 * MTP-preserving GGUF (single user, text only) or a DFlash2 GGUF draft (needs a build with DFlash2).
 */
export function specOptions(m, runtime, s) {
  const out = [];
  const drafts = m.dr || [];
  if (['vllm', 'sglang'].includes(runtime)) {
    const allowed = ['dflash2', 'dflash', 'dspark', 'eagle3', 'eagle']; // both servers support all of these drafters
    for (const method of allowed) {
      const d = drafts.find((x) => x.m === method && !x.g);
      if (d) out.push({ method, draft: d.id, draftP: d.p || 1, ...SPEC[method] });
    }
    if (m.mtp) out.push({ method: 'mtp', draft: null, draftP: 0, ...SPEC.mtp, vllmMethod: mtpMethod(m) });
  } else if (runtime === 'llamacpp') {
    if (m.gmtp && s.users <= 1 && s.use !== 'vision') out.push({ method: 'mtp', draft: null, draftP: 0, ...SPEC.mtp, gguf: m.gmtp });
    // GGUF drafters: llama.cpp's --spec-type draft-dflash (DFlash or DFlash2, read from the GGUF),
    // draft-dspark and draft-eagle3
    for (const method of ['dflash2', 'dflash', 'dspark', 'eagle3']) {
      const d = drafts.find((x) => x.m === method && x.g);
      if (d) out.push({ method, draft: d.id, draftP: d.p || 1, ...SPEC[method], recent: true });
    }
  }
  return out;
}

/** Thinking behaviour: hybrid models can switch it off; "effort" models (gpt-oss) take low/medium/high. */
export function thinkingOf(m) {
  const id = m.id.toLowerCase();
  if (m.fam === 'GPT-OSS' || /gpt-oss/.test(id)) return { mode: 'effort', vllmParser: null, sglangParser: 'gpt-oss' };
  if (/instruct-2507|qwen3-coder|non-?thinking/.test(id)) return null;
  if (/thinking|qwq|deepseek-r1/.test(id)) return { mode: 'always', vllmParser: /deepseek-r1/.test(id) ? 'deepseek_r1' : 'qwen3', sglangParser: /deepseek-r1/.test(id) ? 'deepseek-r1' : 'qwen3' };
  if (/qwen3/.test(id)) return { mode: 'hybrid', vllmParser: 'qwen3', sglangParser: 'qwen3' };
  if (/glm-4\.[5-9]|glm-5/.test(id)) return { mode: 'hybrid', vllmParser: 'glm45', sglangParser: 'glm45' };
  if (m.reasoning) return { mode: 'always', vllmParser: null, sglangParser: null };
  return null;
}

export function specFor(m, runtime, s) {
  return specOptions(m, runtime, s)[0] || null;
}

/** Speculative decoding helps one user a lot and a busy server much less. */
export const specGain = (spec, users) => 1 + (spec.speedup - 1) * (users <= 1 ? 1 : users <= 4 ? 0.7 : users <= 16 ? 0.4 : 0.15);
/** Speed with a speculative option; drafting gains less when the target is already very fast. */
export const withSpec = (tps, spec, users) => Math.min(Math.max(tps, 350), tps * (1 + (specGain(spec, users) - 1) / (1 + tps / 400)));
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
/** vLLM tool-call parser for a model: newer Qwen generations use the XML format, Qwen3-Coder its own. */
export function toolParser(m) {
  const id = m.id.toLowerCase();
  if (/qwen3-coder/.test(id)) return 'qwen3_coder';
  if (/qwen3\.[5-9]|qwen3\.\d{2}/.test(id)) return 'qwen3_xml';
  if (/gemma-?4/.test(id)) return 'gemma4';
  return TOOL_PARSERS[m.fam] || null;
}
/** SGLang names its tool-call parsers differently (and has no XML Qwen parser: Qwen3.5+ use qwen3_coder there). */
const SGLANG_TOOL_PARSERS = { qwen3_xml: 'qwen3_coder', qwen3_coder: 'qwen3_coder', hermes: 'hermes', llama3_json: 'llama3', openai: 'gpt-oss', glm45: 'glm45', kimi_k2: 'kimi_k2', deepseek_v3: 'deepseekv3', mistral: 'mistral' };
export const sglangToolParser = (m) => SGLANG_TOOL_PARSERS[toolParser(m)] || null;

/* ------------------------------------------------------------------ memory */

/** KV cache (GB) for one sequence of `ctx` tokens at FP16: ~1 GB per 8K tokens for an 8B model, sub-linear in size. */
export const kvGB = (p, ctx) => (ctx / 8192) * Math.pow(Math.max(p, 0.5) / 8, 0.45);

/**
 * Size that drives the KV cache. Dense: the model size. Mixture of experts: attention is shared by all
 * experts, so the cache grows with the model's width, not its total size; the geometric mean of active
 * and total parameters tracks real MoE caches (Qwen3-235B-A22B, MiniMax-M2, Mixtral) while erring high.
 */
export function kvBasis(m) {
  if (!m || m.p == null) return m?.p ?? 0;
  const active = m.a || (m.moe ? m.p * 0.12 : m.p);
  return active < m.p ? Math.sqrt(active * m.p) : m.p;
}
/**
 * KV cache (GB) of one sequence. Exact when the model's config.json was read (kvb: bytes per token in
 * full-attention layers, kvs: in sliding-window layers capped at `win` tokens); otherwise estimated from
 * the size and the attention type (MLA, hybrid, sliding window).
 */
export function kvOf(m, ctx) {
  if (m?.kvb != null) return (m.kvb * ctx + (m.kvs || 0) * Math.min(ctx, m.win || ctx)) / 1e9;
  return kvGB(kvBasis(m), ctx) * (m?.kvf ?? 1);
}

/** MoE routing and scattered expert reads cost some of the bandwidth advantage (calibrated on llama.cpp). */
export const MOE_EFF = 0.85;

/**
 * Prompt reading speed (tokens/s): compute-bound, 2 FLOPs per active parameter per token. The share of
 * the spec-sheet TFLOPS a runtime reaches is calibrated on published llama.cpp results for the DGX Spark
 * and Apple Silicon; GPU servers (vLLM / SGLang) batch the prompt better and use all cards in parallel.
 */
export function prefillOf(m, where, b, runtime) {
  const active = m.a || (m.moe ? m.p * 0.12 : m.p);
  if (!active) return null;
  return Math.min(50000, (computeTf(b, where, runtime) * 1e12) / (2 * active * 1e9));
}

export function memNeeded(p, bpp, s, m = null) {
  const perSeq = m ? kvOf(m, s.ctx) : kvGB(p, s.ctx);
  const kv = perSeq * (KV_FACTOR[s.kv] ?? 1) * Math.max(1, s.users);
  return { weights: p * bpp, kv, total: p * bpp + kv + 0.5 };
}

/**
 * How vLLM / SGLang split a model over n GPUs: tensor parallel needs a power of two that divides the
 * attention heads, so 3 or 6 cards use pipeline parallel for the rest (6 = TP 2 × PP 3).
 */
export function parallelOf(n) {
  let tp = 1;
  while (n % (tp * 2) === 0) tp *= 2;
  return { tp, pp: n / tp };
}
/** A cluster of unified-memory machines (two linked DGX Spark) is only usable as one by vLLM / SGLang. */
export const isCluster = (b) => b.kind === 'unified' && b.n > 1;

/** What the machine offers: fast pool (GPU / unified) and optional slow pool (system RAM). */
export function budgetOf(s) {
  const cpu = CPU_MEMORY.find((c) => c.id === s.cpuMem) || CPU_MEMORY[1];
  if (s.hw === 'mac') {
    const chip = MAC_CHIPS.find((c) => c.id === s.chip) || MAC_CHIPS[0];
    const usable = s.mac * (s.mac >= 64 ? 0.75 : 0.67);
    return { kind: 'mac', arch: 'apple', vendor: 'apple', fast: usable, fastBw: chip.bw, tf: chip.tf, slow: 0, slowBw: 0, slowTf: 0, n: 1,
      label: `${chip.name} Mac · ${s.mac} GB unified memory`,
      detail: `macOS lets the GPU use about ${Math.round(usable)} GB of it (raise it with sudo sysctl iogpu.wired_limit_mb). Bandwidth ${chip.bw} GB/s.` };
  }
  const picked = s.hw === 'gpu' ? gpuById(s.gpu) : null;
  if (s.hw === 'unified' || picked?.unified) {
    const u = UNIFIED.find((x) => x.id === (picked?.unified ? picked.id : s.unified)) || UNIFIED[0];
    if (picked?.unified) s = { ...s, nunits: s.ngpu };
    const linked = Math.min(Math.max(1, s.nunits || 1), u.cluster || 1);
    // Ollama, LM Studio and llama.cpp run on one machine: only vLLM / SGLang can use two linked units.
    const n = linked > 1 && !['vllm', 'sglang', 'any'].includes(s.runtime) ? 1 : linked;
    return { kind: 'unified', id: u.id, arch: u.arch, vendor: u.vendor, arm: !!u.arm, fast: u.usable * n, fastBw: u.bw, tf: u.tf, slow: 0, slowBw: 0, slowTf: 0, n,
      label: `${n > 1 ? `${n}× ` : ''}${u.name}`,
      detail: `about ${Math.round(u.usable * n)} GB usable for models, ${u.bw} GB/s${n > 1 ? ' per unit' : ''}, ${ARCH_LABEL[u.arch]}. ${u.note}${linked > n ? ` ${RUNTIMES[s.runtime]?.label || 'This runtime'} runs on one unit: pick vLLM or SGLang to use both.` : ''}` };
  }
  if (s.hw === 'cpu') {
    const usable = Math.max(1, s.ram * 0.7 - 2);
    return { kind: 'cpu', arch: 'cpu', vendor: 'cpu', fast: 0, fastBw: 0, tf: 0, slow: usable, slowBw: cpu.bw, slowTf: cpu.tf, n: 1,
      label: `CPU only · ${s.ram} GB RAM`, detail: `about ${Math.round(usable)} GB usable, ${cpu.bw} GB/s (${cpu.name}). Fine for small models; large ones run at a few words per second.` };
  }
  const g = s.gpu === 'custom' ? { name: `${s.customVram} GB GPU`, mem: +s.customVram || 8, bw: +s.customBw || 400, arch: s.customArch || 'ada', vendor: 'nvidia', tf: Math.round((+s.customBw || 400) * 0.16) } : (gpuById(s.gpu) || gpuById('rtx-4090'));
  const n = Math.max(1, s.ngpu || 1);
  const usable = Math.max(1, g.mem * n * (n > 1 ? 0.94 : 0.96) - 0.8 * n);
  const slow = s.offload ? Math.max(0, s.ram * 0.8 - 3) : 0;
  const g2 = s.gpu !== 'custom' && s.gpu2 ? gpuById(s.gpu2) : null;
  if (g2 && !g2.unified && !g.unified) return mixedBudget(g, n, g2, Math.max(1, s.ngpu2 || 1), s, slow, cpu);
  return { kind: 'gpu', geforce: isGeForce(g), arch: g.arch, vendor: g.vendor, fast: usable, fastBw: g.bw, tf: g.tf, slow, slowBw: cpu.bw, slowTf: cpu.tf, n,
    label: `${n > 1 ? `${n}× ` : ''}${g.name}${n > 1 ? ` · ${g.mem * n} GB VRAM` : ` · ${g.mem} GB VRAM`}`,
    detail: `about ${Math.round(usable)} GB usable for the model, ${g.bw} GB/s per card, ${ARCH_LABEL[g.arch] || g.arch}${slow ? `; plus ~${Math.round(slow)} GB of system RAM for overflow (much slower)` : ''}.` };
}

const isGeForce = (g) => g.vendor === 'nvidia' && /^RTX [2-5]0\d0/.test(g.name || '');
const ARCH_AGE = ['turing', 'ampere', 'rdna3', 'xe', 'ada', 'rdna4', 'cdna3', 'hopper', 'cdna4', 'blackwell'];

/**
 * Two kinds of card in one machine (e.g. an RTX 4090 and an RTX 3090). llama.cpp and Ollama split the
 * layers in proportion to each card's memory, so a token spends time on each card in turn.
 * vLLM / SGLang tensor parallel needs equal shards: every card counts as the smallest and slowest one.
 */
function mixedBudget(g, n, g2, n2, s, slow, cpu) {
  const per = (x) => Math.max(1, x.mem * 0.94 - 0.8);
  const total = n + n2;
  const older = ARCH_AGE.indexOf(g.arch) <= ARCH_AGE.indexOf(g2.arch) ? g : g2;
  const label = `${n}× ${g.name} + ${n2}× ${g2.name} · ${g.mem * n + g2.mem * n2} GB VRAM`;
  if (['vllm', 'sglang'].includes(s.runtime)) {
    const mem = Math.min(per(g), per(g2));
    return { kind: 'gpu', mixed: true, geforce: isGeForce(g) && isGeForce(g2), arch: older.arch, vendor: g.vendor, fast: mem * total, fastBw: Math.min(g.bw, g2.bw), tf: Math.min(g.tf, g2.tf), slow, slowBw: cpu.bw, slowTf: cpu.tf, n: total,
      label, detail: `tensor parallel splits the model evenly, so each of the ${total} cards counts as ${Math.round(mem)} GB at ${Math.min(g.bw, g2.bw)} GB/s (the smaller and slower one), ${ARCH_LABEL[older.arch]} formats. llama.cpp / Ollama use all of the memory.` };
  }
  const m1 = per(g) * n, m2 = per(g2) * n2;
  const fast = m1 + m2;
  // time per byte, weighted by how much of the model each card holds
  const bw = fast / (m1 / g.bw + m2 / g2.bw);
  return { kind: 'gpu', mixed: true, geforce: isGeForce(g) && isGeForce(g2), arch: older.arch, vendor: g.vendor, fast, fastBw: bw, tf: Math.min(g.tf, g2.tf), slow, slowBw: cpu.bw, slowTf: cpu.tf, n: 1,
    label, detail: `about ${Math.round(fast)} GB usable; llama.cpp / Ollama put layers on both cards in proportion to their memory, ≈ ${Math.round(bw)} GB/s on average${slow ? `; plus ~${Math.round(slow)} GB of system RAM for overflow` : ''}. vLLM / SGLang would treat every card as the smaller one.` };
}

/** Effective bandwidth for one generation stream on the fast pool. */
function fastBandwidth(b, runtime) {
  // Tensor parallel (vLLM / SGLang): all cards read their slice at once. Ollama / llama.cpp split
  // layers across cards, which take turns, so a single stream gets one card's bandwidth.
  // Pipeline stages also take turns, so only the tensor-parallel part adds bandwidth.
  if (b.n > 1 && ['vllm', 'sglang'].includes(runtime)) return b.fastBw * (1 + (parallelOf(b.n).tp - 1) * 0.6);
  return b.fastBw;
}

/** Estimated tokens per second for one user. */
export function speedOf(activeP, bpp, s, b, where, runtime, kvSeq = null, totalP = activeP) {
  // Each new token reads the weights it uses plus the cache filled so far: on average about a third
  // of the window (conversations and agent runs grow into it), using the same estimate as memory.
  const kvRead = (kvSeq ?? kvGB(activeP, s.ctx)) * (KV_FACTOR[s.kv] ?? 1) * 0.35;
  // Several users are served together (continuous batching): one pass over the weights produces a
  // token for each of them, but every user's cache is read. A mixture of experts touches more of its
  // experts as the batch grows.
  const users = Math.max(1, s.users || 1);
  const share = activeP < totalP ? Math.max(activeP / totalP, 1 - (1 - activeP / totalP) ** users) : 1;
  const perToken = (activeP < totalP ? totalP * share : activeP) * bpp + kvRead * users;
  // Share of the bandwidth a runtime turns into tokens, calibrated on published llama.cpp results
  // (see tests/advisor-calibration.test.mjs): ~75% on GPUs and the DGX Spark, ~70% on Apple Silicon.
  const eff = b.kind === 'cpu' ? 0.5 : b.kind === 'mac' ? 0.7 : b.kind === 'unified' ? (b.vendor === 'nvidia' ? 0.8 : 0.72) : 0.75;
  // Fixed per-token cost (kernel launches, sampling, scheduling) that bandwidth does not cover:
  // it keeps small and MoE models from reaching unrealistic speeds.
  const fixed = where === 'cpu' || b.kind === 'cpu' ? 0.004 : 0.002;
  // Batching in llama.cpp / Ollama parallel slots is less efficient than in GPU servers.
  const batchCost = users > 1 && !['vllm', 'sglang'].includes(runtime) ? 1 + 0.08 * Math.min(users - 1, 15) : 1;
  let step;
  if (where === 'gpu') step = perToken / (eff * fastBandwidth(b, runtime)) + fixed;
  else if (where === 'cpu') step = perToken / (0.45 * b.slowBw) + fixed;
  else {
    // split: the share that does not fit runs from system RAM
    const fastShare = Math.min(1, Math.max(0.05, b.fast / (b.fast + (b.slowNeed || b.slow))));
    step = (perToken * fastShare) / (eff * b.fastBw) + (perToken * (1 - fastShare)) / (0.45 * b.slowBw) + fixed;
  }
  // With many users the GPU runs out of compute before bandwidth: 2 FLOPs per active parameter per token.
  if (users > 1) step = Math.max(step, (users * 2 * activeP) / (computeTf(b, where, runtime) * 1e3));
  return Math.min(250, 1 / (step * batchCost));
}

/** Usable TFLOPS of the machine for a runtime (spec-sheet × the share runtimes reach, see prefillOf). */
function computeTf(b, where, runtime) {
  const server = ['vllm', 'sglang'].includes(runtime);
  // GeForce spec sheets quote FP16 tensor TFLOPS with FP32 accumulation, which runs at half rate on
  // those cards; llama.cpp's int8 / FP16 kernels and vLLM reach roughly the quoted figure there.
  // Data-centre and workstation cards quote the full rate, of which runtimes reach about half.
  const util = b.kind === 'mac' ? 0.6 : b.kind === 'unified' ? (b.vendor === 'nvidia' ? (server ? 0.3 : 0.15) : 0.3)
    : b.vendor === 'nvidia' ? (b.geforce ? (server ? 0.8 : 0.9) : (server ? 0.55 : 0.45)) : 0.3;
  const gpuTf = (b.tf || 0) * util * (server && b.n > 1 ? b.n * 0.8 : 1);
  const cpuTf = (b.slowTf || 1) * 0.5;
  if (where === 'cpu' || !b.tf) return cpuTf;
  if (where === 'split' || where === 'moe-cpu') return 1 / (0.7 / gpuTf + 0.3 / cpuTf);
  return gpuTf;
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
  // gpt-oss ships in MXFP4: its GGUF / MLX builds keep that format, re-quantizing it gains nothing
  const base = kind === 'st' ? serverLadder(b.arch, m) : isGptOss(m) ? [['MXFP4', 0.55, 1]] : QUANTS[kind];
  const ladder = base.filter(([q]) => !(['F16', 'bf16'].includes(q) && p > 2 && s.priority > 10));
  const options = [];
  for (const [quant, bpp, q, key] of ladder) {
    let repo = kind === 'gguf' ? m.gguf : kind === 'mlx' ? m.mlx : m.id;
    let onTheFly = false;
    if (kind === 'st') {
      ({ repo, onTheFly } = serverRepo(m, key));
      if (!repo) continue; // no pre-quantized build of this format: skip rather than send people searching
    }
    const need = memNeeded(p, bpp, s, m);
    let where = null;
    if (b.fast && need.total <= b.fast) where = 'gpu';
    else if (b.slow && need.total <= b.fast + b.slow) where = b.fast ? 'split' : 'cpu';
    if (!where) continue;
    const bb = where === 'split' ? { ...b, slowNeed: need.total - b.fast } : b;
    // MoE routing and less regular memory access cost some of the theoretical speed-up.
    const t = speedOf(active, bpp, s, bb, where, runtime, kvOf(m, s.ctx), p) * (active < p ? MOE_EFF : 1);
    let opt = { quant, bpp, qf: q, need, where, gpuMem: where === 'split' ? b.fast : undefined, low: LOW_QUALITY.has(quant), tps: t, pp: prefillOf(m, where, b, runtime), download: p * bpp, repo, onTheFly };
    // Mixture of experts too big for the GPU: keeping the experts in RAM (llama.cpp --n-cpu-moe)
    // beats splitting whole layers, because attention and the shared weights stay on the GPU.
    if (where === 'split' && kind === 'gguf' && active < p && MOE_CPU_RUNTIMES.has(runtime)) {
      const mc = moeCpu(m, bpp, s, b, runtime);
      if (mc && mc.tps > opt.tps) opt = { ...opt, ...mc };
    }
    options.push(opt);
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

const MOE_CPU_RUNTIMES = new Set(['llamacpp', 'lmstudio', 'any']);

/**
 * A mixture of experts with its expert weights partly in system RAM: attention, shared experts,
 * embeddings and the KV cache stay on the GPU (about 40% of the active parameters), and as many expert
 * layers as fit. Each token reads its few active experts from wherever they live.
 */
export function moeCpu(m, bpp, s, b, runtime) {
  if (b.kind !== 'gpu' || !b.slow) return null;
  const active = m.a || m.p * 0.12;
  const dense = active * 0.4;
  const need = memNeeded(m.p, bpp, s, m);
  const gpuFixed = dense * bpp + need.kv + 0.5;
  if (gpuFixed > b.fast) return null;
  const experts = (m.p - dense) * bpp;
  // Without the layer count we cannot say how many layers to keep, so all experts go to RAM (--cpu-moe).
  const f = m.nl ? Math.max(0, Math.min(1, (b.fast - gpuFixed) / experts)) : 0;
  const ram = (1 - f) * experts;
  if (f >= 1 || ram > b.slow) return null;
  const users = Math.max(1, s.users || 1);
  const kvRead = kvOf(m, s.ctx) * (KV_FACTOR[s.kv] ?? 1) * 0.35 * users;
  const expertRead = (active - dense) * bpp;
  const step = (dense * bpp + expertRead * f + kvRead) / (0.75 * b.fastBw) + (expertRead * (1 - f)) / (0.45 * b.slowBw) + 0.002;
  return {
    where: 'moe-cpu',
    need: { ...need, gpu: gpuFixed + f * experts, ram },
    cpuMoe: m.nl ? Math.max(1, Math.ceil((1 - f) * m.nl)) : null,
    tps: Math.min(250, MOE_EFF / step),
    pp: prefillOf(m, 'moe-cpu', b, runtime),
  };
}

/**
 * Recompute memory and speed of an existing recommendation for per-model settings
 * (context, users, KV precision, speculative option) without changing its quantization.
 */
export function refit(r, s2, b, spec) {
  const { m, fit } = r;
  if (fit.tps == null || m.p == null) return { ...fit, spec: null, fits: true };
  const need = memNeeded(m.p, fit.bpp, s2, m);
  const extra = spec ? spec.draftP * 2 * 1.1 + (spec.method === 'mtp' ? need.weights * 0.03 : 0) : 0;
  const total = need.total + extra;
  const pool = fit.where === 'gpu' ? b.fast : b.fast + b.slow;
  const active = m.a || (m.moe ? m.p * 0.12 : m.p);
  const bb = fit.where === 'split' ? { ...b, slowNeed: Math.max(0, total - b.fast) } : b;
  const mc = fit.where === 'moe-cpu' ? moeCpu(m, fit.bpp, s2, b, r.rt) : null;
  const base = mc ? mc.tps : speedOf(active, fit.bpp, s2, bb, fit.where, r.rt, kvOf(m, s2.ctx), m.p) * (active < m.p ? MOE_EFF : 1);
  const pp = prefillOf(m, fit.where, b, r.rt);
  return {
    ...fit,
    spec,
    need: { ...(mc ? mc.need : need), draft: extra || undefined, total },
    ...(mc ? { cpuMoe: mc.cpuMoe } : {}),
    tpsBase: base,
    tps: spec ? withSpec(base, spec, s2.users) : base,
    pp,
    fits: total <= pool + 1e-9,
  };
}

/** Largest dense model (B) that fits fully in fast memory at each quantization. */
export function capacity(kind, s, b) {
  const mem = b.fast || b.slow;
  return (kind === 'st' ? serverLadder(b.arch) : QUANTS[kind]).filter(([q]) => !['F16', 'bf16'].includes(q) || kind === 'st').map(([name, bpp]) => {
    let lo = 0, hi = 3000;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (memNeeded(mid, bpp, s).total <= mem) lo = mid; else hi = mid; }
    return [name, lo];
  });
}

/* ------------------------------------------------------------------ ranking */

// capability name → bit, computed once per data file (models store their capabilities as a bit mask)
const BITS = new WeakMap();
function capBits(caps) {
  let bits = BITS.get(caps);
  if (!bits) { bits = Object.fromEntries(caps.map((c, i) => [c, 1 << i])); BITS.set(caps, bits); }
  return bits;
}
export const hasCap = (data, m, name) => (m.caps & (capBits(data.caps)[name] || 0)) !== 0;

export function runtimeKinds(s) {
  if (s.runtime !== 'any') return [RUNTIMES[s.runtime].kind];
  if (s.hw === 'mac') return ['mlx', 'gguf'];
  if (s.hw === 'cpu') return ['gguf'];
  const g = s.hw === 'gpu' ? gpuById(s.gpu) : null;
  if (g?.unified && s.ngpu > 1) return ['st']; // two linked units: only vLLM / SGLang span both
  if (g?.id?.startsWith('strix-halo')) return ['gguf']; // vLLM / SGLang ROCm builds do not target this iGPU yet
  if (s.gpu2 && s.gpu !== 'custom' && !g?.unified) return ['gguf']; // mixed cards: llama.cpp uses all their memory
  return ['gguf', 'st'];
}

/** Rough "how capable" proxy: bigger and less compressed is better; MoE counts between active and total. */
export const qualityOf = (m, fit) => Math.log2(1 + (m.a ? Math.sqrt(m.a * m.p) : m.p)) * (fit ? fit.qf : 1);

// Static per-model facts, computed once per data file: MoE flag and the near-duplicate key.
const PREPARED = new WeakSet();
function prepare(data) {
  if (PREPARED.has(data)) return;
  const moeBit = capBits(data.caps).moe || 0;
  for (const m of data.models) {
    m.moe = !!m.a || (m.caps & moeBit) !== 0;
    m.dup = m.id.split('/').pop().toLowerCase().replace(/[-_.](instruct|it|chat|gguf|awq|gptq|fp8|int[48]|bf16|nvfp4|mxfp4|mlx|w\d+a\d+|\d+bit|\d+gb)(?=[-_.]|$).*$/, '');
  }
  PREPARED.add(data);
}

export function recommend(data, s, today = Math.floor(Date.now() / 86400000)) {
  prepare(data);
  const use = USES.find((u) => u.v === s.use) || USES[0];
  const kindCfg = s.use === 'agents' ? agentKind(s.agent) : null;
  const b = budgetOf(s);
  const isLLM = LLM_USES.has(s.use);
  const kinds = runtimeKinds(s);
  const lo = SIZE_STOPS[s.sizeLo ?? 0], hi = SIZE_STOPS[s.sizeHi ?? SIZE_STOPS.length - 1];
  const sizeFiltered = (s.sizeLo ?? 0) > 0 || (s.sizeHi ?? SIZE_STOPS.length - 1) < SIZE_STOPS.length - 1;
  const bits = capBits(data.caps);
  const has = (m, c) => (m.caps & (bits[c] || 0)) !== 0;
  const toolFams = new Set(data.tool_families);
  const wQ = 1.8 * (1 - s.priority / 100) + 0.4;
  const wS = 1.8 * (s.priority / 100) + 0.2;
  const out = [];
  const must = new Set(Array.isArray(s.must) ? s.must : String(s.must || '').split(',').filter(Boolean));

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
    const isMoe = m.moe;
    if (s.archFilter === 'moe' && !isMoe) continue;
    if (s.archFilter === 'dense' && isMoe) continue;
    if (must.has('tools') && !has(m, 'tools') && !(toolFams.has(m.fam) && has(m, 'chat'))) continue;
    if (must.has('vision') && !has(m, 'vision')) continue;
    if (must.has('reasoning') && !has(m, 'reasoning') && !thinkingOf(m)) continue;
    if (must.has('longctx') && !(m.mc ? m.mc >= 131072 : has(m, 'longctx'))) continue;
    if (isLLM && /(^|[-_/])base([-_]|$)/.test(name) && !has(m, 'chat')) continue;
    if (s.use === 'vision' && !has(m, 'vision')) continue;
    if (s.use === 'code' && !has(m, 'code') && !(has(m, 'chat') && toolFams.has(m.fam))) continue;
    if (kindCfg?.requires && !has(m, kindCfg.requires)) continue;
    if (s.use === 'rag' && s.ragPart && s.ragPart !== 'both') {
      if (s.ragPart === 'rerank' && !has(m, 'rerank')) continue;
      if (s.ragPart === 'embed' && has(m, 'rerank')) continue;
    }

    let fit = null, kind = null, rt = null, specs = [];
    // A model cannot use more context than it was built for: size its cache and commands to its limit.
    const ctx = isLLM && m.mc ? Math.min(s.ctx, m.mc) : s.ctx;
    const sm = ctx === s.ctx ? s : { ...s, ctx };
    if (isLLM) {
      if (m.p == null) continue;
      for (const k of kinds) {
        if (kinds.length > 1 && k === 'gguf' && !m.gguf) continue;
        if (kinds.length > 1 && k === 'mlx' && !m.mlx) continue;
        if (k === 'st' && !m.st) continue;
        const f = fitModel(m, k, sm, b, s.runtime);
        if (!f) continue;
        if (!fit || (f.where === 'gpu' && fit.where !== 'gpu') || (f.where === fit.where && f.tps > fit.tps * 1.15)) { fit = f; kind = k; }
      }
      if (!fit) continue;
      // Speculative decoding: faster single-user generation for a little extra memory (the draft).
      rt = s.runtime !== 'any' ? s.runtime : kind === 'st' ? 'vllm' : kind === 'gguf' ? 'llamacpp' : kind;
      specs = specOptions(m, rt, sm);
      const spec = s.spec !== 'off' ? specs[0] || null : null;
      if (spec) {
        const extra = spec.draftP * 2 * 1.1 + (spec.method === 'mtp' ? fit.need.weights * 0.03 : 0);
        const room = (fit.where === 'gpu' ? b.fast : b.fast + b.slow) - fit.need.total;
        if (extra <= room) fit = { ...fit, spec, tpsBase: fit.tps, tps: withSpec(fit.tps, spec, s.users), need: { ...fit.need, draft: extra, total: fit.need.total + extra } };
      }
      if (must.has('spec') && !fit.spec) continue;
      if (must.has('prequant') && kind === 'st' && fit.repo === m.id && !fit.onTheFly && !(m.q && Object.values(m.q).includes(m.id))) continue;
      if (must.has('prequant') && kind === 'gguf' && !m.gguf) continue;
    } else {
      const p = m.p;
      const need = p != null ? p * 2 + (s.use === 'image' ? 3 : 0.6) : null;
      const mem = b.fast || b.slow;
      if (need != null && need > mem) continue;
      fit = { quant: '16-bit', bpp: 2, qf: 1, need: need != null ? { total: need, weights: p * 2, kv: 0 } : null, where: b.fast ? 'gpu' : 'cpu', low: false, tps: null, download: p != null ? p * 2 : null, repo: m.id };
      kind = 'st';
    }

    const why = [];
    let rel = 0;
    // relevance to the job
    if (kindCfg) {
      for (const [cap, w] of Object.entries(kindCfg.weights)) if (has(m, cap)) rel += w;
      if (!has(m, 'tools') && toolFams.has(m.fam) && has(m, 'chat')) { rel += 2; why.push(`${m.fam} instruct models support tool calling`); }
      if (m.p != null && m.p < kindCfg.minP) rel -= 2;
      if (has(m, 'swe') && s.agent === 'coding') why.push('Trained or evaluated for agentic coding (SWE-style tasks)');
      if (has(m, 'computer') && s.agent === 'computer') why.push('Built for GUI / computer use');
      if (has(m, 'sql') && s.agent === 'data') why.push('Trained for text-to-SQL');
      if (has(m, 'tools')) why.push('Tagged for tool calling');
    }
    if (s.use === 'code') { if (has(m, 'code')) { rel += 4; why.push('Built for code'); } if (has(m, 'swe')) rel += 1; }
    // Word error rate the developers report on LibriSpeech test-clean (lower is better)
    if (s.use === 'asr' && m.wer != null) { rel += m.wer <= 2 ? 1.5 : m.wer <= 3.5 ? 0.8 : 0; why.push(`${m.wer}% word error rate on LibriSpeech (clean), as reported by its developers`); }
    if (s.use === 'reasoning') { if (has(m, 'reasoning')) { rel += 4; why.push('Thinking / reasoning model'); } if (has(m, 'math')) rel += 1; }
    if (s.use === 'writing' && has(m, 'roleplay')) { rel += 3; why.push('Tuned for creative writing'); }
    if (s.use === 'vision' && has(m, 'computer')) rel += 0.5;
    if (['chat', 'agents', 'writing', 'reasoning'].includes(s.use)) rel += has(m, 'chat') ? 1 : -1.5;
    if (ctx < s.ctx) { rel -= s.ctx / ctx >= 4 ? 3 : 1.5; why.push(`Built for up to ${fmtTokens(m.mc)} tokens of context, less than the ${fmtTokens(s.ctx)} you asked for`); }
    else if (s.ctx >= 65536 && (m.mc ? m.mc >= 131072 : has(m, 'longctx'))) { rel += 1.5; why.push(m.mc ? `Handles up to ${fmtTokens(m.mc)} tokens of context` : 'Designed for long contexts'); }
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
    // Every term of the score is kept, so a card can show why it ranks where it does.
    const parts = [['Fits the job', rel], ['Popularity', pop], ['Recent release', fresh], ['From the original lab', official]];
    if (isLLM) parts.push(['Answer quality (size × precision)', wQ * quality * 0.9], ['Speed on your machine', wS * speed * 0.8]);
    const penalty = (label, x) => { if (x) parts.push([label, -x]); };
    if (fit.where === 'split') penalty('Part of it in system RAM', 1.5);
    if (fit.where === 'moe-cpu') {
      penalty('Experts in system RAM', 0.5);
      why.push(`Experts kept in system RAM (${fit.cpuMoe ? `llama.cpp --n-cpu-moe ${fit.cpuMoe}` : 'llama.cpp --cpu-moe'}): attention and the context stay on the GPU`);
    }
    if (fit.where === 'cpu' && b.kind !== 'cpu') penalty('Runs on the CPU', 1);
    if (fit.low) penalty('Very low precision', 1.5);
    // Too slow for the speed the user asked for: push it down (relative to the slider's target).
    if (isLLM && fit.tps != null) {
      const ratio = fit.tps / targetSpeed(s.priority);
      penalty('Slower than the speed you asked for', fit.tps < 3 ? 6 : ratio < 0.35 ? 4 : ratio < 0.6 ? 2 : ratio < 0.85 ? 0.7 : 0);
    }
    if (fit.spec) why.push(`${fit.spec.label}: ≈ ${round1(fit.tps / fit.tpsBase)}× faster generation${fit.spec.recent ? ' (needs a recent llama.cpp)' : ''}`);
    if (kind === 'st' && fit.repo !== m.id) why.push(`Pre-quantized ${fit.quant} build available for your ${b.arch === 'blackwell' && fit.quant === 'NVFP4' ? 'Blackwell GPU (native FP4)' : 'GPU'}`);
    if (kind === 'gguf' && !m.gguf) { penalty('No GGUF build tracked', 1.5); why.push('No GGUF build tracked yet: use the search link below'); }
    if (kind === 'mlx' && !m.mlx) penalty('No MLX build tracked', 1);
    const score = parts.reduce((t, [, v]) => t + v, 0);

    if (m.dl >= 10000) why.push(`${fmtCompact(m.dl)} downloads last month`);
    else if (m.likes >= 50) why.push(`${m.likes} likes`);
    if (age < 120) why.push('Released in the last 4 months');
    if (official) why.push('From the original lab');
    if (m.a) why.push(`Mixture of experts: ${m.a}B of ${round1(m.p)}B parameters work per token, so it runs like a ${m.a}B model`);
    else if (has(m, 'moe') && isLLM) why.push('Mixture of experts (active size not published): speed estimated at ~12% active');
    out.push({ m, fit, kind, score, parts, quality, why, rt, specs, ctx, reasoning: has(m, 'reasoning') });
  }

  out.sort((a, c) => c.score - a.score);
  // At most two near-copies of the same model (e.g. -Instruct and -FP8 uploads).
  const seen = new Map();
  const list = out.filter((r) => {
    const n = (seen.get(r.m.dup) || 0) + 1;
    seen.set(r.m.dup, n);
    return n <= 2;
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
/** Context sizes the way models advertise them: 131072 → 128K. */
export const fmtTokens = (n) => (n >= 1048576 ? `${round1(n / 1048576)}M` : `${Math.round(n / 1024)}K`);
function fmtCompact(n) {
  if (n >= 1e6) return `${round1(n / 1e6)}M`;
  if (n >= 1e3) return `${round1(n / 1e3)}K`;
  return String(n);
}
