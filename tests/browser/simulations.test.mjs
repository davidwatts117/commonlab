import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('../../', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('public/simulations/catalog.json', root), 'utf8'));

async function assertCertificateSections(certificate, definition) {
  const description = certificate.getByRole('region', { name: 'About this simulation', exact: true });
  const participation = certificate.getByRole('region', { name: 'Recorded participation', exact: true });
  assert.equal(await description.getByRole('heading', { level: 3 }).innerText(), 'About this simulation');
  assert.equal(await description.getByRole('heading', { level: 4 }).innerText(), definition.title);
  assert.equal(await description.locator('p').innerText(), definition.summary);
  assert.equal(await description.locator('li').count(), 0);
  assert.equal(await participation.getByRole('heading', { level: 3 }).innerText(), 'Recorded participation');
  assert.equal(await participation.locator('li').count(), await certificate.locator('li').count());
  const descriptionBox = await description.boundingBox();
  const participationBox = await participation.boundingBox();
  assert.ok(participationBox.y >= descriptionBox.y + descriptionBox.height + 16, 'Description and record need visible spacing');
  const divider = await participation.evaluate(el => {
    const style = getComputedStyle(el);
    return { width: parseFloat(style.borderTopWidth), style: style.borderTopStyle, padding: parseFloat(style.paddingTop) };
  });
  assert.ok(divider.width >= 1 && divider.style === 'solid' && divider.padding >= 16, 'Record needs a visible divider, including in print');
}

const stripAnsi = text => text.split(String.fromCharCode(27)).map((part, index) => index === 0 ? part : part.replace(/^\[[0-9;]*m/, '')).join('');
test('shared simulation shell in a real browser', { timeout: 120_000 }, async t => {
  const storage = mkdtempSync(join(tmpdir(), 'commonlab-simulation-browser-'));
  const env = { ...process.env, BIND_ADDR: '127.0.0.1:0', DATABASE_PATH: join(storage, 'submissions.sqlite3'), RUST_LOG: 'commonlab=info', NO_COLOR: '1' };
  delete env.ADMIN_TOKEN;
  const server = spawn(new URL('target/debug/commonlab', root).pathname, [], {
    cwd: root, env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  const exited = once(server, 'exit');
  try {
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 10_000);
      server.on('error', reject);
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}, ${output}`)); });
      server.stderr.on('data', chunk => { output += chunk; });
      server.stdout.on('data', chunk => {
        output += stripAnsi(chunk.toString());
        const address = /address=(127\.0\.0\.1:\d+)/.exec(output);
        if (address) { clearTimeout(timeout); resolve(`http://${address[1]}`); }
      });
    });
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    async function pageFor(id, mobile = false) {
      const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource: net::ERR_FAILED')) errors.push(message.text()); });
      // Deterministic offline fallback for the nuclear-data module.
      await page.route('https://www-nds.iaea.org/**', route => route.abort());
      await page.goto(`${base}/simulations/${id}`);
      await page.waitForSelector('#simulation-root[data-ready="true"]');
      return { page, errors };
    }

    await t.test('homepage cards are populated from the catalog', async () => {
      const page = await browser.newPage(); await page.goto(base);
      await page.waitForSelector('#simulation-catalog .sim-card');
      assert.equal(await page.locator('#simulation-catalog .sim-card').count(), catalog.simulations.length);
      assert.match(await page.locator('#simulation-catalog').innerText(), /guided lesson/i);
      await page.locator('#simulation-catalog .sim-card').first().click();
      await page.waitForSelector('[data-ready="true"]');
      assert.equal(await page.locator('h1').innerText(), 'Pendulum Lab'); await page.close();
    });

    await t.test('all seven modules load without JS errors at desktop and phone sizes', async () => {
      for (const definition of catalog.simulations) for (const mobile of [false, true]) {
        const { page, errors } = await pageFor(definition.id, mobile);
        await page.waitForTimeout(150);
        assert.equal(await page.locator('h1').innerText(), definition.title);
        assert.equal(await page.locator('.simulation-canvas').count(), 1 + definition.graphs.length);
        assert.equal(await page.locator('style').count(), 0);
        assert.equal(await page.locator('.btn-fullscreen').count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${definition.id}: horizontal overflow`);
        assert.deepEqual(errors, [], definition.id); await page.close();
      }
    });

    await t.test('Pendulum controls, persisted assessment, and guided lesson use the same shell', async () => {
      const { page, errors } = await pageFor('pendulum');
      await page.locator('#pauseBtn').click(); assert.equal(await page.locator('#pauseBtn').innerText(), 'Resume');
      await page.locator('#lengthSlider').fill('2'); await page.locator('#lengthSlider').dispatchEvent('input');
      assert.equal(await page.locator('#lengthValue').innerText(), '2.00 m');
      await page.getByRole('button', { name: 'Check Understanding', exact: true }).click();
      await page.locator('.cfu-choice input').first().check();
      await page.getByRole('button', { name: 'Submit answer' }).click();
      assert.equal(await page.locator('.cfu-choice input').first().isDisabled(), true);
      await page.reload(); await page.waitForSelector('[data-ready="true"]');
      await page.getByRole('button', { name: 'Check Understanding', exact: true }).click();
      assert.equal(await page.locator('.cfu-choice input').first().isDisabled(), true);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.locator('.guided-launcher__toggle').click(); await page.locator('.guided-card-btn').click();
      assert.equal(await page.locator('.guided-modal-wrap').isVisible(), true);
      await page.locator('[data-exit]').click();
      assert.equal(await page.locator('#lengthSlider').isDisabled(), false);
      assert.deepEqual(errors, []); await page.close();
    });

    await t.test('certificates distinguish guided participation and completed checks without sending or storing names', async () => {
      const { page, errors } = await pageFor('pendulum');
      const name = '<img src=x onerror=alert(1)> Student';
      const sent = [];
      page.on('request', request => sent.push(request.url() + (request.postData() || '')));
      const certificate = page.locator('.completion-certificate');
      const create = page.getByRole('button', { name: 'Create completion certificate', exact: true });
      await page.getByLabel('Your name', { exact: true }).fill('   ');
      await create.click(); assert.equal(await certificate.isVisible(), false);
      await page.getByLabel('Your name', { exact: true }).fill(name);
      await create.click();
      assert.equal(await certificate.locator('.certificate-name').innerText(), name);
      assert.equal(await certificate.locator('img').count(), 0);
      assert.doesNotMatch(await certificate.innerText(), /Guided experiment|Check Understanding/);
      assert.match(await certificate.innerText(), /Simulation exploration: not recorded/);
      await assertCertificateSections(certificate, catalog.simulations.find(sim => sim.id === 'pendulum'));
      // Physics engines dispatch synthetic input events when applying presets/lesson state.
      await page.locator('#lengthSlider').dispatchEvent('input');
      await create.click();
      assert.match(await certificate.innerText(), /Simulation exploration: not recorded/);
      await page.locator('#lengthSlider').focus(); await page.keyboard.press('ArrowRight');
      await create.click();
      assert.match(await certificate.innerText(), /Simulation exploration: time spent:/);
      await page.locator('.guided-launcher__toggle').click(); await page.locator('.guided-card-btn').click();
      await page.locator('[data-exit]').click();
      await create.click();
      assert.match(await certificate.innerText(), /Guided experiment started \(not completed\): What controls a pendulum/);
      await page.locator('.guided-launcher__toggle').click(); await page.locator('.guided-card-btn').click();
      // Deliberate Skip is supported by the lesson; completion is participation, not mastery.
      for (let i = 0; i < catalog.simulations[0].lessons[0].steps.length; i++) await page.locator('[data-skip]').click();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByRole('button', { name: 'Check Understanding', exact: true }).click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await create.click();
      assert.match(await certificate.innerText(), /Guided experiment completed: What controls a pendulum/);
      assert.match(await certificate.innerText(), /Check Understanding in progress/);
      await page.getByRole('button', { name: 'Check Understanding', exact: true }).click();
      const questions = catalog.simulations[0].assessment.questions.filter(q => ['assessment', 'both'].includes(q.use));
      for (let i = 0; i < questions.length; i++) {
        await page.locator('.cfu-choice input').first().check();
        await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
        await page.getByRole('button', { name: i === questions.length - 1 ? 'See results' : 'Continue', exact: true }).click();
      }
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await create.click();
      assert.match(await certificate.innerText(), /Check Understanding completed \(latest local result\)/);
      assert.doesNotMatch(await certificate.innerText(), /in progress/);
      assert.equal(await certificate.locator('li').count(), 3);
      await page.evaluate(() => { window.print = () => { window.certificatePrinted = true; }; });
      await page.getByRole('button', { name: 'Print / save as PDF', exact: true }).click();
      assert.equal(await page.evaluate(() => window.certificatePrinted), true);
      await page.emulateMedia({ media: 'print' });
      assert.equal(await certificate.isVisible(), true);
      assert.equal(await page.locator('.certificate-form').isVisible(), false);
      assert.equal(await page.locator('.sim-canvas-area').isVisible(), false);
      assert.equal(await page.locator('.site-header').isVisible(), false);
      await assertCertificateSections(certificate, catalog.simulations.find(sim => sim.id === 'pendulum'));
      const pdf = await page.pdf({ format: 'A4' });
      // Chromium writes one /Type /Page object per page; catch trailing blank pages.
      assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1);
      assert.equal(sent.some(request => request.includes(name) || request.includes(encodeURIComponent(name))), false);
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
      assert.equal(stored.includes(name), false);
      await page.emulateMedia({ media: 'screen' });
      await page.reload(); await page.waitForSelector('[data-ready="true"]');
      assert.equal(await certificate.isVisible(), false);
      assert.equal(await page.getByLabel('Your name', { exact: true }).inputValue(), '');
      await page.locator('.guided-launcher__toggle').click(); await page.locator('.guided-card-btn').click();
      await page.locator('[data-exit]').click();
      await page.getByRole('button', { name: 'Check Understanding', exact: true }).click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByLabel('Your name', { exact: true }).fill('Student'); await create.click();
      assert.match(await certificate.innerText(), /Simulation exploration: not recorded/);
      assert.deepEqual(errors, []); await page.close();
    });

    await t.test('mobile simulations without learning activities offer free-exploration certificates', async () => {
      const { page, errors } = await pageFor('gas-laws', true);
      await page.locator('.simulation-canvas').first().click();
      await page.getByLabel('Your name', { exact: true }).fill('A'.repeat(100));
      await page.getByRole('button', { name: 'Create completion certificate', exact: true }).click();
      const certificate = page.locator('.completion-certificate');
      assert.match(await certificate.innerText(), /Gas Laws/);
      assert.match(await certificate.innerText(), /Simulation exploration: time spent:/);
      assert.equal(await certificate.locator('li').count(), 1);
      await assertCertificateSections(certificate, catalog.simulations.find(sim => sim.id === 'gas-laws'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []); await page.close();
    });

    await t.test('Gas controls and accessible information dialog work', async () => {
      const { page, errors } = await pageFor('gas-laws');
      const before = await page.locator('#pressureDisplay').innerText();
      await page.locator('#volumeSlider').fill('2.5'); await page.locator('#volumeSlider').dispatchEvent('input');
      assert.ok(Number(await page.locator('#pressureDisplay').innerText()) > Number(before));
      await page.getByRole('button', { name: "About Boyle's Law" }).click();
      assert.equal(await page.locator('dialog').isVisible(), true);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog').isVisible(), false);
      assert.deepEqual(errors, []); await page.close();
    });

    await t.test('Pendulum damping and force vectors are declared controls', async () => {
      const { page, errors } = await pageFor('pendulum');
      await page.locator('#dampingSlider').fill('0.25'); await page.locator('#dampingSlider').dispatchEvent('input');
      assert.equal(await page.locator('#dampingValue').innerText(), '0.25 s⁻¹');
      await page.locator('#forcesBtn').click(); assert.equal(await page.locator('#forcesBtn').innerText(), 'Hide Forces');
      assert.equal(await page.locator('#angleGraphCanvas').isVisible(), true);
      assert.deepEqual(errors, []); await page.close();
    });

    await t.test('Titration bench: held tap, auto-recorded log, real-lab mode and reset', async () => {
      const { page, errors } = await pageFor('titration');
      await page.waitForFunction(() => document.getElementById('buretteReadout').textContent !== '--');
      const start = Number(await page.locator('#buretteReadout').innerText());
      assert.ok(start <= 0.6);
      assert.equal(await page.locator('#dataBody tr').count(), 0);
      assert.equal(await page.locator('#dataHint').isVisible(), true);
      await page.locator('#showDataPts').check();
      const tap = page.locator('#titrateBtn'); const box = await tap.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.waitForTimeout(700);
      assert.equal(await tap.innerText(), 'Release to stop');
      await page.mouse.up();
      assert.ok(Number(await page.locator('#buretteReadout').innerText()) > start);
      assert.equal(await page.locator('#dataBody tr').count(), 1);
      assert.equal(await page.locator('#dataHint').isVisible(), false);
      assert.equal(await page.locator('#logThirdHead').innerText(), 'PH');
      await page.locator('#realLab').check();
      assert.equal(await page.locator('#phReadout').isVisible(), false);
      assert.equal(await page.locator('#showEqPt').isVisible(), false);
      assert.equal(await page.locator('#dockSwatch').isVisible(), true);
      assert.equal(await page.locator('#dockPHLabel').innerText(), 'COLOUR');
      assert.equal(await page.locator('#dataBody .simulation-swatch').count(), 1);
      await page.locator('#realLab').uncheck(); assert.equal(await page.locator('#phReadout').isVisible(), true);
      // Reset refills the burette to a fresh random zero reading (0.00–0.60 mL); with auto-record
      // on, the new log starts with that starting reading as its only row.
      await page.locator('#resetBtn').click();
      await page.waitForFunction(() => Number(document.getElementById('buretteReadout').textContent) <= 0.6);
      assert.equal(await page.locator('#dataBody tr').count(), 1);
      assert.equal(await page.locator('#dataBody tr td').nth(1).innerText(), await page.locator('#buretteReadout').innerText());
      await page.locator('#acidSelect').selectOption('Acetic acid'); await page.locator('#baseSelect').selectOption('Ammonia');
      assert.equal(await tap.isDisabled(), true);
      assert.equal(await page.locator('#titrMessage').getAttribute('data-tone'), 'warn');
      await page.locator('#titrantPick [data-value="acid"]').click();
      assert.equal(await page.locator('#titrantPick [data-value="acid"]').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(errors, []); await page.close();
    });

    await t.test('Circuit tools and presets, matter substances, and nucleus fallback remain interactive', async () => {
      let result = await pageFor('circuits');
      await result.page.locator('#presetParallel').click();
      await result.page.waitForFunction(() => Number(document.getElementById('current').textContent) > 0);
      assert.equal(await result.page.locator('#selRange').isVisible(), false);
      assert.match(await result.page.locator('#selectedPanel').innerText(), /Select a part/);
      await result.page.locator('#tools [data-value="wire"]').click();
      assert.equal(await result.page.locator('#tools [data-value="wire"]').getAttribute('aria-pressed'), 'true');
      await result.page.locator('#showValues').check();
      await result.page.locator('#clearBtn').click();
      await result.page.waitForFunction(() => Number(document.getElementById('current').textContent) === 0);
      assert.equal(await result.page.locator('#tools [data-value="select"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await result.page.locator('#warning').isVisible(), false);
      assert.deepEqual(result.errors, []); await result.page.close();
      result = await pageFor('states-of-matter');
      await result.page.locator('#substancePick [data-value="neon"]').click();
      assert.equal(await result.page.locator('#mpVal').innerText(), '17 K');
      await result.page.locator('#heatSlider').evaluate(el => { el.value = '100'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await result.page.waitForTimeout(100); assert.match(await result.page.locator('#heatLabel').innerText(), /Heating/);
      await result.page.locator('#btnReset').click(); assert.equal(await result.page.locator('#heatSlider').inputValue(), '0');
      assert.deepEqual(result.errors, []); await result.page.close();
      result = await pageFor('build-a-nucleus');
      await result.page.waitForFunction(() => !document.getElementById('btnNeutronPlus').disabled);
      await result.page.locator('#btnNeutronPlus').click(); assert.equal(await result.page.locator('#neutronCount').innerText(), '7');
      assert.equal(await result.page.locator('#buildTabs').isVisible(), false);
      assert.match(await result.page.locator('#chartLegend').innerText(), /Stable/);
      await result.page.locator('#chartModePick [data-value="decay"]').click();
      assert.match(await result.page.locator('#chartLegend').innerText(), /decay/);
      assert.deepEqual(result.errors, []); await result.page.close();
    });

    await t.test('Projectile launch, zoom, and data-driven questions remain usable', async () => {
      const { page, errors } = await pageFor('projectile');
      await page.locator('#zoomInBtn').click(); assert.equal(await page.locator('#zoomDisplay').innerText(), '1.30x');
      await page.locator('#launchBtn').click();
      await page.waitForFunction(() => document.getElementById('statTime').textContent !== '--');
      assert.ok(Number(await page.locator('#statTime').innerText()) > 0);
      await page.locator('#clearBtn').click(); assert.equal(await page.locator('#statTime').innerText(), '--');
      await page.getByRole('button', { name: 'Check Understanding', exact: true }).click();
      assert.equal(await page.locator('.cfu-choice').count(), 4);
      assert.deepEqual(errors, []); await page.close();
    });

    await t.test('old bookmarks use the shell; unknown and broken definitions fail visibly', async () => {
      const page = await browser.newPage();
      assert.equal((await page.goto(`${base}/simulations/pendulum.html`)).status(), 200);
      await page.waitForSelector('[data-ready="true"]');
      assert.equal((await page.request.get(`${base}/simulations/missing.html`)).status(), 404);
      await page.route('**/simulations/catalog.json', route => route.fulfill({ contentType: 'application/json', body: '{"schemaVersion":999,"simulations":[]}' }));
      await page.goto(`${base}/simulation.html?id=pendulum`);
      await page.waitForSelector('#simulation-status[role="alert"]');
      assert.match(await page.locator('#simulation-status').innerText(), /schema version/); await page.close();
    });
    await t.test('long slider labels and info links stay inside a narrow controls column', async () => {
      const definition = {
        id: 'narrow-controls', title: 'Long labels', subject: 'physics', summary: 'Checks the shared controls column at every width.',
        canvas: { id: 'scene', label: 'Scene', width: 700, height: 440 },
        controls: [{
          type: 'slider', id: 'eSlider', label: 'Coefficient of restitution for two unequal blocks e', min: 0, max: 1, step: 0.05, value: 1,
          output: { id: 'eValue', text: '1.00' }, info: 'restitution',
        }], cards: [], graphs: [], lessons: [],
        info: { restitution: { title: 'Coefficient of restitution', formula: 'e = |v2\' - v1\'| / |v1 - v2|', explanation: 'Relative separation over approach speed.', detail: 'Values near one are bouncy.' } },
      };
      for (const width of [1280, 900, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.route('**/simulations/catalog.json', route => route.fulfill({ json: { schemaVersion: 1, simulations: [definition] } }));
        await page.route('**/simulations/narrow-controls.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export function mount(ui) { return { app: { sim: { start(){}, stop(){} } } }; }' }));
        await page.goto(`${base}/simulation.html?id=narrow-controls`);
        await page.waitForSelector('#simulation-root[data-ready="true"]');
        const layout = await page.evaluate(() => {
          const panel = document.querySelector('.controls-panel').getBoundingClientRect();
          const info = document.querySelector('.simulation-info').getBoundingClientRect();
          const row = document.querySelector('.control-row');
          return { page: document.documentElement.scrollWidth, inner: innerWidth, panel: panel.right, info: info.right,
            rowOverflow: row.scrollWidth - row.clientWidth, label: document.querySelector('.control-label').getBoundingClientRect().right };
        });
        assert.ok(layout.page <= layout.inner + 2, `Page overflows at ${width}px`);
        assert.ok(layout.info <= layout.panel + 1 && layout.label <= layout.panel + 1, `Controls overflow their panel at ${width}px`);
        assert.ok(layout.rowOverflow <= 1, `Control row overflows at ${width}px`);
        assert.equal(await page.getByRole('button', { name: 'About Coefficient of restitution', exact: true }).count(), 1);
        assert.deepEqual(errors, []); await page.close();
      }
    });
  } finally {
    await browser?.close(); server.kill('SIGTERM'); await exited;
    rmSync(storage, { recursive: true, force: true });
  }
});
