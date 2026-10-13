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
        output += chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
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

    await t.test('Titration keeps instrumentation hidden until requested and resets added volume', async () => {
      const { page, errors } = await pageFor('titration');
      assert.equal(await page.locator('#phReadouts').isVisible(), false);
      await page.locator('#quickAdd [data-value="5.0"]').click(); assert.equal(await page.locator('#volumeAdded').innerText(), '5.00');
      await page.locator('#pHToggle').click(); assert.equal(await page.locator('#phReadouts').isVisible(), true);
      await page.locator('#scenarioPick [data-value="strong-weak"]').click();
      assert.equal(await page.locator('#indicatorPick').inputValue(), 'methylorange');
      await page.locator('#dripUp').click(); await page.locator('#resetBtn').click();
      assert.equal(await page.locator('#volumeAdded').innerText(), '0.00');
      assert.deepEqual(errors, []); await page.close();
    });

    await t.test('Circuit tools and presets, matter substances, and nucleus fallback remain interactive', async () => {
      let result = await pageFor('circuits');
      await result.page.locator('#presetParallel').click();
      assert.ok(Number(await result.page.locator('#current').innerText()) > 0);
      await result.page.locator('#tools [data-value="wire"]').click();
      assert.equal(await result.page.locator('#tools [data-value="wire"]').getAttribute('aria-pressed'), 'true');
      await result.page.locator('#clearBtn').click(); assert.equal(Number(await result.page.locator('#current').innerText()), 0);
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
  } finally {
    await browser?.close(); server.kill('SIGTERM'); await exited;
    rmSync(storage, { recursive: true, force: true });
  }
});
