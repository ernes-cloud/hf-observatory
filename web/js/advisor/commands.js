// Ready-to-run commands and Docker Compose files for a recommendation.
// `o` holds the per-model options from the "Customize" panel (see defaultOptions).

import { LLM_USES, QUANTS, isCluster, isGptOss, parallelOf, thinkingOf, toolParser } from './engine.js';

/** What `ollama run` takes: the official library tag for gpt-oss, else the Hugging Face GGUF (with its quant). */
function ollamaRef(m, repo, quant) {
  const official = /^openai\/gpt-oss-(\d+b)$/i.exec(m.id);
  if (official) return `gpt-oss:${official[1].toLowerCase()}`;
  return `hf.co/${repo}${quant ? `:${quant}` : ''}`;
}
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
    ctx: s.ctx,
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
  };
}
export const defaultSpecTokens = (method) => (method?.startsWith('dflash') ? 8 : method === 'dspark' ? 7 : 3);

/* ------------------------------------------------------------------ compose helpers */

function gpuBlock(b) {
  if (b.vendor === 'amd') return ['    devices:', '      - /dev/kfd', '      - /dev/dri', '    group_add:', '      - video'];
  if (b.kind === 'mac' || b.kind === 'cpu' || b.vendor === 'intel') return [];
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
    if (isCluster(b)) args.push('--distributed-executor-backend ray');
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
  if (o.tools) args.push(`--enable-auto-tool-choice --tool-call-parser ${toolParser(m) || '<see model card>'}`);
  return args;
}

const clusterNote = (b, how) => (isCluster(b)
  ? [`# ${b.n} linked units: ${how}`, '# Connect them with the QSFP cable first (NVIDIA DGX Spark playbook: "Connect two Sparks").']
  : []);

function vllmCompose(r, b, o, repo) {
  const env = [...gatedEnv(r.m), ...(o.apiKey ? ['VLLM_API_KEY=${VLLM_API_KEY}   # put it in a .env file next to this compose'] : [])];
  return [
    ...armNote(b),
    ...clusterNote(b, 'start a Ray cluster across them (ray start --head on this one, ray start --address=<head-ip>:6379 on the other), then run this on the head.'),
    'services:',
    '  vllm:',
    `    image: ${b.vendor === 'amd' ? 'rocm/vllm' : 'vllm/vllm-openai'}:${o.imageTag}`,
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
    if (tp > 1) args.push(`--tp ${tp}`);
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
    else if (sp.method.startsWith('dflash')) args.push(`--speculative-algorithm DFLASH --speculative-draft-model-path ${sp.draft} --trust-remote-code`);
    else if (sp.method === 'dspark') args.push(`--speculative-algorithm DSPARK --speculative-draft-model-path ${sp.draft} --speculative-dspark-block-size ${o.specTokens} --trust-remote-code`);
    else args.push(`--speculative-algorithm EAGLE3 --speculative-draft-model-path ${sp.draft} --speculative-num-steps ${o.specTokens} --speculative-eagle-topk 1 --speculative-num-draft-tokens ${o.specTokens + 1}`);
  }
  if (think && o.reasoningParser && think.sglangParser) args.push(`--reasoning-parser ${think.sglangParser}`);
  if (o.tools && toolParser(m)) args.push(`--tool-call-parser ${toolParser(m).replace('llama3_json', 'llama3').replace(/^openai$/, 'gpt-oss')}`);
  return args;
}

function sglangCompose(r, b, o, repo) {
  const env = [...gatedEnv(r.m), ...(o.apiKey ? ['SGLANG_API_KEY=${SGLANG_API_KEY}   # put it in a .env file next to this compose'] : [])];
  return [
    ...(b.id === 'dgx-spark' ? [] : armNote(b)),
    ...clusterNote(b, 'run this file on both, with HEAD_IP=<first unit\'s IP> and NODE_RANK=0 on the first, NODE_RANK=1 on the second (in a .env file).'),
    ...(b.vendor === 'amd' ? ['# AMD: use a ROCm tag of lmsysorg/sglang'] : []),
    'services:',
    '  sglang:',
    // LMSYS publishes an ARM64 + Blackwell (sm_121) build for the DGX Spark under the "spark" tag
    `    image: lmsysorg/sglang:${b.id === 'dgx-spark' && o.imageTag === 'latest' ? 'spark' : o.imageTag}`,
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
  const args = [`-hf ${sp?.method === 'mtp' ? sp.gguf : `${repo}${quant ? `:${quant}` : ''}`}`, `-c ${o.ctx}`, '-ngl 99', `--host 0.0.0.0 --port ${o.port || 8080}`];
  if (o.kv !== 'f16') args.push(`-fa on -ctk ${o.kv === 'q8' ? 'q8_0' : 'q4_0'} -ctv ${o.kv === 'q8' ? 'q8_0' : 'q4_0'}`);
  if (o.users > 1 && sp?.method !== 'mtp') args.push(`-np ${o.users}`);
  if (sp?.method === 'mtp') args.push('--spec-type draft-mtp');
  if (sp?.method === 'dflash2') args.push(`-hfd ${sp.draft} --spec-draft-n-max ${o.specTokens}`);
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
    '      - ~/.cache/llama.cpp:/root/.cache/llama.cpp',
    ...envBlock(o.apiKey ? ['LLAMA_API_KEY=${LLAMA_API_KEY}   # put it in a .env file next to this compose'] : []),
    ...gpuBlock(b),
    ...restartBlock(o),
    ...healthBlock(o, `http://localhost:${o.port || 8080}/health`),
    ...commandBlock(llamacppArgs(r, o, repo, quant)),
  ].join('\n');
}

/* ------------------------------------------------------------------ entry point */

/**
 * Tabs of commands for one recommendation: [{label, code?, note?, yaml?}], the chosen runtime first.
 * `opts` are the per-model options (defaultOptions + the user's changes); `specs` the speculative
 * options available for the runtime that will run it.
 */
export function commandsFor(r, s, b, caps, opts, specs = []) {
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
      out.push({ label: 'Docker Compose (TEI)', yaml: true, code: ['services:', '  tei:', `    image: ghcr.io/huggingface/text-embeddings-inference:${b.kind === 'cpu' || b.kind === 'mac' ? 'cpu-latest' : 'latest'}`, '    ports:', '      - "8080:80"', ...hfCache('/data'), ...gpuBlock(b), ...restartBlock(o), ...commandBlock([`--model-id ${m.id}`])].join('\n'), note: 'Text Embeddings Inference serves embeddings and rerankers over HTTP.' });
    } else if (s.use === 'asr') {
      out.push({ label: 'Python', code: `pip install transformers torch\npython -c "from transformers import pipeline; print(pipeline('automatic-speech-recognition', model='${m.id}')('audio.mp3'))"` });
      if (/whisper/i.test(m.id)) out.push({ label: 'whisper.cpp', note: 'Whisper models also run very fast with whisper.cpp or faster-whisper.' });
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
    tabs.ollama = { label: 'Ollama', code: `${env.length ? `${env.join(' ')} ollama serve   # in one terminal\n` : ''}ollama run ${ollamaRef(m, repo, ggufQ)}${ollamaThinkFlag(r, o)}`, note: `${o.tools ? 'OpenAI-compatible API with tool calling at http://localhost:11434/v1. ' : ''}Ollama does not do speculative decoding: use llama.cpp, vLLM or SGLang for that.` };
    tabs.ollamaDocker = { label: 'Ollama (Docker Compose)', yaml: true, code: ollamaCompose(r, b, o, repo, ggufQ) };
    const lo = { ...o, specObj: kind === 'gguf' ? o.specObj : null };
    tabs.llamacpp = { label: 'llama.cpp', code: `llama-server ${llamacppArgs(r, lo, repo, ggufQ).join(' ')}`, note: [`Chat UI and OpenAI-compatible API at http://localhost:${o.port || 8080}.`, lo.specObj?.method === 'mtp' ? 'MTP uses the MTP-preserving GGUF (add <code>:&lt;quant&gt;</code> to pick a file); it does not work with several parallel users or with images.' : '', lo.specObj?.experimental ? 'DFlash2 drafts need a llama.cpp build that includes DFlash2 support.' : '', thinkNote].filter(Boolean).join(' ') };
    tabs.llamacppDocker = { label: 'llama.cpp (Docker Compose)', yaml: true, code: llamacppCompose(r, b, lo, repo, ggufQ) };
    tabs.lmstudio = { label: 'LM Studio', code: `lms get ${repo}`, note: `Or search “${esc(repo)}” in LM Studio${ggufQ ? ` and pick the <strong>${esc(ggufQ)}</strong> file` : ''}.` };
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
    tabs.vllm = { label: 'vLLM (Docker Compose)', yaml: true, code: vllmCompose(r, b, o, srepo), note: [quantNote, specNote, thinkNote, `Start with <code>docker compose up -d</code>; OpenAI-compatible API at http://localhost:${o.port || 8000}/v1.`].filter(Boolean).join(' ') };
    tabs.sglang = { label: 'SGLang (Docker Compose)', yaml: true, code: sglangCompose(r, b, o, srepo), note: [quantNote, specNote, think?.mode === 'hybrid' && o.think === 'off' ? 'SGLang has no server-wide switch for thinking: send <code>"chat_template_kwargs": {"enable_thinking": false}</code> with each request.' : thinkNote, `Start with <code>docker compose up -d</code>; OpenAI-compatible API at http://localhost:${o.port || 30000}/v1.`].filter(Boolean).join(' ') };
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
  for (const k of order[primary] || order.ollama) if (tabs[k] && (tabs[k].code || out.length === 0)) out.push(tabs[k]);
  return out;
}
