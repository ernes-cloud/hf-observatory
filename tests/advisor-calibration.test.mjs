// The advisor's speed estimates against published llama.cpp measurements.
// Generation (tg) is bounded by memory bandwidth, prompt reading (pp) by compute; both models are
// tuned on these points and must stay within the tolerance, so a change that drifts away fails here.
//
// Sources (llama-bench, short context):
//   Apple Silicon: ggml-org/llama.cpp discussion #4167, Llama-2-7B Q4_0 (6.74B parameters, 4.5 bits), tg128 / pp512
//   DGX Spark:     ggml-org/llama.cpp discussion #16578 (ggml-org benchmarks), tg32 / pp2048
import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetOf, MOE_EFF, prefillOf, speedOf } from '../web/js/advisor/engine.js';

const Q4_0 = 4.5 / 8;
const Q8_0 = 8.5 / 8;
const MXFP4 = 4.25 / 8;
const short = { ctx: 512, kv: 'f16', users: 1 };
const mac = (chip, mac) => budgetOf({ hw: 'mac', chip, mac });
const spark = budgetOf({ hw: 'gpu', gpu: 'dgx-spark', ngpu: 1, runtime: 'llamacpp' });

// [label, budget, active B, total B, bytes per parameter, measured tg tok/s, measured pp tok/s]
const POINTS = [
  ['M1 Max · Llama-2-7B Q4_0', mac('m1-max', 64), 6.74, 6.74, Q4_0, 61, 530],
  ['M2 Ultra · Llama-2-7B Q4_0', mac('m2-ultra', 192), 6.74, 6.74, Q4_0, 94, 1238],
  ['M3 Max · Llama-2-7B Q4_0', mac('m3-max', 128), 6.74, 6.74, Q4_0, 66, 760],
  ['M4 Max · Llama-2-7B Q4_0', mac('m4-max', 128), 6.74, 6.74, Q4_0, 83, 885],
  ['DGX Spark · gpt-oss-20b MXFP4', spark, 3.6, 20.9, MXFP4, 80, 3600],
  ['DGX Spark · gpt-oss-120b MXFP4', spark, 5.1, 116.8, MXFP4, 55, 1700],
  ['DGX Spark · Qwen3-30B-A3B Q8_0', spark, 3.3, 30.5, Q8_0, 60, 2900],
];

const TG_TOLERANCE = 0.25;
const PP_TOLERANCE = 0.5;

for (const [label, b, active, total, bpp, tg, pp] of POINTS) {
  test(`speed estimate · ${label}`, () => {
    const est = speedOf(active, bpp, short, b, 'gpu', 'llamacpp', 0) * (active < total ? MOE_EFF : 1);
    const err = est / tg - 1;
    assert.ok(Math.abs(err) <= TG_TOLERANCE, `generation: estimated ${est.toFixed(1)} vs measured ${tg} tok/s (${(err * 100).toFixed(0)}%)`);
    const p = prefillOf({ p: total, a: active < total ? active : null }, 'gpu', b, 'llamacpp');
    const perr = p / pp - 1;
    assert.ok(Math.abs(perr) <= PP_TOLERANCE, `prompt: estimated ${p.toFixed(0)} vs measured ${pp} tok/s (${(perr * 100).toFixed(0)}%)`);
  });
}
