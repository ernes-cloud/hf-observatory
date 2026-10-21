// Combinatorial checks of the advisor on the real data (web/data/advisor.json): every machine,
// use and runtime, with random settings and random per-model "Customize" options.
// Invariants: what is recommended fits, numbers are finite, links point at real repositories,
// filters are respected and every generated command / Docker Compose file is well formed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { budgetOf, isGptOss, LLM_USES, QUANTS, recommend, refit, RUNTIMES, serverLadder, SIZE_STOPS, CTX_STOPS, USER_STOPS, USES, AGENT_KINDS, hasCap } from '../web/js/advisor/engine.js';
import { commandsFor, defaultOptions } from '../web/js/advisor/commands.js';
import { allGpus, MAC_CHIPS, RAM_SIZES } from '../web/js/advisor/hardware.js';

const DATA = new URL('../web/data/advisor.json', import.meta.url);
const data = existsSync(DATA) ? JSON.parse(readFileSync(DATA, 'utf8')) : null;
let YAML = null;
try { YAML = await import('yaml'); } catch { if (process.env.CI) throw new Error('npm install yaml@2.8.1 to run the compose checks'); }

// Small seeded PRNG so failures are reproducible.
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];

function randomState(r, hw) {
  const s = {
    use: pick(r, USES).v, agent: pick(r, AGENT_KINDS).v, ragPart: pick(r, ['both', 'embed', 'rerank']),
    hw, gpu: 'rtx-4090', ngpu: 1, chip: 'm4', mac: 16, ram: pick(r, RAM_SIZES), cpuMem: pick(r, ['ddr4', 'ddr5', 'server']),
    offload: r() < 0.3, runtime: 'any', ctx: pick(r, CTX_STOPS), users: pick(r, USER_STOPS), kv: pick(r, ['f16', 'q8', 'q4']),
    spec: r() < 0.8 ? 'auto' : 'off', think: pick(r, ['default', 'on', 'off']), priority: Math.round(r() * 10) * 10,
    sizeLo: 0, sizeHi: SIZE_STOPS.length - 1, sort: pick(r, ['best', 'quality', 'fast']),
    archFilter: pick(r, ['any', 'any', 'dense', 'moe']), must: '', commercial: r() < 0.2, hideGated: r() < 0.2,
    uncensored: r() < 0.1, officialOnly: r() < 0.1, lang: r() < 0.2 ? pick(r, ['es', 'fr', 'zh', 'de']) : '',
  };
  if (r() < 0.4) { s.sizeLo = Math.floor(r() * 12); s.sizeHi = s.sizeLo + Math.floor(r() * (SIZE_STOPS.length - s.sizeLo)); }
  if (r() < 0.35) s.must = ['tools', 'vision', 'reasoning', 'longctx', 'spec', 'prequant'].filter(() => r() < 0.3).join(',');
  if (hw === 'mac') { const c = pick(r, MAC_CHIPS); s.chip = c.id; s.mac = pick(r, c.sizes); s.runtime = pick(r, ['any', 'ollama', 'lmstudio', 'llamacpp', 'mlx']); }
  if (hw === 'cpu') s.runtime = pick(r, ['any', 'ollama', 'lmstudio', 'llamacpp']);
  if (hw === 'gpu') s.runtime = pick(r, ['any', ...Object.keys(RUNTIMES).filter((k) => k !== 'mlx')]);
  return s;
}

function randomOpts(r, o) {
  const x = { ...o };
  if (r() < 0.5) x.spec = 'off';
  if (r() < 0.5) x.think = pick(r, ['default', 'on', 'off', 'low', 'medium', 'high']);
  if (r() < 0.5) x.ctx = pick(r, CTX_STOPS);
  if (r() < 0.5) x.users = pick(r, USER_STOPS);
  if (r() < 0.5) x.kv = pick(r, ['f16', 'q8', 'q4']);
  for (const k of ['reasoningParser', 'apiKey', 'tools', 'prefixCache', 'expertParallel', 'restart', 'healthcheck']) if (r() < 0.3) x[k] = !x[k];
  if (r() < 0.3) x.port = 1 + Math.floor(r() * 65000);
  if (r() < 0.3) x.servedName = 'my-model';
  if (r() < 0.3) x.gpuUtil = 0.5 + Math.round(r() * 9) * 0.05;
  if (r() < 0.3) x.specTokens = 1 + Math.floor(r() * 10);
  return x;
}

const BAD_TEXT = /\bundefined\b|\bNaN\b|\[object |\bInfinity\b|: null\b|=null\b|\bnull\b(?!\))/;

function checkCommands(tabs, where) {
  assert.ok(tabs.length > 0, `${where}: no run instructions`);
  for (const t of tabs) {
    for (const text of [t.code, t.note, t.label]) if (text) assert.doesNotMatch(text, BAD_TEXT, `${where} · ${t.label}: ${text}`);
    if (t.yaml && YAML) {
      const doc = YAML.parse(t.code.split('\n# then:')[0]);
      assert.ok(doc?.services && Object.keys(doc.services).length === 1, `${where} · ${t.label}: no service`);
      const svc = Object.values(doc.services)[0];
      assert.match(svc.image, /^[\w./-]+:[\w.-]+$/, `${where} · ${t.label}: image`);
      if (svc.command != null) {
        assert.equal(typeof svc.command, 'string');
        // quotes in the command must be balanced or compose cannot split it
        assert.equal((svc.command.match(/'/g) || []).length % 2, 0, `${where}: unbalanced quotes in ${svc.command}`);
        assert.doesNotMatch(svc.command.trim(), /\n/, 'folded command must be one line');
      }
      for (const p of svc.ports || []) assert.match(p, /^\d{1,5}:\d{1,5}$/);
    }
  }
}

function checkResult(res, s, label, r) {
  const b = res.budget;
  const isLLM = LLM_USES.has(s.use);
  const lo = SIZE_STOPS[s.sizeLo], hi = SIZE_STOPS[s.sizeHi];
  const sized = s.sizeLo > 0 || s.sizeHi < SIZE_STOPS.length - 1;
  const must = s.must ? s.must.split(',') : [];
  for (const [i, x] of res.list.slice(0, 12).entries()) {
    const { m, fit, kind } = x;
    const where = `${label} #${i + 1} ${m.id} (${kind} ${fit.quant})`;
    if (s.commercial) assert.equal(m.lf, 'oss', where);
    if (s.hideGated) assert.ok(!m.gated, where);
    if (sized) assert.ok(m.p >= lo * 0.9 && m.p <= hi * 1.1, `${where}: size ${m.p} outside ${lo}–${hi}`);
    if (s.archFilter === 'moe') assert.ok(m.moe || m.a, `${where}: not MoE`);
    if (s.archFilter === 'dense') assert.ok(!m.moe && !m.a, `${where}: is MoE`);
    if (must.includes('vision')) assert.ok(hasCap(data, m, 'vision'), where);
    if (must.includes('longctx')) assert.ok(m.mc ? m.mc >= 131072 : hasCap(data, m, 'longctx'), `${where}: not long-context (${m.mc})`);
    if (must.includes('spec') && isLLM) assert.ok(fit.spec, `${where}: no speculative option`);
    if (!isLLM) continue;
    if (m.mc) assert.ok(x.ctx <= m.mc, `${where}: context ${x.ctx} beyond the model's ${m.mc}`);
    if (fit.pp != null) assert.ok(Number.isFinite(fit.pp) && fit.pp > 0, `${where}: prompt speed ${fit.pp}`);
    // fits the pool it claims to run from
    const pool = fit.where === 'gpu' ? b.fast : b.fast + b.slow;
    assert.ok(fit.need.total <= pool + 1e-6, `${where}: needs ${fit.need.total.toFixed(1)} GB of ${pool.toFixed(1)}`);
    assert.ok(Number.isFinite(fit.tps) && fit.tps > 0 && fit.tps <= 250 * 3, `${where}: tps ${fit.tps}`);
    if (b.kind === 'cpu') assert.equal(fit.where, 'cpu', where);
    if (fit.where === 'split') assert.ok(b.slow > 0, `${where}: split without offload`);
    // the repository you are sent to
    if (kind === 'st') {
      const labels = serverLadder(b.arch, m).map(([q]) => q);
      assert.ok(labels.includes(fit.quant), `${where}: ${fit.quant} is not a ${b.arch} format`);
      assert.ok(fit.repo === m.id || Object.values(m.q || {}).includes(fit.repo), `${where}: repo ${fit.repo}`);
      if (fit.quant === 'NVFP4') assert.equal(b.arch, 'blackwell', where);
      assert.ok(!['mac', 'cpu'].includes(b.kind), `${where}: server format on ${b.kind}`);
    } else {
      assert.ok(QUANTS[kind].some(([q]) => q === fit.quant) || (isGptOss(m) && fit.quant === 'MXFP4'), `${where}: unknown ${kind} quant`);
      if (isGptOss(m)) assert.equal(fit.quant, 'MXFP4', `${where}: gpt-oss is re-quantized`);
      if (kind === 'mlx') assert.equal(b.kind, 'mac', where);
    }
    if (fit.spec) {
      assert.notEqual(s.spec, 'off', where);
      assert.ok(x.specs.some((o) => o.method === fit.spec.method), where);
      assert.ok(fit.tps >= fit.tpsBase, where);
      if (fit.spec.draft) assert.ok((m.dr || []).some((d) => d.id === fit.spec.draft), `${where}: draft ${fit.spec.draft}`);
    }
    // the generated commands, with the recommended and with random per-model settings
    checkCommands(commandsFor(x, s, b, data.caps, null, x.specs), where);
    const o = randomOpts(r, defaultOptions(x, s, b));
    const specObj = o.spec === 'off' ? null : x.specs.find((sp) => sp.method === o.spec) || null;
    const f2 = refit(x, { ...s, ctx: o.ctx, users: o.users, kv: o.kv }, b, specObj);
    assert.ok(Number.isFinite(f2.need.total) && Number.isFinite(f2.tps) && f2.tps > 0, `${where}: refit`);
    assert.equal(typeof f2.fits, 'boolean');
    checkCommands(commandsFor(x, s, b, data.caps, o, x.specs), `${where} (custom ${JSON.stringify(o)})`);
  }
}

test('advisor invariants hold for every machine, use and runtime', { skip: !data && 'build web/data first' }, () => {
  const r = rng(20261021);
  const machines = [
    ...allGpus().map((g) => ['gpu', g.id]),
    ['mac', null], ['mac', null], ['mac', null], ['cpu', null], ['cpu', null],
  ];
  let checked = 0;
  for (const [hw, gpu] of machines) {
    for (let k = 0; k < 4; k++) {
      const s = randomState(r, hw);
      if (gpu) {
        s.gpu = gpu;
        const g = allGpus().find((x) => x.id === gpu);
        s.ngpu = g.unified ? 1 + Math.floor(r() * (g.cluster || 1)) : pick(r, [1, 1, 2, 4, 8]);
        if (g.unified) s.offload = false;
      }
      const label = `${hw}:${gpu || s.chip || ''}×${s.ngpu} ${s.use}/${s.runtime} ctx${s.ctx} u${s.users} p${s.priority}${s.must ? ` must=${s.must}` : ''} ${s.archFilter}`;
      const res = recommend(data, s);
      assert.ok(Number.isFinite(res.budget.fast) && Number.isFinite(res.budget.slow), label);
      checkResult(res, s, label, r);
      checked += res.list.length ? 1 : 0;
    }
  }
  assert.ok(checked > 100, `only ${checked} scenarios produced results`);
});

test('unified-memory machines picked from the GPU list behave like the unified budget', { skip: !data }, () => {
  const spark = budgetOf({ hw: 'gpu', gpu: 'dgx-spark', ngpu: 1, ram: 64, cpuMem: 'ddr5' });
  assert.equal(spark.kind, 'unified');
  assert.equal(spark.fast, 119);
  assert.equal(spark.arch, 'blackwell');
  assert.equal(budgetOf({ hw: 'gpu', gpu: 'dgx-spark', ngpu: 2, runtime: 'vllm' }).fast, 238);
  assert.equal(budgetOf({ hw: 'gpu', gpu: 'dgx-spark', ngpu: 5, runtime: 'sglang' }).n, 2); // at most two linked units
  assert.equal(budgetOf({ hw: 'gpu', gpu: 'dgx-spark', ngpu: 2, runtime: 'llamacpp' }).n, 1);
  assert.equal(budgetOf({ hw: 'gpu', gpu: 'strix-halo-128', ngpu: 1 }).vendor, 'amd');
});

test('every model in the data is well formed', { skip: !data }, () => {
  const ids = new Set();
  for (const m of data.models) {
    assert.ok(!ids.has(m.id), `duplicate ${m.id}`); ids.add(m.id);
    assert.match(m.id, /^[\w.-]+\/[\w.-]+$/);
    if (m.p != null) assert.ok(m.p > 0 && m.p < 5000, `${m.id}: ${m.p}B`);
    if (m.a != null) assert.ok(m.a > 0 && m.a < m.p, `${m.id}: ${m.a}B active of ${m.p}B`);
    for (const repo of [m.gguf, m.mlx, m.gmtp, ...Object.values(m.q || {}), ...(m.dr || []).map((d) => d.id)].filter(Boolean)) assert.match(repo, /^[\w.-]+\/[\w.-]+$/, m.id);
    for (const d of m.dr || []) assert.ok(['dflash2', 'dflash', 'dspark', 'eagle3', 'eagle'].includes(d.m), `${m.id}: draft ${d.m}`);
    // architecture read from config.json
    if (m.kvb != null) assert.ok(m.kvb >= 0 && m.kvb < 4e6, `${m.id}: ${m.kvb} KV bytes per token`);
    if (m.kvs != null) assert.ok(m.kvs > 0 && m.win > 0, `${m.id}: sliding window ${m.kvs} / ${m.win}`);
    if (m.mc != null) assert.ok(m.mc >= 512 && m.mc <= 16777216, `${m.id}: context ${m.mc}`);
  }
});
