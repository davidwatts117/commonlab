// Headless visual and behavioural verification for generated engines.
// The engine runs in a disposable Chromium page served from loopback only; all
// non-loopback requests are aborted. Nothing here is a security sandbox for the
// engine, so the worker container remains the actual boundary.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_ROOT = resolve(process.env.CL_PUBLIC_ROOT || '/app/public');
const MAX_IMAGE_BYTES = 360 * 1024;
const MAX_IMAGES = 4;
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const harness = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>CommonLab verification</title>
<link rel="stylesheet" href="/main.css"><link rel="stylesheet" href="/simulation.css">
</head><body class="paper"><div id="sandbox-root"></div>
<script src="/library.js"></script><script src="/cfu.js"></script><script src="/guided.js"></script>
<script type="module" src="/__verify-boot.mjs"></script>
</body></html>`;

function safePath(urlPath) {
  if (urlPath === '/__verify.html') return { inline: harness };
  if (urlPath === '/__verify-page.mjs') return { file: join(here, 'verify-page.mjs') };
  if (urlPath === '/__verify-boot.mjs') return { file: join(here, 'verify-boot.mjs') };
  let path;
  try { path = decodeURIComponent(urlPath); } catch { return null; }
  const full = normalize(join(PUBLIC_ROOT, path));
  if (!full.startsWith(`${PUBLIC_ROOT}/`)) return null;
  return { file: full };
}

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
      const target = safePath(url.pathname);
      if (!target) { response.writeHead(404).end(); return; }
      if (target.inline) { response.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }).end(target.inline); return; }
      const info = await stat(target.file).catch(() => null);
      if (!info?.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': MIME[extname(target.file)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
      if (request.method === 'HEAD') response.end(); else createReadStream(target.file).pipe(response);
    } catch { try { response.writeHead(500).end(); } catch { /* ignore */ } }
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  return { server, port: server.address().port };
}

async function capture(page, selector, label, report) {
  if (report.screenshots.length >= MAX_IMAGES) return;
  try {
    const locator = page.locator(selector);
    if (!(await locator.count())) return;
    const box = await locator.boundingBox();
    if (!box || box.width < 2 || box.height < 2) return;
    let buffer = await locator.screenshot({ type: 'jpeg', quality: 60, animations: 'disabled' });
    if (buffer.length > MAX_IMAGE_BYTES) buffer = await locator.screenshot({ type: 'jpeg', quality: 35, animations: 'disabled' });
    if (buffer.length > MAX_IMAGE_BYTES) { report.warnings.push(`Screenshot ${label} exceeded the 360 KiB cap and was omitted.`); return; }
    report.screenshots.push({ label, mimeType: 'image/jpeg', data: buffer.toString('base64'), bytes: buffer.length });
  } catch (error) {
    report.warnings.push(`Could not capture ${label}: ${String(error?.message || error).slice(0, 200)}`);
  }
}
function statusSummary(report) {
  return {
    ok: report.ok,
    runtimeErrors: report.runtimeErrors.slice(0, 5),
    consoleErrors: report.consoleErrors.slice(0, 5),
    tests: report.tests,
    canvases: report.canvases,
    warnings: report.warnings.slice(0, 8),
    screenshots: report.screenshots.map(({ label, bytes }) => ({ label, bytes })),
    durationMs: report.durationMs,
  };
}
export function formatVerification(report) {
  const failed = report.tests.results.filter(result => !result.ok);
  return `Headless verification ${report.ok ? 'PASSED' : 'FAILED'} in ${report.durationMs} ms.
${JSON.stringify({
    runtimeErrors: report.runtimeErrors.slice(0, 4),
    consoleErrors: report.consoleErrors.slice(0, 4),
    tests: { total: report.tests.total, passed: report.tests.passed, failed: report.tests.failed, failures: failed.slice(0, 10) },
    canvases: report.canvases,
    warnings: report.warnings.slice(0, 8),
  }, null, 2)}
The report comes from a real Chromium render of the accepted definition and your source. A passing run does not prove scientific correctness. Fix every failure and any blank or visibly clipped canvas; keep correct work.`;
}
export async function verifyArtifact({ definition, moduleCode, tests = {} }, { onProgress = () => {}, timeoutMs = 120_000 } = {}) {
  const started = Date.now();
  const report = { ok: false, runtimeErrors: [], consoleErrors: [], tests: { total: 0, passed: 0, failed: 0, results: [] }, canvases: [], warnings: [], screenshots: [], durationMs: 0 };
  let server, browser;
  onProgress('verifying', { phase: 'implementation' });
  try {
    const harnessServer = await startServer();
    server = harnessServer.server;
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--mute-audio', '--disable-background-networking', '--no-first-run'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block', offline: false });
    await context.route('**/*', route => {
      try {
        const url = new URL(route.request().url());
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === String(harnessServer.port)) return route.continue();
      } catch { /* fall through */ }
      return route.abort();
    });
    const page = await context.newPage();
    const dedupe = (list, value) => { const text = String(value || '').slice(0, 400); if (text && !list.includes(text) && list.length < 8) list.push(text); };
    page.on('pageerror', error => dedupe(report.runtimeErrors, error?.message || error));
    page.on('console', message => { if (message.type() === 'error') dedupe(report.consoleErrors, message.text()); });
    const work = (async () => {
      await page.goto(`http://127.0.0.1:${harnessServer.port}/__verify.html`, { waitUntil: 'load', timeout: 30_000 });
      const harnessError = await page.evaluate(() => window.__harnessError || null);
      if (harnessError) throw new Error(`Verification harness failed to load: ${harnessError}`);
      await page.waitForFunction(() => document.getElementById('sandbox-root'), null, { timeout: 5000 });
      await page.evaluate(async ({ definition, moduleCode }) => {
        const mod = await import('/__verify-page.mjs');
        return mod.mount(definition, moduleCode);
      }, { definition, moduleCode });
      // Let a first animation frame paint the scene before measuring it.
      await page.waitForTimeout(350);
      const canvasIds = [definition.canvas?.id, ...(definition.graphs || []).map(graph => graph.id)].filter(Boolean).slice(0, 6);
      for (const id of canvasIds) {
        report.canvases.push(await page.evaluate(canvasId => import('/__verify-page.mjs').then(mod => mod.pixelStats(canvasId)), id).catch(error => ({ id, error: String(error?.message || error).slice(0, 300) })));
      }
      const manifestResults = await page.evaluate(data => import('/__verify-page.mjs').then(mod => mod.runManifest(data)), tests.manifest || {}).catch(error => [{ name: 'run agent checks', ok: false, message: String(error?.message || error).slice(0, 600) }]);
      const moduleResults = await page.evaluate(source => import('/__verify-page.mjs').then(mod => mod.runModuleTests(source)), tests.module || '').catch(error => [{ name: 'run test module', ok: false, message: String(error?.message || error).slice(0, 600) }]);
      report.tests.results = [...manifestResults, ...moduleResults].slice(0, 64);
      report.tests.total = report.tests.results.length;
      report.tests.passed = report.tests.results.filter(result => result.ok).length;
      report.tests.failed = report.tests.total - report.tests.passed;
      if (!report.tests.total) {
        report.tests.results.push({ name: 'no agent-authored checks', ok: false, message: 'The engine supplied no declarative checks or test module.' });
        report.tests.total = 1; report.tests.failed = 1;
      }
      // Assertions run against the mounted page, so capture after the interaction matrix.
      await capture(page, '#sandbox-root', 'full page', report);
      for (const id of canvasIds.slice(0, 3)) await capture(page, `#verify-${id}`, `canvas ${id}`, report);
      const blank = report.canvases.filter(canvas => canvas.blank || canvas.error);
      for (const canvas of report.canvases) {
        if (canvas.blank) report.warnings.push(`Canvas ${canvas.id} is blank (${Math.round((canvas.nonBackgroundFraction || 0) * 10000) / 100}% non-background).`);
        if (canvas.error) report.warnings.push(`Canvas ${canvas.id}: ${canvas.error}`);
        if ((canvas.borderInkFraction || 0) > 0.35) report.warnings.push(`Canvas ${canvas.id} draws heavily at its border (${Math.round(canvas.borderInkFraction * 100)}%), which may indicate clipping.`);
        if ((canvas.distinctColors || 0) < 3) report.warnings.push(`Canvas ${canvas.id} has very few colours (${canvas.distinctColors}); the scene may be nearly blank.`);
      }
      report.ok = report.runtimeErrors.length === 0 && report.consoleErrors.length === 0 && report.tests.failed === 0 && blank.length === 0;
      return report;
    })();
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('Verification exceeded its time budget')), timeoutMs));
    work.catch(() => {});
    await Promise.race([work, timer]).catch(error => { report.warnings.push(String(error?.message || error).slice(0, 400)); report.ok = false; });
    report.durationMs = Date.now() - started;
    return { ...report, summary: statusSummary(report) };
  } catch (error) {
    report.warnings.push(`Verification could not run: ${String(error?.message || error).slice(0, 400)}`);
    report.ok = false;
    report.durationMs = Date.now() - started;
    return { ...report, summary: statusSummary(report) };
  } finally {
    report.durationMs = Date.now() - started;
    await browser?.close().catch(() => {});
    await new Promise(resolvePromise => server?.close(resolvePromise) || resolvePromise());
  }
}
