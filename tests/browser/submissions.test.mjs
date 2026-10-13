import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('../../', import.meta.url);
const token = 'browser-test-only-administrator-token-00000000';

test('public authoring and private moderation in a real browser', { timeout: 120_000 }, async t => {
  const storage = mkdtempSync(join(tmpdir(), 'commonlab-submission-browser-'));
  const server = spawn(new URL('target/debug/commonlab', root).pathname, [], {
    cwd: root, env: { ...process.env, BIND_ADDR: '127.0.0.1:0', DATABASE_PATH: join(storage, 'submissions.sqlite3'), ADMIN_TOKEN: token, RUST_LOG: 'commonlab=info', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(server, 'exit'); let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 10_000);
      server.on('error', reject);
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}, ${output}`)); });
      server.stderr.on('data', chunk => { output += chunk; });
      server.stdout.on('data', chunk => {
        output += chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
        const address = /address=(127\.0\.0\.1:\d+)/.exec(output);
        if (address) { clearTimeout(timer); resolve(`http://${address[1]}`); }
      });
    });
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    const author = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const reviewer = await browser.newPage();
    const pageErrors = [];
    for (const page of [author, reviewer]) page.on('pageerror', error => pageErrors.push(error.message));
    const moduleRequests = [];
    for (const page of [author, reviewer]) page.on('request', request => { if (request.url().includes('/simulations/browser-new-lab.js')) moduleRequests.push(request.url()); });
    let receipt;

    await t.test('author composes and previews data without running uploaded code', async () => {
      await author.goto(`${base}/submit.html`);
      await author.waitForFunction(() => !document.getElementById('submission-fields').disabled);
      await author.locator('#engine').selectOption('new');
      await author.locator('#definition-id').fill('browser-new-lab');
      await author.locator('#definition-title').fill('Browser uploaded lab');
      await author.locator('#submitted-by').fill('<img src=x onerror=alert(1)>');
      await author.locator('#add-component').click();
      await author.locator('#add-card').click();
      const def = JSON.parse(await author.locator('#definition-json').inputValue());
      const literal = '<img src=x onerror="window.dataExecuted=true">';
      def.cards[0].paragraphs = [literal];
      def.controls.push({ type: 'text', id: 'code-reviewed', text: 'Draft slot that must not shadow the review checkbox.' });
      await author.locator('#definition-json').fill(JSON.stringify(def));
      const starter = await author.locator('#module-code').inputValue();
      const code = `globalThis.draftExecuted = true;\n// </textarea><img src=x onerror=alert(1)>\n${starter}`
        .replace('this.time = 0;', "this.time = 0; ui.getElementById('slider1').addEventListener('input', () => { ui.getElementById('slider1Value').textContent = ui.getElementById('slider1').value; });")
        .replace('this.time += dt;', "this.time += dt * Number(ui.getElementById('slider1').value);");
      await author.locator('#module-code').fill(code);
      await author.locator('#validate-preview').click();
      await author.waitForFunction(() => document.getElementById('authoring-status').textContent.includes('Definition validated'));
      assert.equal(await author.locator('#definition-preview #author-preview-slider1').count(), 1);
      assert.ok((await author.locator('#definition-preview').innerText()).includes(literal));
      assert.equal(await author.locator('#definition-preview img').count(), 0);
      assert.equal(await author.evaluate(() => window.draftExecuted), undefined);
      assert.equal(await author.evaluate(() => window.dataExecuted), undefined);
      assert.equal(await author.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
      const saved = author.waitForResponse(response => response.url().endsWith('/api/submissions') && response.request().method() === 'POST');
      await author.locator('#submit-draft').click();
      const response = await saved; assert.equal(response.status(), 201); receipt = await response.json();
      await author.waitForFunction(() => document.getElementById('authoring-status').textContent.includes('awaiting review'));
      assert.equal((await author.request.get(`${base}/simulations/browser-new-lab.js`)).status(), 404);
      assert.equal((await author.request.get(`${base}/api/admin/submissions/${receipt.id}`)).status(), 401);
      assert.equal((await author.request.get(`${base}/simulations/catalog.json`)).status(), 200);
      assert.deepEqual(moduleRequests, []);
    });

    await t.test('reviewer authenticates, inspects inert source, then explicitly approves new code', async () => {
      await reviewer.goto(`${base}/review.html`);
      await reviewer.locator('#admin-token').fill('wrong-token');
      await reviewer.locator('#review-login button').click();
      await reviewer.waitForFunction(() => document.getElementById('review-status').textContent.includes('valid administrator'));
      assert.equal(await reviewer.locator('#review-workspace').isVisible(), false);
      await reviewer.locator('#admin-token').fill(token);
      await reviewer.locator('#review-login button').click();
      await reviewer.locator('#review-queue button').filter({ hasText: 'Browser uploaded lab' }).click();
      await reviewer.locator('#review-definition').waitFor();
      assert.ok((await reviewer.locator('#review-module').inputValue()).includes('draftExecuted'));
      assert.ok((await reviewer.locator('#review-meta').innerText()).includes('<img src=x onerror=alert(1)>'));
      assert.equal(await reviewer.locator('#review-detail img').count(), 0);
      await reviewer.locator('#review-preview-button').click();
      assert.equal(await reviewer.locator('#review-preview #review-preview-slider1').count(), 1);
      assert.equal(await reviewer.locator('#code-reviewed').getAttribute('type'), 'checkbox');
      assert.equal(await reviewer.locator('#review-preview-code-reviewed').count(), 1);
      assert.equal(await reviewer.evaluate(() => window.draftExecuted), undefined);
      assert.deepEqual(moduleRequests, []);
      const denied = await reviewer.request.post(`${base}/api/admin/submissions/${receipt.id}/review`, { headers: { Authorization: `Bearer ${token}` }, data: { decision: 'publish', codeReviewed: false } });
      assert.equal(denied.status(), 422);
      await reviewer.locator('#code-reviewed').check();
      await reviewer.locator('#review-note').fill('Test fixture engine and dependencies reviewed.');
      await reviewer.locator('#publish-submission').click();
      await reviewer.waitForFunction(() => document.getElementById('review-status').textContent.includes('now published'));
      assert.equal(await reviewer.evaluate(() => Object.values(localStorage).includes('browser-test-only-administrator-token-00000000')), false);
      assert.equal(await reviewer.locator('#admin-token').inputValue(), '');
      assert.deepEqual(moduleRequests, []);
    });

    await t.test('approved code mounts in the shared shell and withdrawal removes public discovery and routes', async () => {
      const page = await browser.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(base);
      await page.locator('#simulation-catalog a').filter({ hasText: 'Browser uploaded lab' }).click();
      await page.waitForSelector('#simulation-root[data-ready="true"]');
      assert.equal(await page.evaluate(() => window.draftExecuted), true);
      assert.equal(await page.locator('#simulation-root img').count(), 0);
      await page.locator('#slider1').fill('2'); await page.locator('#slider1').dispatchEvent('input');
      assert.equal(await page.locator('#slider1Value').innerText(), '2');
      await reviewer.locator('#queue-status').selectOption('published');
      await reviewer.locator('#review-queue button').filter({ hasText: 'Browser uploaded lab' }).click();
      await reviewer.locator('#review-note').fill('Withdraw test publication.');
      await reviewer.locator('#withdraw-submission').click();
      await reviewer.waitForFunction(() => document.getElementById('review-status').textContent.includes('now withdrawn'));
      assert.equal((await page.request.get(`${base}/simulations/browser-new-lab.js`)).status(), 404);
      assert.equal((await page.request.get(`${base}/simulations/browser-new-lab.html`)).status(), 404);
      await page.goto(base); await page.waitForFunction(() => document.getElementById('catalog-status').hidden);
      assert.equal(await page.locator('#simulation-catalog a').filter({ hasText: 'Browser uploaded lab' }).count(), 0);
      await page.close();
    });

    await t.test('an installed-engine submission publishes without uploading or executing new code', async () => {
      await author.goto(`${base}/submit.html`);
      await author.waitForFunction(() => !document.getElementById('submission-fields').disabled);
      await author.locator('#definition-id').fill('browser-pendulum');
      await author.locator('#definition-title').fill('Browser pendulum lesson');
      await author.locator('#submit-draft').click();
      await author.waitForFunction(() => document.getElementById('authoring-status').textContent.includes('awaiting review'));
      await reviewer.locator('#queue-status').selectOption('pending');
      await reviewer.locator('#review-queue button').filter({ hasText: 'Browser pendulum lesson' }).click();
      assert.equal(await reviewer.locator('#review-module-section').isVisible(), false);
      await reviewer.locator('#publish-submission').click();
      await reviewer.waitForFunction(() => document.getElementById('review-status').textContent.includes('now published'));
      const page = await browser.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(`${base}/simulations/browser-pendulum`);
      await page.waitForSelector('#simulation-root[data-ready="true"]');
      assert.equal(await page.locator('#simulation-title').innerText(), 'Browser pendulum lesson');
      assert.equal(await page.locator('#lesson-launcher button').count() > 0, true);
      assert.equal(await page.locator('#simulation-root .simulation-check button').count() > 0, true);
      await page.close();
      await reviewer.locator('#lock-queue').click();
      assert.equal(await reviewer.locator('#review-workspace').isVisible(), false);
      assert.equal(await reviewer.locator('#review-module').inputValue(), '');
      assert.equal(await reviewer.locator('#review-definition').inputValue(), '');
    });

    await t.test('malformed definitions produce visible errors and offline drafting remains available', async () => {
      await author.goto(`${base}/submit.html`);
      await author.waitForFunction(() => !document.getElementById('submission-fields').disabled);
      await author.locator('#definition-json').fill('{invalid');
      await author.locator('#validate-preview').click();
      assert.ok((await author.locator('#authoring-status').innerText()).includes('could not be parsed'));
      await author.route('**/api/submissions/config', route => route.fulfill({ json: { enabled: false } }));
      await author.reload();
      await author.waitForFunction(() => !document.getElementById('submission-fields').disabled);
      assert.equal(await author.locator('#submit-draft').isDisabled(), true);
      assert.equal(await author.locator('#validate-preview').isDisabled(), false);
      await author.locator('#engine').selectOption('new');
      await author.locator('#component-type').selectOption('actions');
      await author.locator('#add-component').click(); await author.locator('#add-component').click();
      await author.locator('#validate-preview').click();
      assert.ok((await author.locator('#authoring-status').innerText()).includes('Definition validated'));
      assert.equal(await author.locator('#definition-preview .sim-actions button').count(), 2);
    });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
    await exited;
    rmSync(storage, { recursive: true, force: true });
  }
});
