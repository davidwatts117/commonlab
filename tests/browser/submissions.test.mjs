import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('../../', import.meta.url);
const token = 'browser-test-only-administrator-token-00000000';
const workerToken = 'browser-test-only-worker-token-00000000000';

test('public authoring and private moderation in a real browser', { timeout: 120_000 }, async t => {
  const storage = mkdtempSync(join(tmpdir(), 'commonlab-submission-browser-'));
  const server = spawn(new URL('target/debug/commonlab', root).pathname, [], {
    cwd: root, env: { ...process.env, BIND_ADDR: '127.0.0.1:0', DATABASE_PATH: join(storage, 'submissions.sqlite3'), ADMIN_TOKEN: token, GENERATION_WORKER_TOKEN: workerToken, RUST_LOG: 'commonlab=info', NO_COLOR: '1' },
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

    await t.test('contributor registration, logout and login use private cookie sessions', async () => {
      await author.goto(`${base}/account.html`);
      await author.locator('#account-action').selectOption('register');
      await author.locator('#account-username').fill('browser-author');
      await author.locator('#account-password').fill('test-only-browser-password');
      await author.locator('#account-confirm').fill('test-only-browser-password');
      await author.locator('#account-submit').click();
      await author.locator('#account-signed-in').waitFor();
      assert.ok((await author.locator('#account-name').innerText()).includes('browser-author'));
      assert.equal(await author.evaluate(() => document.cookie.includes('cl_session')), false);
      assert.equal((await author.context().cookies()).some(cookie => cookie.name === 'cl_session' && cookie.httpOnly && cookie.sameSite === 'Strict'), true);
      await author.locator('#account-logout').click(); await author.locator('#account-form').waitFor();
      await author.locator('#account-action').selectOption('login');
      await author.locator('#account-password').fill('test-only-browser-password');
      await author.locator('#account-submit').click(); await author.locator('#account-signed-in').waitFor();
    });

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

    await t.test('owners reload inert saved source and save revisions without creating duplicate submissions', async () => {
      await author.goto(`${base}/submit.html?edit=${receipt.id}`);
      await author.waitForFunction(() => !document.getElementById('submission-fields').disabled);
      assert.equal(await author.locator('#definition-id').getAttribute('readonly'), '');
      assert.ok((await author.locator('#module-code').inputValue()).includes('draftExecuted'));
      assert.equal(await author.evaluate(() => window.draftExecuted), undefined);
      await author.locator('#definition-title').fill('Owner revised lab');
      const saved = author.waitForResponse(response => response.request().method() === 'PUT');
      await author.locator('#submit-draft').click();
      assert.equal((await saved).status(), 200);
      await author.waitForFunction(() => document.getElementById('authoring-status').textContent.includes('resubmitted for review'));
      await author.reload();
      await author.waitForFunction(() => !document.getElementById('submission-fields').disabled);
      assert.equal(await author.locator('#definition-title').inputValue(), 'Owner revised lab');
      assert.equal(await author.evaluate(() => window.draftExecuted), undefined);
      assert.equal((await reviewer.request.get(`${base}/api/contributor/submissions/${receipt.id}`)).status(), 401);
    });

    await t.test('dashboard tracks private status, literal feedback, history and signed-out privacy', async () => {
      const rejected = await reviewer.request.post(`${base}/api/admin/submissions/${receipt.id}/review`, { headers: { Authorization: `Bearer ${token}` }, data: { revision: 2, decision: 'reject', note: '<img src=x onerror="window.noteExecuted=true"> Please revise the explanation.' } });
      assert.equal(rejected.status(), 200);
      await author.goto(`${base}/contributions.html`);
      await author.locator('#contributions-workspace').waitFor();
      await author.locator('#contributions-filter').selectOption('rejected');
      await author.locator('#contributions-list button').filter({ hasText: 'Owner revised lab' }).click();
      await author.waitForFunction(() => document.getElementById('contribution-history').textContent.includes('reject'));
      assert.ok((await author.locator('#contribution-feedback').innerText()).includes('<img'));
      assert.ok((await author.locator('#contribution-history').innerText()).includes('edited'));
      assert.equal(await author.locator('#contribution-detail img').count(), 0);
      assert.equal(await author.evaluate(() => window.noteExecuted), undefined);
      assert.equal(await author.locator('#contribution-edit').getAttribute('href'), `/submit.html?edit=${receipt.id}`);
      assert.equal(await author.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
      await author.request.post(`${base}/api/auth/logout`, { headers: { 'X-CommonLab-Request': '1' } });
      await author.reload(); await author.locator('#contributions-login').waitFor();
      assert.equal(await author.locator('#contributions-list button').count(), 0);
      assert.equal(await author.locator('#contribution-feedback').innerText(), '');
      const login = await author.request.post(`${base}/api/auth/login`, { headers: { 'X-CommonLab-Request': '1' }, data: { username: 'browser-author', password: 'test-only-browser-password' } });
      assert.equal(login.status(), 200);
    });

    await t.test('approved accounts generate private inert drafts and explicitly submit them for human review', async () => {
      await author.goto(`${base}/generate.html`);
      await author.waitForFunction(() => document.getElementById('generation-status').textContent.includes('grant your account'));
      assert.equal(await author.locator('#generation-fields').evaluate(element => element.disabled), true);
      await reviewer.goto(`${base}/review.html`);
      await reviewer.locator('#admin-token').fill(token); await reviewer.locator('#review-login button').click();
      await reviewer.locator('#review-workspace').waitFor();
      await reviewer.getByText('Manage AI generation access', { exact: true }).click();
      await reviewer.locator('#generation-username').fill('browser-author');
      await reviewer.locator('#generation-access-form button').click();
      await reviewer.waitForFunction(() => document.getElementById('review-status').textContent.includes('granted to'));
      await author.locator('#generation-refresh').click();
      await author.waitForFunction(() => !document.getElementById('generation-fields').disabled);
      await author.locator('#generation-prompt').fill('A spring lab with mass and stiffness controls.');
      await author.locator('#generation-consent').check();
      await author.locator('#generation-form button').click();
      await author.waitForFunction(() => document.getElementById('generation-jobs').textContent.includes('queued'));
      const claimed = await reviewer.request.post(`${base}/api/worker/generation/claim`, { headers: { Authorization: `Bearer ${workerToken}` } });
      assert.equal(claimed.status(), 200); const job = await claimed.json();
      const definition = { id: job.simulationId, title: 'AI spring draft', subject: 'physics', summary: 'A private generated draft.', canvas: { id: 'scene', label: 'Spring scene', width: 640, height: 400 }, controls: [], cards: [], graphs: [], lessons: [] };
      const moduleCode = 'export function mount(ui) { globalThis.generatedExecuted = true; return { app: {} }; }';
      const completed = await reviewer.request.post(`${base}/api/worker/generation/${job.id}/complete`, { headers: { Authorization: `Bearer ${workerToken}` }, data: { lease: job.lease, model: 'scripted/test-no-paid-call', artifact: { definition, moduleCode } } });
      assert.equal(completed.status(), 200);
      await author.locator('#generation-refresh').click();
      await author.getByRole('link', { name: 'Open private draft in editor' }).click();
      await author.waitForFunction(() => !document.getElementById('submission-fields').disabled);
      assert.equal(await author.locator('#definition-title').inputValue(), 'AI spring draft');
      assert.equal(await author.locator('#module-code').inputValue(), moduleCode);
      assert.equal(await author.evaluate(() => window.generatedExecuted), undefined);
      await author.locator('#validate-preview').click();
      assert.equal(await author.evaluate(() => window.generatedExecuted), undefined);
      assert.equal((await author.request.get(`${base}/simulations/${job.simulationId}.js`)).status(), 404);
      const submitted = author.waitForResponse(response => response.url().endsWith('/api/submissions') && response.request().method() === 'POST');
      await author.locator('#submit-draft').click(); assert.equal((await submitted).status(), 201);
      assert.equal((await author.request.get(`${base}/simulations/${job.simulationId}.js`)).status(), 404);
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
    await t.test('visual content editing and complete bundle restoration work without executing source', async () => {
      await author.reload();
      await author.waitForFunction(() => !document.getElementById('submission-fields').disabled);
      await author.locator('#engine').selectOption('new');
      await author.locator('#definition-id').fill('structured-lab');
      await author.locator('#definition-title').fill('My editable lab');
      await author.locator('#submitted-by').fill('Offline author');
      await author.locator('#add-card').click();
      const card = author.locator('[data-editor-type="card"]').first();
      await card.getByLabel('Card title', { exact: true }).fill('A relationship');
      await card.getByLabel('Formulas (one per line)', { exact: true }).fill('F = ma\na = F/m');
      const literal = '<img src=x onerror="window.contentRan=true">';
      await card.getByLabel('Explanations (one paragraph per line)', { exact: true }).fill(`First explanation.\n${literal}`);
      await author.getByRole('button', { name: 'Add question bank', exact: true }).click();
      const question = author.locator('[data-editor-type="question"]').first();
      // Incomplete edits must be recoverable without returning to raw JSON.
      await question.getByLabel('Question prompt', { exact: true }).fill('');
      await question.getByLabel('Question ID', { exact: true }).fill('q');
      await question.getByLabel('Question ID', { exact: true }).fill('relationship');
      await question.getByLabel('Question prompt', { exact: true }).fill('Which relationship is correct?');
      const answer = question.locator('[data-editor-type="choice"]').first();
      await answer.getByLabel('Answer ID', { exact: true }).fill('a');
      await answer.getByLabel('Answer ID', { exact: true }).fill('proportional');
      await answer.getByLabel('Answer ID', { exact: true }).fill('option-2');
      assert.equal(await answer.getByLabel('Answer ID', { exact: true }).inputValue(), 'proportional');
      await answer.getByLabel('Answer label', { exact: true }).fill('Force is proportional to acceleration.');
      await question.getByLabel('Answer type', { exact: true }).focus();
      await question.getByLabel('Answer type', { exact: true }).selectOption('multi');
      assert.equal(await author.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Answer type');
      await question.getByRole('checkbox', { name: 'Correct answer', exact: true }).nth(1).check();
      let def = JSON.parse(await author.locator('#definition-json').inputValue());
      assert.deepEqual(def.assessment.questions[0].correct, ['proportional', 'option-2']);
      await question.getByLabel('Answer type', { exact: true }).selectOption('single');
      await author.getByRole('button', { name: 'Add question', exact: true }).click();
      def = JSON.parse(await author.locator('#definition-json').inputValue());
      assert.deepEqual(def.assessment.questions[0].correct, ['proportional']);
      assert.equal(def.assessment.questions.length, 2);
      assert.deepEqual(def.cards[0].formulas, ['F = ma', 'a = F/m']);
      const code = `globalThis.bundleRestoreRan = true;\n${await author.locator('#module-code').inputValue()}`;
      await author.locator('#module-code').fill(code);
      const downloadEvent = author.waitForEvent('download');
      await author.locator('#export-bundle').click();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), 'structured-lab.submission.json');
      const text = readFileSync(await download.path(), 'utf8');
      const bundle = JSON.parse(text);
      assert.equal(bundle.source.moduleCode, code); assert.deepEqual(bundle.definition, def);
      await author.locator('#engine').selectOption('pendulum');
      await author.locator('#bundle-file').setInputFiles({ name: 'restored.submission.json', mimeType: 'application/json', buffer: Buffer.from(text) });
      await author.waitForFunction(() => document.getElementById('authoring-status').textContent.includes('Complete submission restored'));
      assert.equal(await author.locator('#engine').inputValue(), 'new');
      assert.equal(await author.locator('#module-code').inputValue(), code);
      assert.equal(await author.locator('#submitted-by').inputValue(), 'Offline author');
      assert.equal(await author.locator('[data-editor-type="question"]').count(), 2);
      await author.locator('#validate-preview').click();
      assert.ok((await author.locator('#authoring-status').innerText()).includes('Definition validated'));
      assert.ok((await author.locator('#definition-preview').innerText()).includes(literal));
      assert.equal(await author.locator('#definition-preview img').count(), 0);
      assert.equal(await author.evaluate(() => window.bundleRestoreRan), undefined);
      assert.equal(await author.evaluate(() => window.contentRan), undefined);
      assert.equal(await author.evaluate(() => Object.values(localStorage).some(value => value.includes('bundleRestoreRan'))), false);
      assert.equal(await author.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
      // Unknown engines fail visibly and leave the existing draft intact.
      bundle.source = { kind: 'installed', engineId: 'not-installed' };
      await author.locator('#bundle-file').setInputFiles({ name: 'bad.submission.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
      await author.waitForFunction(() => document.getElementById('authoring-status').textContent.includes('unavailable installed engine'));
      assert.equal(await author.locator('#definition-title').inputValue(), 'My editable lab');
      // Pretty-printing/whitespace is not part of the compact server definition budget.
      await author.locator('#definition-file').setInputFiles({ name: 'padded.json', mimeType: 'application/json', buffer: Buffer.from(' '.repeat(65 * 1024) + JSON.stringify(def)) });
      await author.waitForFunction(() => document.getElementById('authoring-status').textContent.includes('Definition imported'));
      assert.equal(JSON.parse(await author.locator('#definition-json').inputValue()).id, 'structured-lab');
      // The visually authored bank must also work in the actual published learning UI.
      const submitted = await author.request.post(`${base}/api/submissions`, { headers: { 'X-CommonLab-Request': '1' }, data: { definition: def, moduleCode: code, submittedBy: 'Offline author' } });
      assert.equal(submitted.status(), 201);
      const receipt = await submitted.json();
      const approved = await reviewer.request.post(`${base}/api/admin/submissions/${receipt.id}/review`, { headers: { Authorization: `Bearer ${token}` }, data: { decision: 'publish', revision: receipt.revision, codeReviewed: true } });
      assert.equal(approved.status(), 200);
      const learner = await browser.newPage(); learner.on('pageerror', error => pageErrors.push(error.message));
      await learner.goto(`${base}/simulations/structured-lab`);
      await learner.waitForSelector('#simulation-root[data-ready="true"]');
      await learner.getByRole('button', { name: 'Check Understanding', exact: true }).click();
      assert.equal(await learner.getByText('Which relationship is correct?', { exact: true }).count(), 1);
      assert.ok((await learner.locator('.cfu-choice').first().innerText()).includes('Force is proportional to acceleration.'));
      await learner.locator('.cfu-choice input').first().check();
      await learner.getByRole('button', { name: 'Submit answer' }).click();
      assert.equal(await learner.locator('.cfu-choice input').first().isDisabled(), true);
      await learner.reload(); await learner.waitForSelector('#simulation-root[data-ready="true"]');
      await learner.getByRole('button', { name: 'Check Understanding', exact: true }).click();
      assert.equal(await learner.locator('.cfu-choice input').first().isChecked(), true);
      assert.equal(await learner.locator('.cfu-choice input').first().isDisabled(), true);
      await learner.close();
    });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
    await exited;
    rmSync(storage, { recursive: true, force: true });
  }
});
