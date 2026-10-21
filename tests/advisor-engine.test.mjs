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
      { id: 'b/tool-caller-8b', task: 'text-generation', p: 8, lf: 'oss', lang: [], dl: 5000, likes: 10, tr: 0, c: 0, caps: 1 | 2, gguf: 'b/tool-caller-8b-GGUF', st: true },
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
