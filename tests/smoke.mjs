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

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const failures = [];

async function checkViewport(name, viewport, theme) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: shotsDir ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text() + (m.location()?.url || ''))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  // Web fonts are optional (system fallbacks); anything else failing to load is an error.
  const optional = (u) => /fonts\.(googleapis|gstatic)\.com/.test(u);
  page.on('requestfailed', (r) => { if (!optional(r.url())) errors.push(`request failed: ${r.url()}`); });
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

await browser.close();
server?.close();
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll views passed.');
