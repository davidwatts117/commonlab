import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const publicRoot = process.env.CL_PUBLIC_ROOT;
const assets = new Map();
for (const name of [
  'main.css',
  'simulation.css',
  'simulation-ui.mjs',
  'simulation-math.mjs',
  'vendor/temml/temml.mjs',
  'vendor/temml/Temml-Local.css',
  'vendor/temml/Temml.woff2',
  'simulation-schema.mjs',
  'library.js',
])
  assets.set('/' + name, {
    path: `${publicRoot}/${name}`,
    type: { css: 'text/css', woff2: 'font/woff2' }[name.split('.').pop()] || 'text/javascript',
  });
assets.set('/verify-page.mjs', {
  path: fileURLToPath(new URL('./verify-page.mjs', import.meta.url)),
  type: 'text/javascript',
});
const CSP =
  "default-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
const frame = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}"><link rel="stylesheet" href="/main.css"><link rel="stylesheet" href="/simulation.css"></head><body class="paper"><div id="sandbox-root"></div><script src="/library.js"></script><script type="module" src="/verify-page.mjs"></script></body></html>`;
const parent =
  '<!doctype html><html><head><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts" src="/frame" title="Verification"></iframe></body></html>';
const report = {
  ok: false,
  infrastructure: false,
  runtimeErrors: [],
  consoleErrors: [],
  tests: { total: 0, passed: 0, failed: 0, results: [] },
  canvases: [],
  warnings: [],
  screenshots: [],
};
let browser,
  server,
  ready = false;
try {
  let input = '';
  for await (const c of process.stdin) {
    input += c;
    if (Buffer.byteLength(input) > 512 * 1024) throw new Error('Verification input too large');
  }
  let artifact;
  try {
    artifact = JSON.parse(input);
  } catch {
    throw new Error('Invalid verification input');
  }
  // Load all trusted assets before launching. No general filesystem HTTP server.
  for (const a of assets.values()) a.body = await readFile(a.path);
  server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(parent);
      return;
    }
    if (req.url === '/frame') {
      res.setHeader('Content-Type', 'text/html');
      res.end(frame);
      return;
    }
    const a = assets.get(req.url);
    if (!a) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', a.type);
    res.end(a.body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
    ],
    env: { PATH: process.env.PATH, HOME: '/tmp', LANG: 'C.UTF-8' },
  });
  ready = true;
  const add = (list, message) => {
    const value = String(message).slice(0, 350);
    if (!list.includes(value) && list.length < 8) list.push(value);
  };
  const fresh = async (viewport = { width: 1280, height: 900 }) => {
    const ctx = await browser.newContext({
      viewport,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await ctx.route('**/*', (route) => {
      const r = route.request();
      return r.url().startsWith(origin + '/') &&
        r.method() === 'GET' &&
        (r.url() === origin + '/' ||
          r.url() === origin + '/frame' ||
          assets.has(r.url().slice(origin.length)))
        ? route.continue()
        : route.abort();
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on('popup', (p) => p.close());
    page.on('pageerror', (e) => add(report.runtimeErrors, e.message));
    page.on('console', (m) => {
      if (
        m.type() === 'error' &&
        !/net::ERR|font|Content Security Policy|Failed to load resource/i.test(m.text())
      )
        add(report.consoleErrors, m.text());
    });
    await page.goto(origin + '/', { waitUntil: 'load', timeout: 10000 });
    const f = page.frames().find((f) => f.url() === origin + '/frame');
    if (!f) throw new Error('Sandbox frame failed to load');
    await f.evaluate(async (a) => {
      const m = await import('/verify-page.mjs');
      return m.mount(a.definition, a.moduleCode);
    }, artifact);
    return { ctx, page, frame: f };
  };
  const capture = async (p, label, viewport) => {
    if (report.screenshots.length >= 4) return;
    const data = await p.screenshot({ type: 'jpeg', quality: 50, timeout: 5000 });
    if (data.length <= 180 * 1024)
      report.screenshots.push({
        label,
        viewport,
        mimeType: 'image/jpeg',
        data: data.toString('base64'),
      });
    else report.warnings.push(`Screenshot omitted: ${label} exceeded size budget`);
  };
  for (const vp of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const s = await fresh(vp);
    try {
      await capture(s.page, `initial ${vp.width}px`, vp);
      const checks = await s.frame.evaluate(() =>
        import('/verify-page.mjs').then((m) => m.hostChecks()),
      );
      report.tests.results.push(
        ...checks.map((c) => ({ ...c, name: `${vp.width}px ${c.name}`, source: 'host' })),
      );
      for (const canvas of [artifact.definition.canvas, ...artifact.definition.graphs])
        report.canvases.push(
          await s.frame.evaluate(
            (id) => import('/verify-page.mjs').then((m) => m.pixelStats(id)),
            canvas.id,
          ),
        );
      if (vp.width === 1280) {
        await s.frame.evaluate(() => import('/verify-page.mjs').then((m) => m.step(1)));
        await capture(s.page, 'after 1 s fixed stepping', vp);
        await s.frame.evaluate(() => import('/verify-page.mjs').then((m) => m.reset()));
        await capture(s.page, 'reset after interactions', vp);
      }
    } finally {
      await s.ctx.close();
    }
  }
  for (const test of artifact.tests?.manifest?.cases || []) {
    const s = await fresh();
    try {
      report.tests.results.push({
        ...(await s.frame.evaluate(
          (t) => import('/verify-page.mjs').then((m) => m.runCase(t)),
          test,
        )),
        source: 'author',
      });
    } finally {
      await s.ctx.close();
    }
  }
  for (const module of artifact.tests?.modules || [artifact.tests?.module].filter(Boolean)) {
    const s = await fresh();
    try {
      report.tests.results.push({
        ...(await s.frame.evaluate(
          (source) => import('/verify-page.mjs').then((m) => m.runModuleTests(source)),
          module,
        )),
        source: 'author',
      });
    } finally {
      await s.ctx.close();
    }
  }
  if (!report.tests.results.some((r) => r.source === 'author'))
    report.tests.results.push({
      name: 'Agent-authored tests are required',
      ok: false,
      source: 'host',
    });
  if (!report.screenshots.length) throw new Error('No visual evidence captured');
  report.ok =
    report.runtimeErrors.length === 0 &&
    report.consoleErrors.length === 0 &&
    report.tests.results.every((r) => r.ok);
} catch (e) {
  report.ok = false;
  report.infrastructure = !ready;
  report.warnings.push(String(e.message).slice(0, 400));
} finally {
  report.tests.total = report.tests.results.length;
  report.tests.passed = report.tests.results.filter((r) => r.ok).length;
  report.tests.failed = report.tests.total - report.tests.passed;
  process.stdout.write(JSON.stringify(report));
  await browser?.close().catch(() => {});
  server?.closeAllConnections();
  if (server) await new Promise((r) => server.close(r));
}
