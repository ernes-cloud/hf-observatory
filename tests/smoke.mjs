// Headless smoke test: every tab renders, no console errors, no horizontal
// scroll on a phone-sized viewport, both themes work.
//
//   node tests/smoke.mjs [--screenshots docs/screenshots] [--base http://localhost:8000]
//
// Without --base it serves ./web itself on a random port.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const shotsDir = opt('--screenshots');
let base = opt('--base');

const VIEWS = (opt('--views') || 'home,advisor,overview,finder,trends,families,graveyard,newsletter,about').split(',');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.md': 'text/markdown' };

let server;
if (!base) {
  const root = resolve('web');
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
}

// Accessibility: axe-core (WCAG 2 A/AA rules) on every view; serious and critical findings fail.
// Injected through the DevTools protocol, which the page's Content-Security-Policy does not block.
let axeSource = null;
try { axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { console.log('  (axe-core not installed: accessibility checks skipped)'); }

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const failures = [];

async function checkViewport(name, viewport, theme) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: shotsDir ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  // Everything is served by the site itself (fonts included): any failed request is an error.
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });

  for (const view of VIEWS) {
    await page.goto(`${base}#${view}`, { waitUntil: 'networkidle' });
    const sel = `#view-${view}`;
    try {
      await page.waitForSelector(`${sel}:not([hidden]) h1`, { timeout: 20000 });
      await page.waitForFunction((s) => !document.querySelector(`${s} .loading`), sel, { timeout: 20000 });
    } catch {
      failures.push(`[${name}/${theme}] ${view}: did not render`);
      continue;
    }
    await page.waitForTimeout(250);
    const info = await page.evaluate((s) => ({
      error: document.querySelector(`${s} .error`)?.textContent || null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      h1: document.querySelector(`${s} h1`)?.textContent,
    }), sel);
    if (info.error) failures.push(`[${name}/${theme}] ${view}: ${info.error}`);
    if (axeSource && name === 'desktop') {
      await page.evaluate(axeSource);
      const found = await page.evaluate(async (s) => {
        const r = await window.axe.run(s, { runOnly: ['wcag2a', 'wcag2aa'] });
        return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(' ')}`);
      }, sel);
      for (const f of found) failures.push(`[${name}/${theme}] ${view}: axe ${f}`);
    }
    if (info.overflow > 0) failures.push(`[${name}/${theme}] ${view}: horizontal overflow of ${info.overflow}px`);
    console.log(`  ${name.padEnd(7)} ${theme.padEnd(5)} ${view.padEnd(11)} ok  "${info.h1}"`);
    if (shotsDir && theme === 'light' && name === 'desktop') {
      await page.screenshot({ path: join(shotsDir, `${view}.png`), fullPage: false });
    }
    if (shotsDir && theme === 'dark' && name === 'desktop' && view === 'overview') {
      await page.screenshot({ path: join(shotsDir, `${view}-dark.png`), fullPage: false });
    }
    if (shotsDir && name === 'mobile' && theme === 'light' && view === 'finder') {
      await page.screenshot({ path: join(shotsDir, `${view}-mobile.png`), fullPage: false });
    }
  }
  for (const e of errors) failures.push(`[${name}/${theme}] console: ${e}`);
  await ctx.close();
}

if (shotsDir) await mkdir(shotsDir, { recursive: true });
console.log(`Testing ${base}`);
await checkViewport('desktop', { width: 1280, height: 900 }, 'light');
await checkViewport('desktop', { width: 1280, height: 900 }, 'dark');
await checkViewport('mobile', { width: 375, height: 760 }, 'light');

// Interaction check: the finder filters respond and the URL keeps the state.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}#finder?task=text-generation&mem=16&fmt=gguf&lic=commercial`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#f-results .model-card, #f-results .empty', { timeout: 20000 });
  const count = await page.textContent('#f-count');
  await page.fill('#f-q', 'qwen');
  await page.waitForTimeout(400);
  const count2 = await page.textContent('#f-count');
  const hash = await page.evaluate(() => location.hash);
  console.log(`  finder interaction: "${count}" → "${count2}" (${hash})`);
  if (!hash.includes('q=qwen')) failures.push('finder: search not reflected in the URL');
  await ctx.close();
}

// Connected pages: a finder card opens the model page; publisher, family and compare pages render;
// the header search jumps to a model; unknown routes fall back to Home.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const axe = async (view) => {
    if (!axeSource) return;
    await page.evaluate(axeSource);
    const found = await page.evaluate(async (s) => (await window.axe.run(s, { runOnly: ['wcag2a', 'wcag2aa'] })).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`), `#view-${view}`);
    for (const f of found) failures.push(`${view} page: axe ${f}`);
  };
  await page.goto(`${base}#finder`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#f-results .model-card h2 a', { timeout: 20000 });
  const first = await page.textContent('#f-results .model-card h2 a');
  await page.click('#f-results .model-card h2 a');
  await page.waitForSelector('#h-model', { timeout: 20000 });
  const title = (await page.textContent('#h-model')).trim();
  if (title !== first.trim()) failures.push(`model page: opened "${title}" from "${first}"`);
  await page.waitForSelector('#view-model .alt-list, #view-model .card .note', { timeout: 20000 });
  await axe('model');
  await page.click('#view-model .hero-actions [data-compare]');
  const tray = await page.isVisible('#compare-tray');
  if (!tray) failures.push('compare: tray did not appear after "+ Compare"');
  const org = title.split('/')[0];
  await page.goto(`${base}#org?name=${encodeURIComponent(org)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#h-org', { timeout: 20000 });
  const orgModels = await page.$$eval('#view-org .alt-list li', (x) => x.length);
  if (!orgModels) failures.push(`publisher page: no models listed for ${org}`);
  await axe('org');
  await page.goto(`${base}#family?name=Qwen`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#h-family', { timeout: 20000 });
  await page.goto(`${base}#compare`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-compare table', { timeout: 20000 });
  await axe('compare');
  await page.fill('#site-search-q', first.trim().split('/')[1].slice(0, 12));
  await page.waitForSelector('#site-search-list li', { timeout: 10000 });
  const suggestions = await page.$$eval('#site-search-list li', (x) => x.length);
  await page.fill('#site-search-q', first.trim());
  await page.press('#site-search-q', 'Enter');
  await page.waitForFunction(() => location.hash.startsWith('#model'), null, { timeout: 10000 });
  await page.goto(`${base}#does-not-exist`, { waitUntil: 'networkidle' });
  const fallback = await page.evaluate(() => location.hash);
  if (fallback !== '#home') failures.push(`unknown route kept "${fallback}"`);
  for (const e of errs) failures.push(`connected pages: ${e}`);
  console.log(`  connected pages: ${first.trim()} → model page, compare tray, ${orgModels} models of ${org}, family, ${suggestions} search suggestions`);
  await ctx.close();
}

await browser.close();
server?.close();
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll views passed.');
