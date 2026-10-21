// Randomised UI test of the Advisor: presets, every form control, the per-model Customize panel,
// run tabs and sorting, on desktop and phone widths. After every step: no console errors, no
// horizontal overflow, no "NaN" / "undefined" in the page, and the shared URL reproduces the results.
//
//   node tests/advisor-ui.mjs [--steps 150] [--seed 1]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const STEPS = +opt('--steps', 150);
let seed = +opt('--seed', 20261021);
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = (list) => list[Math.floor(rnd() * list.length)];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.xml': 'application/xml' };
const root = resolve('web');
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(body); } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const failures = [];

async function open(viewport, hash = '#advisor', extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text() + (m.location()?.url || ''))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack || ''}`));
  await page.goto(base + hash, { waitUntil: 'networkidle' });
  await page.waitForSelector('#a-results .advice, #a-results .empty', { timeout: 20000 });
  return { ctx, page, errors };
}

const topIds = (page) => page.$$eval('#a-results .advice', (xs) => xs.slice(0, 5).map((x) => x.dataset.id));

async function check(page, errors, label) {
  const info = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    text: document.querySelector('#view-advisor').innerText,
    codes: [...document.querySelectorAll('#view-advisor pre code')].map((c) => c.textContent).join('\n'),
  }));
  if (info.overflow > 0) failures.push(`${label}: horizontal overflow ${info.overflow}px`);
  const bad = (info.text + info.codes).match(/.{0,50}(\bNaN\b|\bundefined\b|\[object |\bInfinity\b).{0,30}/);
  if (bad) failures.push(`${label}: "${bad[0]}"`);
  for (const e of errors.splice(0)) failures.push(`${label}: ${e}`);
}

// One random interaction with whatever is visible and enabled.
let attempt = '';
async function step(page) {
  const kind = pick(['preset', 'select', 'select', 'radio', 'radio', 'check', 'range', 'range', 'cfg', 'cfg', 'cfg', 'tab', 'sort', 'more', 'fav', 'fav']);
  switch (kind) {
    case 'fav': {
      const saves = page.locator('.run-panel:not([hidden]) .fav-save');
      if (rnd() < 0.4 && await saves.count()) { attempt = 'fav save'; await saves.first().click({ timeout: 5000 }); return attempt; }
      if (!(await page.isVisible('.fav'))) { if (await page.$('.favs > summary')) { attempt = 'fav panel'; await page.click('.favs > summary', { timeout: 5000 }); return attempt; } return 'no favs'; }
      const acts = await page.$$eval('.fav [data-fav-act]', (xs) => xs.filter((x) => x.offsetParent).map((x, i) => x.dataset.favAct));
      if (!acts.length) return 'no fav actions';
      const act = pick(acts);
      attempt = `fav ${act}`;
      if (act === 'save') await page.fill('.fav-text', pick(['services:\n  x:\n    image: a:b\n', 'not yaml "', 'services:\n\tbad: tab\n']));
      await page.locator(`.fav [data-fav-act="${act}"]:visible`).first().click({ timeout: 5000 });
      return attempt;
    }
    case 'preset': {
      const n = await page.$$eval('.preset', (xs) => xs.length);
      const i = Math.floor(rnd() * n);
      attempt = `preset ${i}`;
      await page.click(`.preset[data-preset="${i}"]`);
      return `preset ${i}`;
    }
    case 'select': {
      const sels = await page.$$eval('#advisor-form select', (xs) => xs.filter((x) => x.offsetParent && !x.disabled).map((x) => ({ name: x.name, values: [...x.options].filter((o) => !o.disabled).map((o) => o.value) })));
      if (!sels.length) return 'no select';
      const s = pick(sels); const v = pick(s.values);
      await page.selectOption(`#advisor-form select[name="${s.name}"]`, v);
      return `select ${s.name}=${v}`;
    }
    case 'radio':
    case 'check': {
      const type = kind === 'radio' ? 'radio' : 'checkbox';
      const items = await page.$$eval(`#advisor-form input[type="${type}"]`, (xs) => xs.map((x, i) => ({ i, id: `${x.name}=${x.value}`, vis: !!(x.offsetParent || x.closest('label')?.offsetParent) })).filter((x) => x.vis));
      if (!items.length) return `no ${type}`;
      const it = pick(items);
      attempt = `${type} ${it.id}`;
      await page.locator(`#advisor-form input[type="${type}"]`).nth(it.i).click({ force: true, timeout: 5000 });
      return attempt;
    }
    case 'range': {
      const ranges = await page.$$eval('#advisor-form input[type="range"]', (xs) => xs.filter((x) => x.offsetParent).map((x) => ({ name: x.name, min: +x.min, max: +x.max, step: +x.step || 1 })));
      if (!ranges.length) return 'no range';
      const r = pick(ranges);
      const v = r.min + Math.round((rnd() * (r.max - r.min)) / r.step) * r.step;
      await page.$eval(`#advisor-form input[name="${r.name}"]`, (x, val) => { x.value = String(val); x.dispatchEvent(new Event('input', { bubbles: true })); x.dispatchEvent(new Event('change', { bubbles: true })); }, v);
      return `range ${r.name}=${v}`;
    }
    case 'cfg': {
      const panels = await page.$$('.cfg');
      if (!panels.length || rnd() < 0.3) {
        const n = Math.min(4, await page.locator('.cfg-toggle').count());
        if (!n) return 'no customize';
        attempt = 'toggle customize';
        await page.locator('.cfg-toggle').nth(Math.floor(rnd() * n)).click({ timeout: 5000 });
        return 'toggle customize';
      }
      const fields = await page.$$eval('.cfg [data-k]', (xs) => xs.map((x, i) => ({ i, k: x.dataset.k, tag: x.tagName, type: x.type, values: x.tagName === 'SELECT' ? [...x.options].map((o) => o.value) : null, min: x.min, max: x.max, step: x.step })));
      if (!fields.length) return 'empty cfg';
      if (rnd() < 0.08) { attempt = 'cfg reset'; await page.click('.cfg-reset', { timeout: 5000 }); return 'cfg reset'; }
      attempt = `cfg field ${JSON.stringify(fields.length)}`;
      const f = pick(fields);
      const loc = page.locator('.cfg [data-k]').nth(f.i);
      if (f.tag === 'SELECT') { const v = pick(f.values); await loc.selectOption(v); return `cfg ${f.k}=${v}`; }
      attempt = `cfg ${f.k} ${f.type}`;
      if (f.type === 'checkbox') { await loc.click({ timeout: 5000 }); return `cfg toggle ${f.k}`; }
      if (f.type === 'range') {
        const v = (+f.min + Math.round((rnd() * (+f.max - +f.min)) / +f.step) * +f.step).toFixed(2);
        await loc.evaluate((x, val) => { x.value = val; x.dispatchEvent(new Event('input', { bubbles: true })); x.dispatchEvent(new Event('change', { bubbles: true })); }, v);
        return `cfg ${f.k}=${v}`;
      }
      const v = f.type === 'number' ? pick(['', '8000', '0', '99999', '-5', '1234']) : pick(['', 'my-model', 'weird name!!', '<b>x</b>', 'v0.11.0']);
      await loc.fill(v); await loc.dispatchEvent('change');
      return `cfg ${f.k}="${v}"`;
    }
    case 'tab': {
      const n = Math.min(12, await page.locator('.run-tab').count());
      if (!n) return 'no tabs';
      attempt = 'run tab';
      await page.locator('.run-tab').nth(Math.floor(rnd() * n)).click({ timeout: 5000 });
      return 'run tab';
    }
    case 'sort': {
      const n = await page.locator('#a-sorts button:visible').count();
      if (!n) return 'no sort';
      attempt = 'sort';
      await page.locator('#a-sorts button:visible').nth(Math.floor(rnd() * n)).click({ timeout: 5000 });
      return 'sort';
    }
    default: {
      const more = await page.$('#a-more-btn:not([hidden])');
      if (more && await more.isVisible()) { await more.click(); return 'more'; }
      return 'no more';
    }
  }
}

for (const [name, viewport, steps] of [['desktop', { width: 1280, height: 900 }, STEPS], ['mobile', { width: 375, height: 760 }, Math.ceil(STEPS / 2)]]) {
  const { ctx, page, errors } = await open(viewport);
  const log = [];
  for (let i = 0; i < steps; i++) {
    let what;
    try { what = await step(page); } catch (e) { what = `step failed (${attempt}): ${e.message.split('\n')[0]}`; failures.push(`[${name}] ${what} after: ${log.slice(-3).join(' → ')}`); }
    log.push(what);
    await page.waitForTimeout(120);
    await check(page, errors, `[${name}] step ${i + 1} (${log.slice(-3).join(' → ')})`);
    // every 25 steps: the shared URL must reproduce the same list
    if (i % 25 === 24) {
      const hash = await page.evaluate(() => location.hash);
      const want = await topIds(page);
      const again = await open(viewport, hash);
      const got = await topIds(again.page);
      if (want.join() !== got.join()) failures.push(`[${name}] ${hash} reloads to a different list: ${want[0]} vs ${got[0]}`);
      for (const e of again.errors) failures.push(`[${name}] reload ${hash}: ${e}`);
      await again.ctx.close();
    }
  }
  console.log(`  ${name}: ${steps} random steps, last: ${log.slice(-4).join(' → ')}`);
  await ctx.close();
}

// Saved composes: save, rename, edit, survive a reload, reopen with the same settings, export / import, delete.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 900 }, '#advisor?u=agents&g=rtx-5090&rt=vllm&c=32768');
  const first = await page.$eval('#a-results .advice', (x) => x.dataset.id);
  // customise the first card (port) so reopening must restore it
  await page.locator('.cfg-toggle').first().click();
  await page.locator('.cfg [data-k="port"]').fill('9001');
  await page.locator('.cfg [data-k="port"]').dispatchEvent('change');
  await page.waitForTimeout(100);
  await page.locator('.advice').first().locator('.run-panel:not([hidden]) .fav-save').click();
  const saved = await page.$$eval('.fav', (xs) => xs.length);
  if (saved !== 1) failures.push(`favourites: ${saved} saved after one click`);
  await page.locator('.fav-name').fill('My 5090 agent');
  await page.locator('.fav-name').dispatchEvent('change');
  await page.click('[data-fav-act="edit"]');
  const text = await page.inputValue('.fav-text');
  if (!text.includes('9001')) failures.push('favourites: saved compose lacks the customised port');
  await page.fill('.fav-text', text.replace('restart: unless-stopped', 'restart: always'));
  await page.fill('.fav-note', 'prod box');
  await page.click('[data-fav-act="save"]');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#a-results .advice');
  await page.click('.favs > summary');
  const after = await page.evaluate(() => ({ name: document.querySelector('.fav-name')?.value, edited: !!document.querySelector('.fav .chip'), yaml: document.querySelector('.fav-preview code')?.textContent || '' }));
  if (after.name !== 'My 5090 agent' || !after.edited || !after.yaml.includes('restart: always')) failures.push(`favourites after reload: ${JSON.stringify({ ...after, yaml: after.yaml.slice(0, 40) })}`);
  // change the machine, then reopen: settings, Customize options and the tab come back
  await page.selectOption('#a-gpu', 'rtx-3060-12-gb');
  await page.waitForTimeout(150);
  await page.click('.favs > summary').catch(() => {});
  if (!(await page.isVisible('[data-fav-act="open"]'))) await page.click('.favs > summary');
  await page.click('[data-fav-act="open"]');
  await page.waitForTimeout(300);
  const reopened = await page.evaluate((id) => ({ gpu: document.querySelector('#a-gpu').value, cfg: !!document.querySelector(`.advice[data-id="${CSS.escape(id)}"] .cfg`), port: document.querySelector(`.advice[data-id="${CSS.escape(id)}"] .cfg [data-k="port"]`)?.value }), first);
  if (reopened.gpu !== 'rtx-5090' || !reopened.cfg || reopened.port !== '9001') failures.push(`favourites reopen: ${JSON.stringify(reopened)}`);
  // export, delete (two clicks), import back
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-fav-act="export"]')]);
  const file = await download.path();
  await page.click('[data-fav-act="delete"]');
  await page.click('[data-fav-act="delete"]');
  if (await page.$$eval('.fav', (xs) => xs.length) !== 0) failures.push('favourites: delete did not remove it');
  await page.setInputFiles('.fav-import', file);
  await page.waitForTimeout(200);
  if (await page.$$eval('.fav', (xs) => xs.length) !== 1) failures.push('favourites: import did not bring it back');
  await check(page, errors, 'favourites');
  console.log('  favourites: save → rename → edit → reload → reopen → export → delete → import ok');
  await ctx.close();
}

// Share a saved compose by link: a fresh browser opens it, sees it and saves it.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 900 }, '#advisor?u=chat&g=rtx-4090&rt=vllm', { permissions: ['clipboard-read', 'clipboard-write'] });
  const stackTab = page.locator('.advice').first().locator('.run-tab', { hasText: 'Full stack' });
  if (!(await stackTab.count())) failures.push('stack: no "Full stack" tab on a vLLM card');
  else {
    await stackTab.click();
    const code = await page.locator('.advice').first().locator('.run-panel:not([hidden]) pre code').textContent();
    if (!/open-webui:/.test(code) || !/OPENAI_API_BASE_URL=http:\/\/vllm:8000\/v1/.test(code) || !/embeddings:/.test(code)) failures.push('stack: compose lacks Open WebUI wired to vLLM or the embeddings service');
    await page.locator('.advice').first().locator('.run-panel:not([hidden]) .fav-save').click();
  }
  await page.click('[data-fav-act="share"]');
  await page.waitForTimeout(300);
  const url = await page.evaluate(() => navigator.clipboard.readText());
  if (!/#advisor\?.*fav=[zj]/.test(url)) failures.push(`share: unexpected link ${url.slice(0, 80)}`);
  const other = await open({ width: 1280, height: 900 }, url.slice(url.indexOf('#')));
  await other.page.waitForSelector('.fav-shared', { timeout: 5000 }).catch(() => failures.push('share: the shared compose is not offered'));
  await other.page.click('[data-fav-act="shared-save"]').catch(() => {});
  const saved = await other.page.evaluate(() => ({ n: document.querySelectorAll('.fav').length, yaml: document.querySelector('.fav-preview code')?.textContent || '' }));
  if (saved.n !== 1 || !/open-webui/.test(saved.yaml)) failures.push(`share: after saving the shared compose: ${JSON.stringify({ n: saved.n })}`);
  await check(other.page, other.errors, 'shared link');
  await other.ctx.close();
  await check(page, errors, 'share + stack');
  console.log(`  share link (${url.length} chars) → fresh browser → saved; full stack tab ok`);
  await ctx.close();
}

// Nothing fits: the one-click fixes bring results back.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 900 }, '#advisor?g=rtx-4060-laptop&lo=22&mu=vision&c=262144');
  const fixes = await page.$$eval('[data-fix]', (xs) => xs.map((x) => x.textContent));
  if (!fixes.length) failures.push('empty state: no suggested fixes');
  else {
    await page.click('[data-fix="0"]');
    await page.waitForTimeout(150);
    if (!(await page.$('#a-results .advice'))) failures.push(`empty state: "${fixes[0]}" did not bring results`);
  }
  await check(page, errors, 'empty-state fixes');
  console.log(`  nothing-fits suggestions: ${fixes.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

// Old shared links (unified machines had their own switch) still open the right machine.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 900 }, '#advisor?hw=unified&uf=dgx-spark&nu=2&rt=vllm');
  const st = await page.evaluate(() => ({ gpu: document.querySelector('#a-gpu').value, n: document.querySelector('#a-ngpu').value, summary: document.querySelector('#a-summary')?.innerText || '' }));
  if (st.gpu !== 'dgx-spark' || st.n !== '2') failures.push(`legacy link: gpu=${st.gpu} units=${st.n}`);
  if (!/DGX Spark/.test(st.summary)) failures.push('legacy link: summary does not mention the DGX Spark');
  await check(page, errors, 'legacy link');
  console.log(`  legacy link → ${st.gpu} × ${st.n}`);
  await ctx.close();
}

await browser.close();
server.close();
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n- ${[...new Set(failures)].slice(0, 40).join('\n- ')}`);
  process.exit(1);
}
console.log('\nAdvisor UI fuzz passed.');
