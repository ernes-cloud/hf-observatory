// Ready-to-run commands and Docker Compose files for a recommendation.

import { LLM_USES, QUANTS, toolParser } from './engine.js';

const search = (q) => `https://huggingface.co/models?search=${encodeURIComponent(q)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** GPU access block for a compose service. */
function gpuBlock(b) {
  if (b.vendor === 'amd') return ['    devices:', '      - /dev/kfd', '      - /dev/dri', '    group_add:', '      - video'];
  if (b.kind === 'mac' || b.kind === 'cpu' || b.vendor === 'intel') return [];
  return ['    deploy:', '      resources:', '        reservations:', '          devices:', '            - driver: nvidia', '              count: all', '              capabilities: [gpu]'];
}
const hfCache = ['    volumes:', '      - ~/.cache/huggingface:/root/.cache/huggingface'];
const hfToken = (m) => (m.gated ? ['    environment:', '      - HF_TOKEN=${HF_TOKEN}   # gated model: accept the terms on its page first'] : []);

/** Wrap CLI arguments as a YAML block scalar under `command:`. */
function commandBlock(args) {
  return ['    command: >', ...args.map((a) => `      ${a}`)];
}

function vllmArgs(r, s, b) {
  const { m, fit } = r;
  const args = [`--model ${fit.repo}`, `--max-model-len ${s.ctx}`, '--host 0.0.0.0 --port 8000'];
  if (b.n > 1) args.push(`--tensor-parallel-size ${b.n}`);
  if (fit.onTheFly) args.push('--quantization fp8');
  if (s.kv !== 'f16') args.push('--kv-cache-dtype fp8');
  if (s.users > 1) args.push(`--max-num-seqs ${Math.max(8, s.users)}`);
  const sp = fit.spec;
  if (sp?.draft) args.push('--trust-remote-code'); // DFlash / DSpark drafters ship custom code
  if (sp) {
    if (sp.method === 'mtp') args.push(`--speculative-config '{"method": "${sp.vllmMethod}", "num_speculative_tokens": 3}'`);
    else if (sp.method.startsWith('dflash')) args.push(`--speculative-config '{"method": "dflash", "model": "${sp.draft}", "num_speculative_tokens": 8}'`);
    else args.push(`--speculative-config '{"method": "${sp.method}", "model": "${sp.draft}", "num_speculative_tokens": 3}'`);
  }
  if (s.use === 'agents') {
    const parser = toolParser(m);
    args.push(`--enable-auto-tool-choice --tool-call-parser ${parser || '<see model card>'}`);
  }
  return args;
}

function sglangArgs(r, s, b) {
  const { m, fit } = r;
  const args = ['python3 -m sglang.launch_server', `--model-path ${fit.repo}`, `--context-length ${s.ctx}`, '--host 0.0.0.0 --port 30000'];
  if (b.n > 1) args.push(`--tp ${b.n}`);
  if (fit.onTheFly) args.push('--quantization fp8');
  if (s.kv !== 'f16') args.push('--kv-cache-dtype fp8_e5m2');
  const sp = fit.spec;
  if (sp) {
    if (sp.method === 'mtp') args.push('--speculative-algorithm NEXTN --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4');
    else if (sp.method.startsWith('dflash')) args.push(`--speculative-algorithm DFLASH --speculative-draft-model-path ${sp.draft}`);
    else if (sp.method === 'dspark') args.push(`--speculative-algorithm DSPARK --speculative-draft-model-path ${sp.draft} --speculative-dspark-block-size 7 --trust-remote-code`);
    else args.push(`--speculative-algorithm EAGLE3 --speculative-draft-model-path ${sp.draft} --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4`);
  }
  if (s.use === 'agents' && toolParser(m)) args.push(`--tool-call-parser ${toolParser(m).replace('llama3_json', 'llama3').replace('openai', 'gpt-oss')}`);
  return args;
}

const armNote = (b) => (b.arm ? '# ARM64 (DGX Spark / Jetson): if this image has no arm64 build, use NVIDIA\'s container from NGC (nvcr.io/nvidia/…) with the same command.' : null);

function vllmCompose(r, s, b) {
  const image = b.vendor === 'amd' ? 'rocm/vllm:latest' : 'vllm/vllm-openai:latest';
  return [
    ...(armNote(b) ? [armNote(b)] : []),
    'services:',
    '  vllm:',
    `    image: ${image}`,
    '    ipc: host',
    '    ports:',
    '      - "8000:8000"',
    ...hfCache,
    ...hfToken(r.m),
    ...gpuBlock(b),
    ...commandBlock(vllmArgs(r, s, b)),
  ].join('\n');
}

function sglangCompose(r, s, b) {
  return [
    ...(armNote(b) ? [armNote(b)] : []),
    ...(b.vendor === 'amd' ? ['# AMD: use a ROCm tag of lmsysorg/sglang'] : []),
    'services:',
    '  sglang:',
    '    image: lmsysorg/sglang:latest',
    '    ipc: host',
    '    shm_size: 32g',
    '    ports:',
    '      - "30000:30000"',
    ...hfCache,
    ...hfToken(r.m),
    ...gpuBlock(b),
    ...commandBlock(sglangArgs(r, s, b)),
  ].join('\n');
}

function ollamaCompose(r, s, b, repo, quant) {
  const env = [];
  if (s.ctx > 8192) env.push(`OLLAMA_CONTEXT_LENGTH=${s.ctx}`);
  if (s.kv !== 'f16') env.push('OLLAMA_FLASH_ATTENTION=1', `OLLAMA_KV_CACHE_TYPE=${s.kv === 'q8' ? 'q8_0' : 'q4_0'}`);
  if (s.users > 1) env.push(`OLLAMA_NUM_PARALLEL=${Math.min(s.users, 16)}`);
  return [
    'services:',
    '  ollama:',
    `    image: ollama/ollama:${b.vendor === 'amd' ? 'rocm' : 'latest'}`,
    '    ports:',
    '      - "11434:11434"',
    '    volumes:',
    '      - ollama:/root/.ollama',
    ...(env.length ? ['    environment:', ...env.map((e) => `      - ${e}`)] : []),
    ...gpuBlock(b),
    'volumes:',
    '  ollama: {}',
    '',
    `# then: docker compose exec ollama ollama run hf.co/${repo}:${quant}`,
  ].join('\n');
}

function llamacppArgs(r, s, repo, quant) {
  const sp = r.fit.spec;
  // MTP-preserving GGUF repos name their files differently, so let llama.cpp pick the default file there.
  const args = [`-hf ${sp?.method === 'mtp' ? sp.gguf : `${repo}:${quant}`}`, `-c ${s.ctx}`, '-ngl 99', '--host 0.0.0.0 --port 8080'];
  if (s.kv !== 'f16') args.push(`-fa on -ctk ${s.kv === 'q8' ? 'q8_0' : 'q4_0'} -ctv ${s.kv === 'q8' ? 'q8_0' : 'q4_0'}`);
  if (s.users > 1 && sp?.method !== 'mtp') args.push(`-np ${s.users}`);
  if (sp?.method === 'mtp') args.push('--spec-type draft-mtp');
  if (sp?.method === 'dflash2') args.push(`-hfd ${sp.draft} --spec-draft-n-max 7`);
  if (s.use === 'agents') args.push('--jinja');
  return args;
}

function llamacppCompose(r, s, b, repo, quant) {
  const tag = b.vendor === 'amd' || b.vendor === 'intel' ? 'server-vulkan' : b.kind === 'cpu' ? 'server' : 'server-cuda';
  return [
    'services:',
    '  llama:',
    `    image: ghcr.io/ggml-org/llama.cpp:${tag}`,
    '    ports:',
    '      - "8080:8080"',
    '    volumes:',
    '      - ~/.cache/llama.cpp:/root/.cache/llama.cpp',
    ...gpuBlock(b),
    ...commandBlock(llamacppArgs(r, s, repo, quant)),
  ].join('\n');
}

/** Tabs of commands for one recommendation: [{label, code?, note?}], the chosen runtime first. */
export function commandsFor(r, s, b, caps) {
  const { m, fit, kind } = r;
  const base = m.id.split('/').pop();
  const out = [];
  if (!LLM_USES.has(s.use)) {
    if (s.use === 'rag') {
      const isRerank = (m.caps >> caps.indexOf('rerank')) & 1;
      out.push({ label: 'Python', code: isRerank
        ? `pip install sentence-transformers\npython -c "from sentence_transformers import CrossEncoder as C; print(C('${m.id}').predict([('query', 'passage')]))"`
        : `pip install sentence-transformers\npython -c "from sentence_transformers import SentenceTransformer as S; print(S('${m.id}').encode(['hello world']).shape)"` });
      out.push({ label: 'Docker Compose (TEI)', code: ['services:', '  tei:', `    image: ghcr.io/huggingface/text-embeddings-inference:${b.kind === 'cpu' || b.kind === 'mac' ? 'cpu-latest' : 'latest'}`, '    ports:', '      - "8080:80"', '    volumes:', '      - ~/.cache/huggingface:/data', ...gpuBlock(b), ...commandBlock([`--model-id ${m.id}`])].join('\n'), note: 'Text Embeddings Inference serves embeddings and rerankers over HTTP.' });
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

  const ggufQ = QUANTS.gguf.find(([n]) => n === fit.quant) ? fit.quant : 'Q4_K_M';
  const repo = m.gguf;
  const tabs = {};
  if (repo) {
    const env = [];
    if (s.ctx > 8192) env.push(`OLLAMA_CONTEXT_LENGTH=${s.ctx}`);
    if (s.kv !== 'f16') env.push(`OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=${s.kv === 'q8' ? 'q8_0' : 'q4_0'}`);
    if (s.users > 1) env.push(`OLLAMA_NUM_PARALLEL=${Math.min(s.users, 16)}`);
    tabs.ollama = { label: 'Ollama', code: `${env.length ? `${env.join(' ')} ollama serve   # in one terminal\n` : ''}ollama run hf.co/${repo}:${ggufQ}`, note: `${s.use === 'agents' ? 'OpenAI-compatible API with tool calling at http://localhost:11434/v1. ' : ''}Ollama does not do speculative decoding: use llama.cpp, vLLM or SGLang for that.` };
    tabs.ollamaDocker = { label: 'Ollama (Docker Compose)', code: ollamaCompose(r, s, b, repo, ggufQ) };
    const spec = kind === 'gguf' && s.runtime === 'llamacpp' ? fit.spec : null;
    const rr = { ...r, fit: { ...fit, spec } };
    tabs.llamacpp = { label: 'llama.cpp', code: `llama-server ${llamacppArgs(rr, s, repo, ggufQ).join(' ')}`, note: `Chat UI and OpenAI-compatible API at http://localhost:8080.${spec?.method === 'mtp' ? ' MTP uses the MTP-preserving GGUF (add <code>:&lt;quant&gt;</code> to pick a file); it does not work with several parallel users or with images.' : ''}${spec?.experimental ? ' DFlash2 drafts need a llama.cpp build that includes DFlash2 support.' : ''}` };
    tabs.llamacppDocker = { label: 'llama.cpp (Docker Compose)', code: llamacppCompose(rr, s, b, repo, ggufQ) };
    tabs.lmstudio = { label: 'LM Studio', code: `lms get ${repo}`, note: `Or search “${esc(repo)}” in LM Studio and pick the <strong>${esc(ggufQ)}</strong> file.` };
  } else {
    tabs.ollama = { label: 'Ollama', note: `No GGUF build of this model is tracked yet. <a href="${search(`${base} gguf`)}" rel="noopener">Search GGUF builds on Hugging Face</a>, then run <code>ollama run hf.co/&lt;repo&gt;:${esc(ggufQ)}</code>.` };
  }
  if (s.hw === 'mac') {
    tabs.mlx = { label: 'MLX', code: m.mlx ? `pip install mlx-lm\nmlx_lm.chat --model ${m.mlx}` : `pip install mlx-lm\nmlx_lm.convert --hf-path ${m.id} -q\nmlx_lm.chat --model mlx_model`, note: m.mlx ? 'For an OpenAI-compatible API: mlx_lm.server --model …' : 'No MLX build tracked: this converts the original to 4-bit locally.' };
  }
  if (m.st && s.hw !== 'mac' && s.hw !== 'cpu' && kind === 'st') {
    const specNote = fit.spec ? `Speculative decoding: ${fit.spec.label}${fit.spec.draft ? ` (<a href="https://huggingface.co/${esc(fit.spec.draft)}" rel="noopener">${esc(fit.spec.draft)}</a>)` : ''}. Draft support needs a recent vLLM / SGLang release; check the draft's model card if a flag is rejected.` : '';
    const quantNote = fit.onTheFly ? 'No FP8 build tracked, so the original weights are quantized to FP8 when loading.' : '';
    tabs.vllm = { label: 'vLLM (Docker Compose)', code: vllmCompose(r, s, b), note: [quantNote, specNote, 'Start with <code>docker compose up -d</code>; OpenAI-compatible API at http://localhost:8000/v1.'].filter(Boolean).join(' ') };
    tabs.sglang = { label: 'SGLang (Docker Compose)', code: sglangCompose(r, s, b), note: [quantNote, specNote, 'Start with <code>docker compose up -d</code>; OpenAI-compatible API at http://localhost:30000/v1.'].filter(Boolean).join(' ') };
    tabs.vllmCli = { label: 'vLLM (pip)', code: `pip install vllm\nvllm serve ${vllmArgs(r, s, b).join(' \\\n  ').replace(/^--model /, '').replace(' \\\n  --host 0.0.0.0 --port 8000', '')}` };
  }
  const order = {
    ollama: ['ollama', 'ollamaDocker', 'llamacpp', 'llamacppDocker', 'lmstudio', 'vllm', 'sglang', 'mlx'],
    lmstudio: ['lmstudio', 'ollama', 'llamacpp', 'llamacppDocker', 'mlx', 'vllm', 'sglang'],
    llamacpp: ['llamacpp', 'llamacppDocker', 'ollama', 'lmstudio', 'vllm', 'sglang', 'mlx'],
    mlx: ['mlx', 'ollama', 'lmstudio', 'llamacpp'],
    vllm: ['vllm', 'vllmCli', 'sglang', 'ollama', 'llamacpp'],
    sglang: ['sglang', 'vllm', 'vllmCli', 'ollama', 'llamacpp'],
    transformers: ['vllm', 'sglang', 'ollama', 'llamacpp'],
  };
  const primary = s.runtime !== 'any' ? s.runtime : kind === 'mlx' ? 'mlx' : kind === 'st' ? 'vllm' : 'ollama';
  for (const k of order[primary] || order.ollama) if (tabs[k] && (tabs[k].code || out.length === 0)) out.push(tabs[k]);
  return out;
}
