// Ready-to-run commands and Docker Compose files for a recommendation.
// `o` holds the per-model options from the "Customize" panel (see defaultOptions).

import { LLM_USES, QUANTS, isCluster, isGptOss, parallelOf, sglangToolParser, thinkingOf, toolParser } from './engine.js';

/** What `ollama run` takes: the official library tag for gpt-oss, else the Hugging Face GGUF (with its quant). */
function ollamaRef(m, repo, quant) {
  const official = /^openai\/gpt-oss-(\d+b)$/i.exec(m.id);
  if (official) return `gpt-oss:${official[1].toLowerCase()}`;
  return `hf.co/${repo}${quant ? `:${quant}` : ''}`;
}
const RUNTIME_NAMES = { vllm: 'vLLM', sglang: 'SGLang', llamacpp: 'llama.cpp', ollama: 'Ollama', lmstudio: 'LM Studio', mlx: 'MLX', transformers: 'Transformers' };
const search = (q) => `https://huggingface.co/models?search=${encodeURIComponent(q)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Options a user can change per recommendation, starting from the global settings. */
export function defaultOptions(r, s, b) {
  const think = thinkingOf({ ...r.m, reasoning: r.reasoning });
  return {
    spec: r.fit.spec ? r.fit.spec.method : 'off',
    specTokens: r.fit.spec ? defaultSpecTokens(r.fit.spec.method) : 3,
    think: think?.mode === 'effort' ? 'medium' : s.think || 'default',
    reasoningParser: true,
    ctx: r.ctx ?? s.ctx, // already capped to what the model supports
    users: s.users,
    gpuUtil: b.kind === 'unified' ? 0.8 : 0.9,
    kv: s.kv,
    port: null,
    apiKey: false,
    servedName: '',
    tools: s.use === 'agents',
    prefixCache: true,
    expertParallel: false,
    imageTag: 'latest',
    restart: true,
    healthcheck: true,
    stackUi: true,
    stackRag: true,
  };
}
export const defaultSpecTokens = (method) => (method?.startsWith('dflash') ? 8 : method === 'dspark' ? 7 : 3);

/* ------------------------------------------------------------------ compose helpers */

function gpuBlock(b) {
  if (b.vendor === 'amd') return ['    devices:', '      - /dev/kfd', '      - /dev/dri', '    group_add:', '      - video'];
  if (b.vendor === 'intel') return ['    devices:', '      - /dev/dri'];
  if (b.kind === 'mac' || b.kind === 'cpu') return [];
  return ['    deploy:', '      resources:', '        reservations:', '          devices:', '            - driver: nvidia', '              count: all', '              capabilities: [gpu]'];
}
const hfCache = (path = '/root/.cache/huggingface') => ['    volumes:', `      - ~/.cache/huggingface:${path}`];
const envBlock = (list) => (list.length ? ['    environment:', ...list.map((e) => `      - ${e}`)] : []);
const commandBlock = (args) => ['    command: >', ...args.map((a) => `      ${a}`)];
const restartBlock = (o) => (o.restart ? ['    restart: unless-stopped'] : []);
const healthBlock = (o, url) => (o.healthcheck
  ? ['    healthcheck:', `      test: ["CMD-SHELL", "curl -fsS ${url} || exit 1"]`, '      interval: 30s', '      timeout: 5s', '      retries: 20', '      start_period: 120s']
  : []);
const armNote = (b) => (b.arm ? ['# ARM64 (DGX Spark / Jetson): if this image has no arm64 build, use NVIDIA\'s container from NGC (nvcr.io/nvidia/…) with the same command.'] : []);
const macNote = (b) => (b.kind === 'mac' ? ['# macOS: containers cannot use the Apple GPU, so this runs on the CPU. Install the app natively for full speed.'] : []);
const gatedEnv = (m) => (m.gated ? ['HF_TOKEN=${HF_TOKEN}   # gated model: accept its terms on Hugging Face first'] : []);

/* ------------------------------------------------------------------ vLLM */

function vllmArgs(r, b, o, repo) {
  const { m, fit } = r;
  const think = thinkingOf({ ...m, reasoning: r.reasoning });
  const args = [`--model ${repo}`, `--max-model-len ${o.ctx}`, `--host 0.0.0.0 --port ${o.port || 8000}`];
  if (b.n > 1) {
    const { tp, pp } = isCluster(b) ? { tp: b.n, pp: 1 } : parallelOf(b.n);
    if (tp > 1) args.push(`--tensor-parallel-size ${tp}`);
    if (pp > 1) args.push(`--pipeline-parallel-size ${pp}`);
    // Two linked machines: vLLM's own multi-node mode (no Ray); the second node runs headless
    if (isCluster(b)) args.push(`--nnodes ${b.n} --node-rank \${NODE_RANK:-0} --master-addr \${HEAD_IP} \${VLLM_WORKER_FLAGS:-}`);
  }
  if (o.expertParallel && b.n > 1) args.push('--enable-expert-parallel');
  if (fit.onTheFly) args.push('--quantization fp8');
  args.push(`--gpu-memory-utilization ${o.gpuUtil}`);
  if (o.kv !== 'f16') args.push('--kv-cache-dtype fp8');
  if (o.users > 1) args.push(`--max-num-seqs ${Math.max(8, o.users)}`);
  if (!o.prefixCache) args.push('--no-enable-prefix-caching');
  if (o.servedName) args.push(`--served-model-name ${o.servedName}`);
  if (o.apiKey) args.push('--api-key ${VLLM_API_KEY}');
  const sp = o.specObj;
  if (sp) {
    if (sp.draft) args.push('--trust-remote-code'); // DFlash / DSpark / EAGLE drafters ship custom code
    if (sp.method === 'mtp') args.push(`--speculative-config '{"method": "mtp", "num_speculative_tokens": ${o.specTokens}}'`); // vLLM maps every model's MTP to "mtp"
    else args.push(`--speculative-config '{"method": "${sp.method.startsWith('dflash') ? 'dflash' : sp.method}", "model": "${sp.draft}", "num_speculative_tokens": ${o.specTokens}}'`);
  }
  if (think && o.reasoningParser && think.vllmParser) args.push(`--reasoning-parser ${think.vllmParser}`);
  if (think?.mode === 'hybrid' && o.think === 'off') args.push(`--default-chat-template-kwargs '{"enable_thinking": false}'`);
  // without a known parser vLLM would refuse to start: leave tool calling to the model card
  if (o.tools && toolParser(m)) args.push(`--enable-auto-tool-choice --tool-call-parser ${toolParser(m)}`);
  return args;
}

const clusterNote = (b, how) => (isCluster(b)
  ? [`# ${b.n} linked units: ${how}`, '# Connect them with the QSFP cable first (NVIDIA DGX Spark playbook: "Connect two Sparks").']
  : []);

function vllmCompose(r, b, o, repo) {
  const env = [...gatedEnv(r.m), ...(o.apiKey ? ['VLLM_API_KEY=${VLLM_API_KEY}   # put it in a .env file next to this compose'] : [])];
  return [
    ...armNote(b),
    ...clusterNote(b, 'run this file on both. In a .env file next to it: HEAD_IP=<first unit\'s IP> on both, NODE_RANK=1 and VLLM_WORKER_FLAGS=--headless on the second.'),
    'services:',
    '  vllm:',
    // the ROCm image with the same `vllm serve` entrypoint as the CUDA one
    `    image: ${b.vendor === 'amd' ? 'vllm/vllm-openai-rocm' : 'vllm/vllm-openai'}:${o.imageTag}`,
    '    ipc: host',
    // linked units talk over the host network (NCCL / Ray), so the API port is the host's
    ...(isCluster(b) ? ['    network_mode: host'] : ['    ports:', `      - "${o.port || 8000}:${o.port || 8000}"`]),
    ...hfCache(),
    ...envBlock(env),
    ...gpuBlock(b),
    ...restartBlock(o),
    ...healthBlock(o, `http://localhost:${o.port || 8000}/health`),
    ...commandBlock(vllmArgs(r, b, o, repo)),
  ].join('\n');
}

/* ------------------------------------------------------------------ SGLang */

function sglangArgs(r, b, o, repo) {
  const { m, fit } = r;
  const think = thinkingOf({ ...m, reasoning: r.reasoning });
  const args = ['python3 -m sglang.launch_server', `--model-path ${repo}`, `--context-length ${o.ctx}`, `--host 0.0.0.0 --port ${o.port || 30000}`];
  if (b.n > 1) {
    const { tp, pp } = isCluster(b) ? { tp: b.n, pp: 1 } : parallelOf(b.n);
    if (tp > 1) args.push(`--tp-size ${tp}`);
    if (pp > 1) args.push(`--pp-size ${pp}`);
    if (isCluster(b)) args.push(`--nnodes ${b.n} --node-rank \${NODE_RANK:-0} --dist-init-addr \${HEAD_IP}:20000`);
  }
  if (fit.onTheFly) args.push('--quantization fp8');
  args.push(`--mem-fraction-static ${Math.min(0.9, o.gpuUtil).toFixed(2)}`);
  if (o.kv !== 'f16') args.push('--kv-cache-dtype fp8_e5m2');
  if (o.users > 1) args.push(`--max-running-requests ${Math.max(8, o.users)}`);
  if (!o.prefixCache) args.push('--disable-radix-cache');
  if (o.servedName) args.push(`--served-model-name ${o.servedName}`);
  if (o.apiKey) args.push('--api-key ${SGLANG_API_KEY}');
  const sp = o.specObj;
  if (sp) {
    if (sp.method === 'mtp') args.push(`--speculative-algorithm NEXTN --speculative-num-steps ${o.specTokens} --speculative-eagle-topk 1 --speculative-num-draft-tokens ${o.specTokens + 1}`);
    else if (sp.method.startsWith('dflash')) args.push(`--speculative-algorithm DFLASH --speculative-draft-model-path ${sp.draft} --speculative-dflash-block-size ${o.specTokens} --trust-remote-code`);
    else if (sp.method === 'dspark') args.push(`--speculative-algorithm DSPARK --speculative-draft-model-path ${sp.draft} --speculative-dspark-block-size ${o.specTokens} --trust-remote-code`);
    else args.push(`--speculative-algorithm EAGLE3 --speculative-draft-model-path ${sp.draft} --speculative-num-steps ${o.specTokens} --speculative-eagle-topk 1 --speculative-num-draft-tokens ${o.specTokens + 1}`);
  }
  if (think && o.reasoningParser && think.sglangParser) args.push(`--reasoning-parser ${think.sglangParser}`);
  if (think?.mode === 'hybrid' && o.think === 'off') args.push(`--default-chat-template-kwargs '{"enable_thinking": false}'`);
  if (think?.mode === 'effort') args.push(`--default-chat-template-kwargs '{"reasoning_effort": "${o.think}"}'`);
  if (o.tools && sglangToolParser(m)) args.push(`--tool-call-parser ${sglangToolParser(m)}`);
  return args;
}

/**
 * SGLang image tag. The CUDA 13 build is multi-arch (amd64 + arm64) and covers Blackwell, including the
 * DGX Spark; AMD Instinct cards need a ROCm tag (there is no floating "latest" ROCm tag).
 */
function sglangTag(b, o) {
  if (o.imageTag !== 'latest') return o.imageTag;
  if (b.vendor === 'amd') return /MI35/.test(b.label) ? 'v0.5.22-rocm720-mi35x' : 'v0.5.22-rocm720-mi30x';
  return b.arch === 'blackwell' || b.arm ? 'latest-cu130' : 'latest';
}

function sglangCompose(r, b, o, repo) {
  const env = [...gatedEnv(r.m), ...(o.apiKey ? ['SGLANG_API_KEY=${SGLANG_API_KEY}   # put it in a .env file next to this compose'] : [])];
  return [
    ...(b.id === 'dgx-spark' ? [] : armNote(b)),
    ...clusterNote(b, 'run this file on both, with HEAD_IP=<first unit\'s IP> and NODE_RANK=0 on the first, NODE_RANK=1 on the second (in a .env file).'),
    ...(b.vendor === 'amd' ? ['# AMD Instinct: ROCm build of SGLang (pick the newest vX.Y.Z-rocm…-mi30x / -mi35x tag).'] : []),
    'services:',
    '  sglang:',
    `    image: lmsysorg/sglang:${sglangTag(b, o)}`,
    '    ipc: host',
    '    shm_size: 32g',
    // linked units talk over the host network (NCCL / Ray), so the API port is the host's
    ...(isCluster(b) ? ['    network_mode: host'] : ['    ports:', `      - "${o.port || 30000}:${o.port || 30000}"`]),
    ...hfCache(),
    ...envBlock(env),
    ...gpuBlock(b),
    ...restartBlock(o),
    ...healthBlock(o, `http://localhost:${o.port || 30000}/health`),
    ...commandBlock(sglangArgs(r, b, o, repo)),
  ].join('\n');
}

/* ------------------------------------------------------------------ Ollama */

function ollamaEnv(o, server) {
  const env = [];
  if (o.ctx > 4096) env.push(`OLLAMA_CONTEXT_LENGTH=${o.ctx}`);
  if (o.kv !== 'f16') env.push('OLLAMA_FLASH_ATTENTION=1', `OLLAMA_KV_CACHE_TYPE=${o.kv === 'q8' ? 'q8_0' : 'q4_0'}`);
  if (o.users > 1) env.push(`OLLAMA_NUM_PARALLEL=${Math.min(o.users, 16)}`);
  if (server) env.push('OLLAMA_KEEP_ALIVE=30m');
  return env;
}
function ollamaThinkFlag(r, o) {
  const think = thinkingOf({ ...r.m, reasoning: r.reasoning });
  if (think?.mode === 'effort') return ` --think=${o.think}`;
  if (think?.mode === 'hybrid' && o.think !== 'default') return ` --think=${o.think === 'off' ? 'false' : 'true'}`;
  return '';
}
function ollamaCompose(r, b, o, repo, quant) {
  return [
    ...macNote(b),
    'services:',
    '  ollama:',
    `    image: ollama/ollama:${b.vendor === 'amd' ? 'rocm' : o.imageTag}`,
    '    ports:',
    `      - "${o.port || 11434}:11434"`,
    '    volumes:',
    '      - ollama:/root/.ollama',
    ...envBlock(ollamaEnv(o, true)),
    ...gpuBlock(b),
    ...restartBlock(o),
    'volumes:',
    '  ollama: {}',
    '',
    `# then: docker compose exec ollama ollama run ${ollamaRef(r.m, repo, quant)}${ollamaThinkFlag(r, o)}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ llama.cpp */

function llamacppArgs(r, o, repo, quant) {
  const sp = o.specObj;
  const think = thinkingOf({ ...r.m, reasoning: r.reasoning });
  // MTP-preserving GGUF repos name their files differently, so let llama.cpp pick the default file there.
  // Layers on the GPU: all of them, unless whole layers have to spill into system RAM.
  const f = r.fit;
  const ngl = f.where === 'split' && r.m.nl && f.need?.total ? Math.max(0, Math.floor(r.m.nl * Math.min(1, (f.gpuMem || 0) / f.need.total))) : 99;
  const args = [`-hf ${sp?.method === 'mtp' ? sp.gguf : `${repo}${quant ? `:${quant}` : ''}`}`, `-c ${o.ctx}`, `-ngl ${ngl}`, `--host 0.0.0.0 --port ${o.port || 8080}`];
  if (o.kv !== 'f16') args.push(`-fa on -ctk ${o.kv === 'q8' ? 'q8_0' : 'q4_0'} -ctv ${o.kv === 'q8' ? 'q8_0' : 'q4_0'}`);
  // MoE too big for the GPU: keep the experts of the first N layers in RAM, everything else on the GPU
  if (r.fit.where === 'moe-cpu') args.push(r.fit.cpuMoe ? `--n-cpu-moe ${r.fit.cpuMoe}` : '--cpu-moe');
  if (o.users > 1 && sp?.method !== 'mtp') args.push(`-np ${o.users}`);
  if (sp?.method === 'mtp') args.push('--spec-type draft-mtp');
  if (sp?.draft) {
    // DFlash and DFlash2 share one type (llama.cpp reads which from the draft GGUF); draft tokens are capped at its block size
    const type = { dflash2: 'draft-dflash', dflash: 'draft-dflash', dspark: 'draft-dspark', eagle3: 'draft-eagle3' }[sp.method];
    args.push(`-hfd ${sp.draft} --spec-type ${type} --spec-draft-n-max ${o.specTokens}`);
  }
  if (o.tools || think) args.push('--jinja');
  if (think?.mode === 'hybrid' && o.think === 'off') args.push('--reasoning-budget 0');
  if (think?.mode === 'effort') args.push(`--chat-template-kwargs '{"reasoning_effort": "${o.think}"}'`);
  if (o.apiKey) args.push('--api-key ${LLAMA_API_KEY}');
  if (o.servedName) args.push(`--alias ${o.servedName}`);
  return args;
}
function llamacppCompose(r, b, o, repo, quant) {
  const tag = b.kind === 'cpu' || b.kind === 'mac' ? 'server' : b.vendor === 'amd' || b.vendor === 'intel' ? 'server-vulkan' : 'server-cuda';
  return [
    ...armNote(b),
    ...macNote(b),
    'services:',
    '  llama:',
    `    image: ghcr.io/ggml-org/llama.cpp:${tag}`,
    '    ports:',
    `      - "${o.port || 8080}:${o.port || 8080}"`,
    '    volumes:',
    '      - ~/.cache/huggingface:/root/.cache/huggingface', // where -hf downloads
    ...envBlock(o.apiKey ? ['LLAMA_API_KEY=${LLAMA_API_KEY}   # put it in a .env file next to this compose'] : []),
    ...gpuBlock(b),
    ...restartBlock(o),
    ...healthBlock(o, `http://localhost:${o.port || 8080}/health`),
    ...commandBlock(llamacppArgs(r, o, repo, quant)),
  ].join('\n');
}

/* ------------------------------------------------------------------ full stack */

const TEI = '1.9';
/**
 * Text Embeddings Inference image for this machine. TEI publishes one CUDA build per GPU generation
 * (1.9 adds Blackwell: 120 for RTX 50 / RTX PRO, 100 for B200, 121 for the DGX Spark's GB10) and CPU
 * builds for amd64 and arm64; where no CUDA build matches (AMD, Intel, Jetson, B300) the CPU build runs
 * the small embedding models fine.
 */
export function teiImage(b, shared = false) {
  const arm = b.arm || b.kind === 'mac';
  const cpu = `${arm ? 'cpu-arm64' : 'cpu'}-${TEI}`;
  // `shared`: vLLM / SGLang reserve most of the GPU memory up front, so TEI next to them runs on the CPU
  let tag = cpu;
  if (!shared && b.vendor === 'nvidia' && (b.kind === 'gpu' || b.kind === 'unified')) {
    if (b.id === 'dgx-spark') tag = `121-${TEI}`;
    else if (arm) tag = cpu;
    else if (b.arch === 'turing') tag = `turing-${TEI}`;
    else if (b.arch === 'ampere') tag = /A100/.test(b.label) ? TEI : `86-${TEI}`;
    else if (b.arch === 'ada') tag = `89-${TEI}`;
    else if (b.arch === 'hopper') tag = `hopper-${TEI}`;
    else if (b.arch === 'blackwell') tag = /B200/.test(b.label) ? `100-${TEI}` : /B300/.test(b.label) ? cpu : `120-${TEI}`;
  }
  return { image: `ghcr.io/huggingface/text-embeddings-inference:${tag}`, gpu: !tag.startsWith('cpu') };
}

/** Split a generated compose file into its parts so several can be merged into one. */
function splitCompose(text) {
  const parts = { head: [], services: [], volumes: [], tail: [] };
  let sec = 'head';
  for (const l of text.split('\n')) {
    if (l === 'services:') { sec = 'services'; continue; }
    if (l === 'volumes:') { sec = 'volumes'; continue; }
    if (sec !== 'head' && (l === '' || /^\S/.test(l))) sec = 'tail';
    if (l !== '' || sec === 'head') parts[sec].push(l);
  }
  return parts;
}

/**
 * One compose file with the model server, Open WebUI wired to it, and (optionally) an embedding model
 * and a reranker for retrieval. `base` is the model server's compose (null when it runs natively, e.g.
 * on a Mac, and Open WebUI then talks to the host).
 */
function stackCompose(r, b, o, base, stack) {
  const parts = base ? splitCompose(base.text) : { head: [], services: [], volumes: [], tail: [] };
  const services = [...parts.services];
  const volumes = new Set(parts.volumes.map((l) => l.trim()).filter(Boolean));
  const env = [];
  if (base?.kind === 'ollama' || (!base && ['ollama', 'any'].includes(r.rtHost))) {
    env.push(`OLLAMA_BASE_URL=${base ? 'http://ollama:11434' : 'http://host.docker.internal:11434'}`);
  } else {
    const url = base ? base.url : `http://host.docker.internal:${r.rtHost === 'lmstudio' ? 1234 : 8080}/v1`;
    env.push(`OPENAI_API_BASE_URL=${url}`, `OPENAI_API_KEY=${o.apiKey && base?.keyVar ? `\${${base.keyVar}}` : 'none'}`, 'ENABLE_OLLAMA_API=false');
  }
  env.push('WEBUI_SECRET_KEY=${WEBUI_SECRET_KEY:-change-me}');
  const tei = teiImage(b, ['vllm', 'sglang'].includes(base?.kind));
  // host ports already taken by the model server: give the other services free ones
  const used = new Set(parts.services.map((l) => /^\s+- "(\d+):/.exec(l)?.[1]).filter(Boolean).map(Number));
  const free = (p) => { while (used.has(p)) p++; used.add(p); return p; };
  const uiPort = free(3000);
  const embedPort = free(8081);
  const rerankPort = free(embedPort + 1);
  const rag = o.stackRag && stack?.embed;
  if (rag) {
    env.push('RAG_EMBEDDING_ENGINE=openai', 'RAG_OPENAI_API_BASE_URL=http://embeddings:80/v1', 'RAG_OPENAI_API_KEY=none', `RAG_EMBEDDING_MODEL=${stack.embed}`);
  }
  // Open WebUI's external reranker speaks a different API than TEI's /rerank, so with the chat UI the
  // reranker runs inside Open WebUI (hybrid search); without it, TEI serves it for your own code.
  const uiRerank = o.stackUi && o.stackRag && stack?.rerank;
  if (uiRerank) env.push('ENABLE_RAG_HYBRID_SEARCH=true', `RAG_RERANKING_MODEL=${stack.rerank}`);
  const teiService = (name, model, port) => [
    `  ${name}:`,
    `    image: ${tei.image}`,
    '    ports:',
    `      - "${port}:80"`,
    '    volumes:',
    '      - ~/.cache/huggingface:/data',
    ...(tei.gpu ? gpuBlock(b).map((l) => l) : []),
    ...restartBlock(o),
    ...commandBlock([`--model-id ${model}`]),
  ];
  if (o.stackUi) {
    services.push(
      '  open-webui:',
      '    image: ghcr.io/open-webui/open-webui:main',
      '    ports:',
      `      - "${uiPort}:8080"`,
      '    volumes:',
      '      - open-webui:/app/backend/data',
      ...envBlock(env),
      ...(base ? [] : ['    extra_hosts:', '      - "host.docker.internal:host-gateway"']),
      ...((base || rag) ? ['    depends_on:', ...(base ? [`      - ${base.kind}`] : []), ...(rag ? ['      - embeddings'] : [])] : []),
      ...restartBlock(o),
    );
    volumes.add('open-webui: {}');
  }
  if (rag) services.push(...teiService('embeddings', stack.embed, embedPort));
  if (o.stackRag && stack?.rerank && !uiRerank) services.push(...teiService('reranker', stack.rerank, rerankPort));
  const notes = [
    ...parts.head,
    '# Put a .env file next to this one with WEBUI_SECRET_KEY=<any long random string>' + (r.m.gated ? ' and HF_TOKEN=<your token>' : '') + '.',
    ...(o.stackUi || rag ? [`# ${[o.stackUi && `Chat UI: http://localhost:${uiPort}`, rag && `embeddings: http://localhost:${embedPort}/v1/embeddings`, o.stackRag && stack?.rerank && !uiRerank && `reranker: http://localhost:${rerankPort}/rerank`, uiRerank && `reranking by ${stack.rerank} inside Open WebUI`].filter(Boolean).join(' · ')}`] : []),
  ];
  return [...notes, 'services:', ...services, ...(volumes.size ? ['volumes:', ...[...volumes].map((v) => `  ${v}`)] : []), ...(parts.tail.length ? ['', ...parts.tail] : [])].join('\n');
}

/* ------------------------------------------------------------------ entry point */

/**
 * Tabs of commands for one recommendation: [{label, code?, note?, yaml?}], the chosen runtime first.
 * `opts` are the per-model options (defaultOptions + the user's changes); `specs` the speculative
 * options available for the runtime that will run it.
 */
export function commandsFor(r, s, b, caps, opts, specs = [], stack = null) {
  const { m, fit, kind } = r;
  const o = { ...defaultOptions(r, s, b), ...(opts || {}) };
  o.specObj = o.spec === 'off' ? null : specs.find((x) => x.method === o.spec) || null;
  const base = m.id.split('/').pop();
  const out = [];
  if (!LLM_USES.has(s.use)) {
    if (s.use === 'rag') {
      const isRerank = (m.caps >> caps.indexOf('rerank')) & 1;
      out.push({ label: 'Python', code: isRerank
        ? `pip install sentence-transformers\npython -c "from sentence_transformers import CrossEncoder as C; print(C('${m.id}').predict([('query', 'passage')]))"`
        : `pip install sentence-transformers\npython -c "from sentence_transformers import SentenceTransformer as S; print(S('${m.id}').encode(['hello world']).shape)"` });
      const tei = teiImage(b);
      out.push({ label: 'Docker Compose (TEI)', yaml: true, code: ['services:', '  tei:', `    image: ${tei.image}`, '    ports:', '      - "8080:80"', ...hfCache('/data'), ...(tei.gpu ? gpuBlock(b) : []), ...restartBlock(o), ...commandBlock([`--model-id ${m.id}`])].join('\n'), note: `Text Embeddings Inference serves embeddings and rerankers over HTTP${tei.gpu ? '' : ' (CPU build: small embedding models run fine on it)'}.` });
    } else if (s.use === 'asr') {
      if (m.lib === 'nemo') {
        // NVIDIA NeMo checkpoints (Parakeet, Canary…) load with NeMo, not transformers
        out.push({ label: 'Python (NeMo)', code: `pip install -U "nemo_toolkit[asr]"\npython -c "import nemo.collections.asr as a; m = a.models.ASRModel.from_pretrained('${m.id}'); print(m.transcribe(['audio.wav'])[0].text)"`, note: 'NeMo models expect 16 kHz mono WAV or FLAC audio.' });
      } else if (!m.lib || m.lib === 'transformers') {
        out.push({ label: 'Python', code: `pip install transformers torch\npython -c "from transformers import pipeline; print(pipeline('automatic-speech-recognition', model='${m.id}')('audio.mp3'))"` });
      } else {
        out.push({ label: 'Model page', note: `This model is built for <strong>${esc(m.lib)}</strong>, not the transformers pipeline: follow the usage on <a href="https://huggingface.co/${esc(m.id)}" rel="noopener">its model card</a>.` });
      }
      if (/whisper/i.test(m.id)) out.push({ label: 'whisper.cpp', note: 'Whisper models also run very fast with whisper.cpp or faster-whisper.' });
    } else if (s.use === 'image' && m.lib && m.lib !== 'diffusers') {
      out.push({ label: 'Model page', note: `This model is built for <strong>${esc(m.lib)}</strong>, not diffusers: follow the usage on <a href="https://huggingface.co/${esc(m.id)}" rel="noopener">its model card</a>.` });
      out.push({ label: 'ComfyUI', note: 'ComfyUI (and Draw Things on Mac) load most image models with a visual workflow editor.' });
    } else if (s.use === 'image') {
      out.push({ label: 'Python', code: `pip install diffusers transformers torch\npython -c "from diffusers import DiffusionPipeline as P; P.from_pretrained('${m.id}').to('${b.kind === 'mac' ? 'mps' : 'cuda'}')('a lighthouse at dawn').images[0].save('out.png')"` });
      out.push({ label: 'ComfyUI', note: 'ComfyUI (and Draw Things on Mac) load most of these models with a visual workflow editor.' });
    } else {
      out.push({ label: 'Model page', note: 'Text-to-speech models each ship their own runner: follow the instructions on the model page.' });
    }
    return out;
  }

  const think = thinkingOf({ ...m, reasoning: r.reasoning });
  const thinkNote = think?.mode === 'hybrid' && o.think === 'off'
    ? 'Thinking is off for every request; a client can still turn it on per request with <code>"chat_template_kwargs": {"enable_thinking": true}</code>.'
    : think?.mode === 'effort' ? `Reasoning effort “${esc(o.think)}”; clients can also send <code>"reasoning_effort"</code> per request.` : '';
  // gpt-oss GGUFs hold one MXFP4 file: no quant suffix to choose
  const ggufQ = isGptOss(m) ? null : QUANTS.gguf.find(([n]) => n === fit.quant) ? fit.quant : 'Q4_K_M';
  const repo = m.gguf;
  const tabs = {};
  if (repo) {
    const env = ollamaEnv(o, false);
    tabs.ollama = { label: 'Ollama', code: `${env.length ? `${env.join(' ')} ollama serve   # in one terminal\n` : ''}ollama run ${ollamaRef(m, repo, ggufQ)}${ollamaThinkFlag(r, o)}`, note: `${o.tools ? 'OpenAI-compatible API with tool calling at http://localhost:11434/v1. ' : ''}${fit.where === 'moe-cpu' ? 'Ollama spills whole layers into RAM, which is slower for this model than llama.cpp keeping only the experts there (see the llama.cpp tab). ' : ''}Ollama does not do speculative decoding: use llama.cpp, vLLM or SGLang for that.` };
    tabs.ollamaDocker = { label: 'Ollama (Docker Compose)', yaml: true, code: ollamaCompose(r, b, o, repo, ggufQ) };
    const lo = { ...o, specObj: kind === 'gguf' ? o.specObj : null };
    tabs.llamacpp = { label: 'llama.cpp', code: `llama-server ${llamacppArgs(r, lo, repo, ggufQ).join(' ')}`, note: [`Chat UI and OpenAI-compatible API at http://localhost:${o.port || 8080}.`, lo.specObj?.method === 'mtp' ? 'MTP uses the MTP-preserving GGUF (add <code>:&lt;quant&gt;</code> to pick a file); it does not work with several parallel users or with images.' : '', lo.specObj?.recent ? `${esc(lo.specObj.label)} needs a recent llama.cpp build (it reads the drafter type from the GGUF).` : '', thinkNote].filter(Boolean).join(' ') };
    tabs.llamacppDocker = { label: 'llama.cpp (Docker Compose)', yaml: true, code: llamacppCompose(r, b, lo, repo, ggufQ) };
    tabs.lmstudio = { label: 'LM Studio', code: `lms get https://huggingface.co/${repo}${ggufQ ? `@${ggufQ}` : ''}`, note: `Or search “${esc(repo)}” in LM Studio${ggufQ ? ` and pick the <strong>${esc(ggufQ)}</strong> file` : ''}.${fit.where === 'moe-cpu' ? ' In the load settings turn on <strong>Force model expert weights onto CPU</strong> (or set how many layers keep their experts on the CPU).' : ''}` };
  } else {
    tabs.ollama = { label: 'Ollama', note: `No GGUF build of this model is tracked yet. <a href="${search(`${base} gguf`)}" rel="noopener">Search GGUF builds on Hugging Face</a>, then run <code>ollama run hf.co/&lt;repo&gt;${ggufQ ? `:${esc(ggufQ)}` : ''}</code>.` };
  }
  if (b.kind === 'mac') {
    tabs.mlx = { label: 'MLX', code: m.mlx ? `pip install mlx-lm\nmlx_lm.server --model ${m.mlx} --port ${o.port || 8080}` : `pip install mlx-lm\nmlx_lm.convert --hf-path ${m.id} -q\nmlx_lm.server --model mlx_model --port ${o.port || 8080}`, note: `${m.mlx ? '' : 'No MLX build tracked: this converts the original to 4-bit locally. '}For a terminal chat use <code>mlx_lm.chat --model …</code>.` };
  }
  if (m.st && b.kind !== 'mac' && b.kind !== 'cpu' && kind === 'st') {
    const srepo = fit.repo;
    const specNote = o.specObj ? `Speculative decoding: ${esc(o.specObj.label)}${o.specObj.draft ? ` (<a href="https://huggingface.co/${esc(o.specObj.draft)}" rel="noopener">${esc(o.specObj.draft)}</a>)` : ''}; needs a recent vLLM / SGLang release, check the draft's model card if a flag is rejected.` : '';
    const quantNote = fit.onTheFly ? 'No FP8 build tracked, so the original weights are quantized to FP8 when loading.' : '';
    // vLLM has no server-wide reasoning effort for gpt-oss: clients send it with each request
    const vllmThink = think?.mode === 'effort' ? `Reasoning effort: send <code>"reasoning_effort": "${esc(o.think)}"</code> with each request (vLLM has no server-wide setting for it).` : thinkNote;
    const toolsNote = o.tools && !toolParser(m) ? 'No vLLM tool-call parser is known for this model: check its model card for <code>--tool-call-parser</code> before enabling tool calling.' : '';
    tabs.vllm = { label: 'vLLM (Docker Compose)', yaml: true, code: vllmCompose(r, b, o, srepo), note: [quantNote, specNote, vllmThink, toolsNote, `Start with <code>docker compose up -d</code>; OpenAI-compatible API at http://localhost:${o.port || 8000}/v1.`].filter(Boolean).join(' ') };
    tabs.sglang = { label: 'SGLang (Docker Compose)', yaml: true, code: sglangCompose(r, b, o, srepo), note: [quantNote, specNote, thinkNote, `Start with <code>docker compose up -d</code>; OpenAI-compatible API at http://localhost:${o.port || 30000}/v1.`].filter(Boolean).join(' ') };
    tabs.vllmCli = { label: 'vLLM (pip)', code: `pip install vllm\nvllm serve ${srepo} \\\n  ${vllmArgs(r, b, o, srepo).slice(1).join(' \\\n  ')}` };
    tabs.transformers = { label: 'Transformers', code: `pip install transformers accelerate torch\npython -c "from transformers import pipeline; p = pipeline('text-generation', model='${m.id}', device_map='auto'); print(p([{'role': 'user', 'content': 'Hello!'}], max_new_tokens=100))"`, note: 'Simple and slow: fine for a quick test; use vLLM or SGLang to serve.' };
  }
  const order = {
    ollama: ['ollama', 'ollamaDocker', 'llamacpp', 'llamacppDocker', 'lmstudio', 'vllm', 'sglang', 'mlx'],
    lmstudio: ['lmstudio', 'ollama', 'llamacpp', 'llamacppDocker', 'mlx', 'vllm', 'sglang'],
    llamacpp: ['llamacpp', 'llamacppDocker', 'ollama', 'lmstudio', 'vllm', 'sglang', 'mlx'],
    mlx: ['mlx', 'ollama', 'lmstudio', 'llamacpp'],
    vllm: ['vllm', 'vllmCli', 'sglang', 'ollama', 'llamacpp'],
    sglang: ['sglang', 'vllm', 'vllmCli', 'ollama', 'llamacpp'],
    transformers: ['transformers', 'vllm', 'sglang', 'ollama', 'llamacpp'],
  };
  const primary = s.runtime !== 'any' ? s.runtime : kind === 'mlx' ? 'mlx' : kind === 'st' ? 'vllm' : 'ollama';
  // Full stack: the model server plus Open WebUI (and retrieval models), in one compose file.
  if ((o.stackUi || o.stackRag) && !isCluster(b)) {
    const server = { vllm: ['vllm', 'vllm', o.port || 8000, 'VLLM_API_KEY'], sglang: ['sglang', 'sglang', o.port || 30000, 'SGLANG_API_KEY'],
      llamacpp: ['llamacppDocker', 'llama', o.port || 8080, 'LLAMA_API_KEY'], ollama: ['ollamaDocker', 'ollama', 11434, null] }[primary] || (tabs.ollamaDocker && b.kind !== 'mac' ? ['ollamaDocker', 'ollama', 11434, null] : null);
    const base = server && tabs[server[0]]?.code && b.kind !== 'mac' ? { text: tabs[server[0]].code, kind: server[1], url: `http://${server[1]}:${server[2]}/v1`, keyVar: server[3] } : null;
    if (base || b.kind === 'mac') {
      tabs.stack = { label: 'Full stack: Open WebUI + RAG (Docker Compose)', yaml: true, code: stackCompose({ ...r, rtHost: primary }, b, o, base, stack),
        note: `${base ? `The model server from the ${{ vllm: 'vLLM', sglang: 'SGLang', llama: 'llama.cpp', ollama: 'Ollama' }[base.kind]} tab` : 'Your native model server (Docker on a Mac cannot use the GPU)'}${o.stackUi ? ', <a href="https://docs.openwebui.com" rel="noopener">Open WebUI</a> already connected to it' : ''}${o.stackRag && stack?.embed ? `, and <a href="https://huggingface.co/${esc(stack.embed)}" rel="noopener">${esc(stack.embed)}</a> for document search${stack.rerank ? ` plus <a href="https://huggingface.co/${esc(stack.rerank)}" rel="noopener">${esc(stack.rerank)}</a> to rerank` : ''} (picked for your machine by the RAG part of the advisor)` : ''}. Turn parts on or off in Customize.` };
      const after = { vllm: 'vllm', sglang: 'sglang', llamacpp: 'llamacppDocker', ollama: 'ollamaDocker', lmstudio: 'lmstudio', mlx: 'mlx', transformers: 'transformers' }[primary] || 'ollamaDocker';
      for (const list of Object.values(order)) { const i = list.indexOf(after); if (i >= 0 && !list.includes('stack')) list.splice(i + 1, 0, 'stack'); }
    }
  }
  for (const k of order[primary] || order.ollama) if (tabs[k] && (tabs[k].code || out.length === 0)) out.push(tabs[k]);
  return out;
}
