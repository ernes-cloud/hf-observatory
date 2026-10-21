// Unit tests for the model advisor engine: `node --test tests/`
import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetOf, capacity, fitModel, kvGB, memNeeded, recommend, serverLadder, specFor, speedOf, toolParser } from '../web/js/advisor/engine.js';

const base = { use: 'chat', agent: 'coding', hw: 'gpu', gpu: 'rtx-4090', ngpu: 1, ram: 64, cpuMem: 'ddr5', offload: false,
  runtime: 'ollama', ctx: 8192, users: 1, kv: 'f16', priority: 40, sizeLo: 0, sizeHi: 25, sort: 'best' };

test('KV cache grows with context and is ~1 GB per 8K tokens for an 8B model', () => {
  assert.equal(kvGB(8, 8192).toFixed(2), '1.00');
  assert.ok(kvGB(8, 32768) > 3.9 && kvGB(8, 32768) < 4.1);
  assert.ok(kvGB(70, 8192) > kvGB(8, 8192));
});

test('memory budget of a single RTX 4090 and of a DGX Spark', () => {
  const g = budgetOf(base);
  assert.ok(g.fast > 22 && g.fast < 23.5);
  assert.equal(g.fastBw, 1008);
  const spark = budgetOf({ ...base, hw: 'unified', unified: 'dgx-spark', nunits: 1 });
  assert.equal(spark.fast, 119);
  assert.equal(spark.fastBw, 273);
  assert.equal(budgetOf({ ...base, runtime: 'vllm', hw: 'unified', unified: 'dgx-spark', nunits: 2 }).fast, 238);
  // Ollama cannot span two linked units
  assert.equal(budgetOf({ ...base, runtime: 'ollama', hw: 'unified', unified: 'dgx-spark', nunits: 2 }).fast, 119);
});

test('a 70B model fits at Q8 on a DGX Spark but not at all on a single 4090', () => {
  const spark = { ...base, hw: 'unified', unified: 'dgx-spark' };
  const fitSpark = fitModel({ p: 70 }, 'gguf', spark, budgetOf(spark), 'ollama');
  assert.equal(fitSpark.where, 'gpu');
  // Q8 fits (≈ 77 GB) but is slow on 273 GB/s; with quality-first settings the advisor still keeps ≥ 4-bit
  assert.ok(['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M'].includes(fitSpark.quant));
  const qualityFirst = fitModel({ p: 70 }, 'gguf', { ...spark, priority: 0 }, budgetOf(spark), 'ollama');
  const speedFirst = fitModel({ p: 70 }, 'gguf', { ...spark, priority: 100 }, budgetOf(spark), 'ollama');
  assert.ok(speedFirst.bpp <= qualityFirst.bpp);
  assert.equal(fitModel({ p: 70 }, 'gguf', base, budgetOf(base), 'ollama'), null);
});

test('overflow into system RAM is used only when allowed, and is slower', () => {
  const s = { ...base, offload: true };
  const f = fitModel({ p: 32 }, 'gguf', s, budgetOf(s), 'ollama');
  assert.ok(f);
  const noOffload = fitModel({ p: 32 }, 'gguf', base, budgetOf(base), 'ollama');
  assert.equal(noOffload.where, 'gpu'); // 32B Q4 fits a 4090
  const big = fitModel({ p: 70 }, 'gguf', s, budgetOf(s), 'ollama');
  assert.equal(big.where, 'split');
  assert.ok(big.tps < noOffload.tps);
});

test('MoE models are estimated by active parameters for speed', () => {
  const b = budgetOf(base);
  const dense = speedOf(30, 0.61, base, b, 'gpu', 'ollama');
  const moe = speedOf(3, 0.61, base, b, 'gpu', 'ollama');
  assert.ok(moe > dense * 5);
});

test('tensor parallel in vLLM speeds up multi-GPU, layer split in Ollama does not', () => {
  const s = { ...base, ngpu: 4 };
  const b = budgetOf(s);
  assert.ok(speedOf(8, 2, s, b, 'gpu', 'vllm') > 2 * speedOf(8, 2, s, b, 'gpu', 'ollama'));
});

test('more concurrent users need more KV cache memory', () => {
  const one = memNeeded(8, 0.61, { ...base, users: 1 }).total;
  const many = memNeeded(8, 0.61, { ...base, users: 16 }).total;
  assert.ok(many > one + 10);
});

test('capacity table is monotonic: lower bits fit bigger models', () => {
  const cap = capacity('gguf', base, budgetOf(base)).map(([, p]) => p);
  for (let i = 1; i < cap.length; i++) assert.ok(cap[i] > cap[i - 1]);
});

test('recommend ranks tool-calling models first for function-calling agents and respects the size range', () => {
  const data = { caps: ['chat', 'tools', 'code', 'reasoning', 'vision', 'roleplay', 'uncensored', 'moe', 'embed', 'math', 'computer', 'swe', 'sql', 'longctx', 'rerank'], tool_families: ['Qwen'],
    models: [
      { id: 'a/plain-chat-8b', task: 'text-generation', p: 8, lf: 'oss', lang: [], dl: 50000, likes: 100, tr: 0, c: 0, caps: 1, gguf: 'a/plain-chat-8b-GGUF', st: true },
      // tags only count fully for models people actually use (anyone can self-tag "tools")
      { id: 'b/tool-caller-8b', task: 'text-generation', p: 8, lf: 'oss', lang: [], dl: 20000, likes: 60, tr: 0, c: 0, caps: 1 | 2, gguf: 'b/tool-caller-8b-GGUF', st: true },
      { id: 'c/huge-400b', task: 'text-generation', p: 400, lf: 'oss', lang: [], dl: 900000, likes: 900, tr: 0, c: 0, caps: 1 | 2, gguf: 'c/huge-GGUF', st: true },
    ] };
  const r = recommend(data, { ...base, use: 'agents', agent: 'functions' }, 1);
  assert.equal(r.list[0].m.id, 'b/tool-caller-8b');
  assert.ok(!r.list.some((x) => x.m.id === 'c/huge-400b')); // does not fit a 4090
  const sized = recommend(data, { ...base, sizeLo: 12, sizeHi: 25 }, 1); // 14B and up
  assert.equal(sized.list.length, 0);
});

test('16-bit weights are not chosen for GGUF models above 2B', () => {
  const f = fitModel({ p: 8 }, 'gguf', { ...base, priority: 40 }, budgetOf(base), 'ollama');
  assert.notEqual(f.quant, 'F16');
});

const qwen27 = { id: 'Qwen/Qwen3.8-27B', p: 27, fam: 'Qwen', st: true, gguf: 'x/Qwen3.8-27B-GGUF', mtp: true,
  q: { nvfp4: 'RadixArk/Qwen3.8-27B-NVFP4', fp8: 'Qwen/Qwen3.8-27B-FP8', awq: 'c/Qwen3.8-27B-AWQ' },
  dr: [{ id: 'z-lab/Qwen3.8-27B-DFlash2', m: 'dflash2', g: false, p: 1.9 }, { id: 'z-lab/Qwen3.8-27B-DFlash2-GGUF', m: 'dflash2', g: true, p: 1.9 }] };

test('server quantization follows the GPU architecture', () => {
  assert.deepEqual(serverLadder('blackwell').map((x) => x[0]), ['BF16', 'FP8', 'NVFP4']);
  assert.deepEqual(serverLadder('ada').map((x) => x[0]), ['BF16', 'FP8', 'AWQ / GPTQ 4-bit']);
  assert.deepEqual(serverLadder('ampere').map((x) => x[0]), ['BF16', 'INT8 (W8A16)', 'AWQ / GPTQ 4-bit']);
  assert.equal(serverLadder('hopper', { fam: 'GPT-OSS' })[0][0], 'MXFP4 (native)');
});

test('a 27B on an RTX 5090 with vLLM uses the NVFP4 build; on an RTX 4090 the AWQ one', () => {
  const s5090 = { ...base, gpu: 'rtx-5090', runtime: 'vllm', priority: 60 };
  const f5090 = fitModel(qwen27, 'st', s5090, budgetOf(s5090), 'vllm');
  assert.equal(f5090.quant, 'NVFP4');
  assert.equal(f5090.repo, 'RadixArk/Qwen3.8-27B-NVFP4');
  const s4090 = { ...base, runtime: 'vllm', priority: 60 };
  const f4090 = fitModel(qwen27, 'st', s4090, budgetOf(s4090), 'vllm');
  assert.equal(f4090.quant, 'AWQ / GPTQ 4-bit');
  assert.equal(f4090.repo, 'c/Qwen3.8-27B-AWQ');
});

test('FP8 can be applied on the fly when no FP8 build exists', () => {
  const s = { ...base, gpu: 'h100-sxm', runtime: 'vllm', priority: 40 };
  const f = fitModel({ id: 'a/m-8b', p: 8, st: true }, 'st', s, budgetOf(s), 'vllm');
  assert.ok(['BF16', 'FP8'].includes(f.quant));
  const big = fitModel({ id: 'a/m-60b', p: 60, st: true }, 'st', s, budgetOf(s), 'vllm');
  assert.equal(big.quant, 'FP8');
  assert.equal(big.onTheFly, true);
});

test('speculative decoding: DFlash2 draft in vLLM/SGLang, MTP or DFlash2 GGUF in llama.cpp, none in Ollama', () => {
  assert.equal(specFor(qwen27, 'vllm', base).method, 'dflash2');
  assert.equal(specFor(qwen27, 'sglang', base).draft, 'z-lab/Qwen3.8-27B-DFlash2');
  assert.equal(specFor({ ...qwen27, dr: null }, 'vllm', base).vllmMethod, 'qwen3_5_mtp');
  assert.equal(specFor({ ...qwen27, gmtp: 'u/Qwen3.8-27B-MTP-GGUF' }, 'llamacpp', base).method, 'mtp');
  assert.equal(specFor(qwen27, 'llamacpp', base).method, 'dflash2');
  assert.equal(specFor(qwen27, 'ollama', base), null);
});

test('tool-call parser per model generation', () => {
  assert.equal(toolParser({ id: 'Qwen/Qwen3.8-27B', fam: 'Qwen' }), 'qwen3_xml');
  assert.equal(toolParser({ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', fam: 'Qwen' }), 'qwen3_coder');
  assert.equal(toolParser({ id: 'Qwen/Qwen2.5-7B-Instruct', fam: 'Qwen' }), 'hermes');
  assert.equal(toolParser({ id: 'meta-llama/Llama-3.1-8B-Instruct', fam: 'Llama' }), 'llama3_json');
});

test('KV cache follows the architecture: MoE width, MLA, hybrid and sliding-window attention', async () => {
  const { kvOf } = await import('../web/js/advisor/engine.js');
  const dense70 = kvOf({ p: 70 }, 131072);
  // Qwen3-235B-A22B has a smaller cache than a dense 70B (4 KV heads), not 3× bigger
  assert.ok(kvOf({ p: 235, a: 22 }, 131072) < dense70 * 1.2);
  // DeepSeek-V3 (MLA): ~9 GB at 128K in practice; the estimate stays within ~2.5×, not the 100+ GB of a dense model
  const ds = kvOf({ p: 671, a: 37, kvf: 0.3 }, 131072);
  assert.ok(ds > 8 && ds < 25, `DeepSeek-V3 KV ${ds}`);
  // Qwen3.5 hybrid (3 linear-attention layers per full one) needs a quarter of the cache
  assert.equal(kvOf({ p: 27, kvf: 0.25 }, 65536).toFixed(3), (kvOf({ p: 27 }, 65536) * 0.25).toFixed(3));
});

test('3 or 6 GPUs use pipeline parallel for what tensor parallel cannot split', async () => {
  const { parallelOf } = await import('../web/js/advisor/engine.js');
  assert.deepEqual(parallelOf(8), { tp: 8, pp: 1 });
  assert.deepEqual(parallelOf(6), { tp: 2, pp: 3 });
  assert.deepEqual(parallelOf(3), { tp: 1, pp: 3 });
});

test('config.json data: exact KV, sliding windows and a context the model supports', async () => {
  const { kvOf, recommend } = await import('../web/js/advisor/engine.js');
  const { commandsFor } = await import('../web/js/advisor/commands.js');
  // gpt-oss-120b: 36 KiB per token in full layers + 36 KiB in 128-token sliding layers
  const g = { p: 116.8, a: 5.1, kvb: 36864, kvs: 36864, win: 128 };
  assert.equal(kvOf(g, 131072).toFixed(3), ((36864 * 131072 + 36864 * 128) / 1e9).toFixed(3));
  // a 32K model asked for 128K: sized and launched at 32K, and told so
  const data = { caps: ['chat', 'tools'], tool_families: [], models: [
    { id: 'lab/Short-8B', task: 'text-generation', p: 8, a: null, fam: null, lf: 'oss', lic: 'apache-2.0', lang: [], dl: 5000, likes: 50, tr: 1, c: 20000, caps: 1, gated: false, st: true, gguf: null, mlx: null, q: null, kvb: 131072, mc: 32768 },
  ] };
  const s = { ...base, runtime: 'vllm', ctx: 131072, spec: 'off', must: '', archFilter: 'any' };
  const { list, budget } = recommend(data, s);
  assert.equal(list[0].ctx, 32768);
  assert.ok(list[0].why.some((w) => /up to 32K/.test(w)));
  const compose = commandsFor(list[0], s, budget, data.caps, null, [])[0].code;
  assert.match(compose, /--max-model-len 32768/);
  assert.ok(list[0].fit.pp > 0);
});

test('a MoE too big for the GPU keeps its experts in RAM (llama.cpp --n-cpu-moe), faster than splitting layers', async () => {
  const { budgetOf, fitModel } = await import('../web/js/advisor/engine.js');
  const { commandsFor } = await import('../web/js/advisor/commands.js');
  const s = { ...base, gpu: 'rtx-4090', ram: 64, cpuMem: 'ddr5', offload: true, runtime: 'llamacpp', ctx: 32768 };
  const b = budgetOf(s);
  const gptoss = { id: 'openai/gpt-oss-120b', p: 116.8, a: 5.1, moe: true, nl: 36, kvb: 36864, kvs: 36864, win: 128, gguf: 'ggml-org/gpt-oss-120b-GGUF', fam: 'GPT-OSS' };
  const f = fitModel(gptoss, 'gguf', s, b, 'llamacpp');
  assert.equal(f.where, 'moe-cpu');
  assert.ok(f.cpuMoe > 0 && f.cpuMoe <= 36);
  assert.ok(f.need.gpu <= b.fast && f.need.ram <= b.slow);
  // users report ~25-35 tok/s for this setup with DDR5
  assert.ok(f.tps > 15 && f.tps < 45, `gpt-oss-120b on a 4090 + DDR5: ${f.tps}`);
  const split = fitModel(gptoss, 'gguf', { ...s, runtime: 'ollama' }, b, 'ollama');
  assert.equal(split.where, 'split'); // Ollama cannot do it
  assert.ok(f.tps > split.tps * 1.3);
  const r = { m: { ...gptoss, caps: 1 }, fit: f, kind: 'gguf', rt: 'llamacpp', specs: [], ctx: 32768 };
  const cmd = commandsFor(r, { ...s, use: 'chat' }, b, ['chat'], null, [])[0].code;
  assert.match(cmd, new RegExp(`--n-cpu-moe ${f.cpuMoe}`));
});

test('several users share each pass over the weights: total throughput grows, per-user speed drops', async () => {
  const { budgetOf, speedOf } = await import('../web/js/advisor/engine.js');
  const s = { ...base, gpu: 'h100-sxm', ngpu: 1, runtime: 'vllm' };
  const b = budgetOf(s);
  const one = speedOf(8, 1.05, { ...s, users: 1 }, b, 'gpu', 'vllm', 1);
  const many = speedOf(8, 1.05, { ...s, users: 32 }, b, 'gpu', 'vllm', 1);
  assert.ok(many < one, 'each user gets less');
  assert.ok(many * 32 > one * 5, 'but the server produces far more in total');
  // MoE: more users touch more experts
  const moe1 = speedOf(3, 1.05, { ...s, users: 1 }, b, 'gpu', 'vllm', 1, 30);
  const moe16 = speedOf(3, 1.05, { ...s, users: 16 }, b, 'gpu', 'vllm', 1, 30);
  assert.ok(moe16 < moe1 * 0.7);
});

test('two different cards: llama.cpp uses all their memory, vLLM counts every card as the smaller one', async () => {
  const { budgetOf, runtimeKinds } = await import('../web/js/advisor/engine.js');
  const s = { ...base, gpu: 'rtx-4090', ngpu: 1, gpu2: 'rtx-3090', ngpu2: 1 };
  const gguf = budgetOf({ ...s, runtime: 'llamacpp' });
  assert.ok(gguf.fast > 42 && gguf.fast < 46); // ~21.8 GB usable on each 24 GB card
  assert.ok(gguf.fastBw > 936 && gguf.fastBw < 1008);
  assert.equal(gguf.arch, 'ampere'); // formats of the older card
  const tp = budgetOf({ ...s, runtime: 'vllm' });
  assert.equal(tp.n, 2);
  assert.equal(tp.fastBw, 936);
  assert.deepEqual(runtimeKinds({ ...s, hw: 'gpu', runtime: 'any' }), ['gguf']);
  // 4090 (24 GB) + 4060 Ti 16 GB under vLLM: two shards of the smaller card
  const small = budgetOf({ ...s, gpu2: 'rtx-4060-ti-16-gb', runtime: 'vllm' });
  assert.ok(small.fast < 2 * 16);
});

test('speech and image commands follow the library the model is built for', async () => {
  const { budgetOf } = await import('../web/js/advisor/engine.js');
  const { commandsFor } = await import('../web/js/advisor/commands.js');
  const s = { ...base, use: 'asr' };
  const b = budgetOf(s);
  const r = (lib) => ({ m: { id: 'nvidia/parakeet-tdt-0.6b-v3', caps: 0, lib }, fit: { quant: '16-bit' }, kind: 'st', specs: [] });
  assert.match(commandsFor(r('nemo'), s, b, ['chat'], null)[0].code, /nemo_toolkit\[asr\][\s\S]*ASRModel\.from_pretrained\('nvidia\/parakeet-tdt-0\.6b-v3'\)/);
  assert.match(commandsFor(r('transformers'), s, b, ['chat'], null)[0].code, /pipeline\('automatic-speech-recognition'/);
  const other = commandsFor(r('pyannote-audio'), s, b, ['chat'], null)[0];
  assert.ok(!other.code && /pyannote-audio/.test(other.note));
});

test('sprint 1: generated commands use flags and images that exist', async () => {
  const { budgetOf } = await import('../web/js/advisor/engine.js');
  const { commandsFor, defaultOptions, teiImage } = await import('../web/js/advisor/commands.js');
  const caps = ['chat', 'tools'];
  const run = (m, s, opts = {}, specs = [], stack = null) => {
    const b = budgetOf(s);
    const r = { m: { caps: 3, lang: [], ...m }, fit: { quant: 'BF16', repo: m.id, where: 'gpu', tps: 30, bpp: 2, need: { total: 10, weights: 8, kv: 1 } }, kind: 'st', rt: s.runtime, specs, ctx: s.ctx };
    return commandsFor(r, s, b, caps, { ...defaultOptions(r, s, b), tools: true, ...opts }, specs, stack);
  };
  const vllm = { ...base, use: 'agents', runtime: 'vllm', gpu: 'rtx-5090' };
  const code = (tabs, label) => tabs.find((t) => t.label.startsWith(label))?.code || '';
  // no parser known: no tool flags (and never a placeholder that breaks the command)
  const gemma3 = run({ id: 'google/gemma-3-27b-it', p: 27, fam: 'Gemma', st: true }, vllm);
  assert.doesNotMatch(code(gemma3, 'vLLM (Docker'), /tool-call-parser|</);
  assert.match(code(run({ id: 'google/gemma-4-31B-it', p: 31, fam: 'Gemma', st: true }, vllm), 'vLLM (Docker'), /--tool-call-parser gemma4/);
  // SGLang parser names differ from vLLM's
  const sg = { ...vllm, runtime: 'sglang' };
  assert.match(code(run({ id: 'Qwen/Qwen3.6-27B', p: 27, fam: 'Qwen', st: true }, sg), 'SGLang'), /--tool-call-parser qwen3_coder/);
  assert.match(code(run({ id: 'deepseek-ai/DeepSeek-V3.2', p: 671, a: 37, fam: 'DeepSeek', st: true }, { ...sg, gpu: 'h200', ngpu: 8 }), 'SGLang'), /--tool-call-parser deepseekv3/);
  assert.match(code(run({ id: 'Qwen/Qwen3.6-27B', p: 27, fam: 'Qwen', st: true }, sg), 'SGLang'), /--tp-size|--model-path/);
  // AMD: vLLM ROCm image with the vllm serve entrypoint; SGLang ROCm tag
  const amd = { ...vllm, gpu: 'instinct-mi300x' };
  assert.match(code(run({ id: 'Qwen/Qwen3.6-27B', p: 27, fam: 'Qwen', st: true }, amd), 'vLLM (Docker'), /image: vllm\/vllm-openai-rocm:/);
  assert.match(code(run({ id: 'Qwen/Qwen3.6-27B', p: 27, fam: 'Qwen', st: true }, { ...amd, runtime: 'sglang' }), 'SGLang'), /image: lmsysorg\/sglang:v[\d.]+-rocm\d+-mi30x/);
  // DGX Spark: multi-arch CUDA 13 SGLang image; two units with vLLM's own multi-node mode, no Ray
  assert.match(code(run({ id: 'Qwen/Qwen3.6-27B', p: 27, fam: 'Qwen', st: true }, { ...vllm, gpu: 'dgx-spark', runtime: 'sglang' }), 'SGLang'), /lmsysorg\/sglang:latest-cu130/);
  const two = code(run({ id: 'Qwen/Qwen3.6-27B', p: 27, fam: 'Qwen', st: true }, { ...vllm, gpu: 'dgx-spark', ngpu: 2 }), 'vLLM (Docker');
  assert.match(two, /--nnodes 2 --node-rank \$\{NODE_RANK:-0\} --master-addr \$\{HEAD_IP\}/);
  assert.doesNotMatch(two, /ray/i);
  // TEI images per GPU generation and architecture
  const tei = (s) => teiImage(budgetOf({ ...base, ...s })).image.split(':')[1];
  assert.equal(tei({ gpu: 'rtx-5090' }), '120-1.9');
  assert.equal(tei({ gpu: 'rtx-4090' }), '89-1.9');
  assert.equal(tei({ gpu: 'dgx-spark' }), '121-1.9');
  assert.equal(tei({ gpu: 'b200' }), '100-1.9');
  assert.equal(tei({ hw: 'mac', chip: 'm4-max', mac: 64 }), 'cpu-arm64-1.9');
  assert.equal(tei({ gpu: 'radeon-rx-7900-xtx' }), 'cpu-1.9');
  // full stack: Open WebUI reranks itself (TEI's /rerank speaks another API)
  const stack = code(run({ id: 'Qwen/Qwen3.6-27B', p: 27, fam: 'Qwen', st: true }, vllm, {}, [], { embed: 'BAAI/bge-m3', rerank: 'BAAI/bge-reranker-v2-m3' }), 'Full stack');
  assert.match(stack, /RAG_RERANKING_MODEL=BAAI\/bge-reranker-v2-m3/);
  assert.doesNotMatch(stack, /^ {2}reranker:/m);
  // gpt-oss effort in SGLang
  assert.match(code(run({ id: 'openai/gpt-oss-120b', p: 117, a: 5.1, fam: 'GPT-OSS', st: true, q: { mxfp4: 'openai/gpt-oss-120b' } }, { ...sg, gpu: 'h100-sxm' }, { think: 'high' }), 'SGLang'), /reasoning_effort": "high"/);
  // llama.cpp: downloads land in the Hugging Face cache; Intel cards get their render device; LM Studio by URL
  const ll = { ...base, use: 'chat', runtime: 'llamacpp', gpu: 'arc-b580' };
  const llr = { m: { id: 'Qwen/Qwen3.5-9B', p: 9.6, fam: 'Qwen', gguf: 'unsloth/Qwen3.5-9B-GGUF', caps: 1, lang: [] }, fit: { quant: 'Q4_K_M', where: 'gpu', tps: 30, bpp: 0.6, need: { total: 7, weights: 6, kv: 0.5 } }, kind: 'gguf', rt: 'llamacpp', specs: [], ctx: 8192 };
  const lt = commandsFor(llr, ll, budgetOf(ll), caps, null, []);
  assert.match(code(lt, 'llama.cpp (Docker'), /~\/\.cache\/huggingface:\/root\/\.cache\/huggingface/);
  assert.match(code(lt, 'llama.cpp (Docker'), /devices:\n {6}- \/dev\/dri/);
  assert.equal(code(lt, 'LM Studio'), 'lms get https://huggingface.co/unsloth/Qwen3.5-9B-GGUF@Q4_K_M');
});

test('sprint 2: the ranking prefers usable, trustworthy, current models', async () => {
  const { recommend, quantLadder, fitModel, budgetOf } = await import('../web/js/advisor/engine.js');
  const today = 20750;
  const mk = (id, extra = {}) => ({ id, task: 'text-generation', p: 8, a: null, fam: 'Qwen', lf: 'oss', lic: 'apache-2.0', lang: [], dl: 50000, likes: 500, tr: 5, c: today - 30, caps: 1, gated: false, st: true, gguf: `${id}-GGUF`, mlx: null, q: null, ...extra });
  const data = { caps: ['chat', 'tools', 'code', 'reasoning', 'vision', 'roleplay', 'uncensored', 'moe', 'embed', 'math', 'computer', 'swe', 'sql', 'longctx', 'rerank'], tool_families: ['Qwen'], models: [
    mk('Qwen/Qwen3.5-9B'),
    mk('someone/Qwen3.5-9B-Super-Agent', { dl: 400, likes: 2, tr: 0, caps: 1 | 2 | 2048 }), // self-tagged tools + swe
    mk('baidu/Unlimited-OCR', { task: 'image-text-to-text' }),
    mk('lab/Old-8B-Instruct', { c: today - 1000, dl: 900000, likes: 9000 }),
    mk('lab/Model-8B-Base', { caps: 1 }),
  ] };
  const s = { ...base, use: 'agents', agent: 'coding', gpu: 'rtx-4070', runtime: 'ollama', ctx: 8192, must: '', archFilter: 'any', spec: 'auto' };
  const ids = recommend(data, s, today).list.map((r) => r.m.id);
  assert.equal(ids[0], 'Qwen/Qwen3.5-9B', `ranking: ${ids}`);
  assert.ok(!ids.includes('baidu/Unlimited-OCR') && !ids.includes('lab/Model-8B-Base'));
  assert.ok(ids.indexOf('lab/Old-8B-Instruct') > 0, 'an 8B from 2+ years ago does not top a current one');
  // a single-quant upload only runs the quant it holds
  assert.deepEqual(quantLadder({ gq: ['Q2_K'] }, 'gguf').map(([q]) => q), ['Q2_K']);
  // 2-3 bit builds of dense models under 30B are not offered: a smaller model at 4+ bits answers better
  const tight = { ...base, gpu: 'rtx-4060', runtime: 'ollama', ctx: 8192, priority: 40 };
  assert.equal(fitModel({ id: 'x/Dense-27B', p: 27, gguf: 'x/y' }, 'gguf', tight, budgetOf(tight), 'ollama'), null);
});

test('sprint 4: electricity per million tokens, upgrade advice and fine-tuning capacity', async () => {
  const { budgetOf, energyPerMillion, finetuneCapacity, upgradeOptions, recommend } = await import('../web/js/advisor/engine.js');
  const { allGpus } = await import('../web/js/advisor/hardware.js');
  // RTX 4090 at 100 tok/s: (450 W × 0.8 + 60 W) for 10,000 s ≈ 1.17 kWh ≈ $0.23 at $0.20/kWh
  const b = budgetOf({ ...base, gpu: 'rtx-4090' });
  assert.equal(energyPerMillion({ tps: 100 }, b, 1, 0.2).toFixed(2), '0.23');
  assert.ok(energyPerMillion({ tps: 100 }, b, 8, 0.2) < energyPerMillion({ tps: 100 }, b, 1, 0.2) / 7);
  // Unsloth's published minimums: 8B needs ~6 GB with QLoRA, ~22 GB with LoRA
  const ft = finetuneCapacity({ fast: 22 });
  assert.ok(ft.qlora > 30 && ft.lora > 7 && ft.lora < 9 && ft.full < 2);
  // upgrades: cheaper first, each runs a better model than the one before
  const data = { caps: ['chat', 'tools', 'code', 'reasoning', 'vision', 'roleplay', 'uncensored', 'moe'], tool_families: [], models: [8, 14, 32, 70].map((p) => (
    { id: `lab/M-${p}B`, task: 'text-generation', p, a: null, lf: 'oss', lang: [], dl: 90000, likes: 900, tr: 1, c: 20700, caps: 1, st: true, gguf: `lab/M-${p}B-GGUF` })) };
  const s = { ...base, gpu: 'rtx-4060', runtime: 'ollama', ctx: 8192, must: '', archFilter: 'any', spec: 'auto' };
  const cur = recommend(data, s, 20750).list[0];
  const ups = upgradeOptions(data, s, cur, allGpus());
  assert.ok(ups.length >= 2);
  for (let i = 1; i < ups.length; i++) assert.ok(ups[i].price >= ups[i - 1].price && ups[i].top.m.p >= ups[i - 1].top.m.p);
  assert.ok(ups[0].top.m.p > cur.m.p);
});
