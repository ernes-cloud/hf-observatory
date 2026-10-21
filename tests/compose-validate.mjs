// Validate generated Docker Compose files with Docker's own parser (`docker compose config`).
// Generates the compose tabs (including the full stack) for many machines, runtimes and per-model
// settings from the real web/data/advisor.json, then runs `docker compose -f <file> config -q` on each.
//
//   node tests/compose-validate.mjs [--max 400]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recommend } from '../web/js/advisor/engine.js';
import { commandsFor, defaultOptions } from '../web/js/advisor/commands.js';

const args = process.argv.slice(2);
const MAX = +(args[args.indexOf('--max') + 1] || 400) || 400;
const data = JSON.parse(readFileSync(new URL('../web/data/advisor.json', import.meta.url), 'utf8'));
const base = { use: 'chat', agent: 'coding', ragPart: 'both', hw: 'gpu', gpu: 'rtx-4090', ngpu: 1, gpu2: '', ngpu2: 1, chip: 'm4-max', mac: 64, ram: 64, cpuMem: 'ddr5',
  offload: false, runtime: 'any', ctx: 32768, users: 1, kv: 'f16', spec: 'auto', think: 'default', sizeLo: 0, sizeHi: 25, priority: 40, archFilter: 'any', must: '', sort: 'best' };

const machines = [
  { gpu: 'rtx-4090' }, { gpu: 'rtx-5090' }, { gpu: 'rtx-3090', ngpu: 2 }, { gpu: 'rtx-3090', ngpu: 6 }, { gpu: 'h100-sxm', ngpu: 8 },
  { gpu: 'dgx-spark' }, { gpu: 'dgx-spark', ngpu: 2 }, { gpu: 'strix-halo-128' }, { gpu: 'radeon-rx-7900-xtx' }, { gpu: 'instinct-mi300x', ngpu: 8 },
  { gpu: 'arc-b580' }, { gpu: 'rtx-4090', gpu2: 'rtx-3090' }, { gpu: 'rtx-4090', offload: true, ram: 96 }, { gpu: 'a100-80-gb', ngpu: 2 }, { gpu: 't4' },
  { hw: 'mac', chip: 'm4-max', mac: 128 }, { hw: 'cpu', ram: 64 },
];
const runtimes = ['any', 'ollama', 'llamacpp', 'vllm', 'sglang', 'lmstudio', 'mlx'];
const uses = ['chat', 'agents', 'code', 'reasoning', 'vision', 'rag'];
const variants = [
  {},
  { spec: 'off', think: 'off', tools: false, stackRag: false },
  { apiKey: true, port: 9001, servedName: 'my-model', imageTag: 'v0.11.0', restart: false, healthcheck: false, kv: 'q8', users: 8, expertParallel: true },
  { stackUi: false, stackRag: true, prefixCache: false, reasoningParser: false },
];
const stack = { embed: 'BAAI/bge-m3', rerank: 'BAAI/bge-reranker-v2-m3' };

const dir = mkdtempSync(join(tmpdir(), 'hfo-compose-'));
const failures = [];
let checked = 0;
outer: for (const mach of machines) {
  for (const runtime of runtimes) {
    for (const use of uses) {
      const s = { ...base, ...mach, runtime, use };
      if (runtime === 'mlx' && s.hw !== 'mac') continue;
      if (['vllm', 'sglang'].includes(runtime) && s.hw !== 'gpu') continue;
      const { list, budget } = recommend(data, s);
      for (const r of list.slice(0, 2)) {
        for (const v of variants) {
          const o = { ...defaultOptions(r, s, budget), ...v };
          for (const t of commandsFor(r, s, budget, data.caps, o, r.specs, stack)) {
            if (!t.yaml) continue;
            const file = join(dir, `c${checked}.yml`);
            writeFileSync(file, t.code);
            checked++;
            try {
              execFileSync('docker', ['compose', '-f', file, 'config', '-q'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HF_TOKEN: 'x', HEAD_IP: '10.0.0.1' } });
            } catch (e) {
              failures.push(`${JSON.stringify(mach)} ${runtime}/${use} ${r.m.id} · ${t.label}: ${String(e.stderr || e.message).trim().split('\n').slice(-3).join(' | ')}\n${t.code}`);
              if (failures.length > 5) break outer;
            }
            if (checked >= MAX) break outer;
          }
        }
      }
    }
  }
}
rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.error(`${failures.length} invalid compose file(s) out of ${checked}:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`docker compose config accepted all ${checked} generated compose files.`);
