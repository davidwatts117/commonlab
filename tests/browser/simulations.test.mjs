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

    await t.test('wide workspaces bring graphs and explanations alongside without narrow-screen overflow', async () => {
      for (const { id } of catalog.simulations) {
        const { page, errors } = await pageFor(id);
        for (const width of [390, 900, 1279, 1280, 1440, 1799, 1800, 1920, 2199, 2200, 2560]) {
          await page.setViewportSize({ width, height: 900 });
          const boxes = await page.evaluate(() => {
            const rect = selector => {
              const el = document.querySelector(selector);
              if (!el || !el.getClientRects().length) return null;
              const { x, y, right, bottom, width, height } = el.getBoundingClientRect();
              return { x, y, right, bottom, width, height };
            };
            return {
              scene: rect('.canvas-wrapper'), graphs: rect('.simulation-graphs'),
              controls: rect('.sim-main > .controls-panel'), main: rect('.sim-main'),
              sidebar: rect('.sim-sidebar'), root: rect('#simulation-root'), dock: rect('.simulation-dock'),
              cardColumns: getComputedStyle(document.querySelector('.sim-sidebar')).gridTemplateColumns.split(' ').length,
              overflow: document.documentElement.scrollWidth - innerWidth,
              canvases: [...document.querySelectorAll('.simulation-canvas')].map(canvas => ({
                width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height,
                ratio: Number(canvas.style.aspectRatio.split('/')[0]) / Number(canvas.style.aspectRatio.split('/')[1]),
              })),
            };
          });
          const context = `${id} at ${width}px`;
          assert.ok(boxes.overflow <= 1, `${context}: horizontal overflow`);
          for (const canvas of boxes.canvases) {
            assert.ok(canvas.width > 0 && canvas.height > 0, `${context}: invisible canvas`);
            assert.ok(Math.abs(canvas.width / canvas.height - canvas.ratio) < 0.02, `${context}: distorted canvas`);
          }
          if (width >= 1280) {
            assert.ok(boxes.controls.x >= boxes.scene.right, `${context}: controls not beside scene`);
            assert.ok(Math.abs(boxes.controls.width - 420) < 1, `${context}: unreadable controls width`);
            if (boxes.graphs) {
              assert.ok(boxes.graphs.x >= boxes.scene.right, `${context}: graphs not beside scene`);
              assert.ok(Math.abs(boxes.graphs.y - boxes.scene.y) < 1, `${context}: graphs start below scene`);
              assert.ok(boxes.graphs.right <= boxes.controls.x, `${context}: graphs overlap controls`);
            }
          } else if (boxes.graphs) {
            assert.ok(boxes.graphs.y >= boxes.scene.bottom, `${context}: narrow graphs must stack`);
          }
          if (width >= 1800 && boxes.sidebar) {
            assert.ok(boxes.sidebar.x >= boxes.main.right, `${context}: explanations not beside workspace`);
            assert.ok(Math.abs(boxes.sidebar.y - boxes.scene.y) < 1, `${context}: explanations start below workspace`);
            assert.equal(boxes.cardColumns, width >= 2200 ? 2 : 1, `${context}: reference columns waste available space`);
          } else if (boxes.sidebar) {
            assert.ok(boxes.sidebar.y >= boxes.main.bottom, `${context}: explanations overlap workspace`);
          }
          if (boxes.dock) {
            // The sticky dock intentionally overlays the scene while scrolling,
            // but its layout row must span the workspace rather than squeeze it.
            assert.ok(Math.abs(boxes.dock.width - boxes.main.width) < 1, `${context}: dock does not span workspace`);
            assert.ok(boxes.dock.right <= boxes.root.right, `${context}: dock escapes workspace`);
          }
          if (width >= 1440) assert.ok(boxes.root.width > 1280, `${context}: workspace still capped`);
        }
        if (id === 'pendulum') {
          await page.locator('#pauseBtn').click();
          await page.locator('#lengthSlider').fill('2');
          assert.equal(await page.locator('#lengthValue').innerText(), '2.00 m');
          await page.getByRole('button', { name: 'Check Understanding', exact: true }).click();
          assert.equal(await page.locator('.cfu-choice').first().isVisible(), true);
        }
        assert.deepEqual(errors, [], id); await page.close();
      }
    });

    await t.test('fullscreen keeps graphs, controls and view tabs usable after wide layout', async () => {
      for (const id of ['pendulum', 'build-a-nucleus']) {
        const { page, errors } = await pageFor(id);
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.getByRole('button', { name: 'Fullscreen simulation', exact: true }).click();
        await page.waitForFunction(() => document.fullscreenElement?.id === 'simulation-root' && document.fullscreenElement.classList.contains('fs-active'));
        assert.equal(await page.locator('.controls-panel').isVisible(), true);
        assert.equal(await page.locator('.sim-sidebar').isVisible(), false);
        assert.equal(await page.locator('.simulation-canvas').first().isVisible(), true);
        assert.equal(await page.locator('.sim-stage').evaluate(el => getComputedStyle(el).display), 'flex');
        if (id === 'build-a-nucleus') {
          await page.getByRole('tab').nth(1).click();
          assert.equal(await page.locator('#chartCanvas').isVisible(), true);
          assert.equal(await page.locator('#nucleusCanvas').isVisible(), false);
          await page.getByRole('tab').first().click();
          assert.equal(await page.locator('#nucleusCanvas').isVisible(), true);
          assert.equal(await page.locator('#chartCanvas').isVisible(), false);
        } else {
          assert.equal(await page.locator('#angleGraphCanvas').isVisible(), true);
          await page.locator('#pauseBtn').click();
          assert.equal(await page.locator('#pauseBtn').innerText(), 'Resume');
        }
        await page.evaluate(() => document.exitFullscreen());
        await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector('#simulation-root').classList.contains('fs-active'));
        assert.equal(await page.locator('.simulation-graphs').evaluate(el => getComputedStyle(el).display), 'flex');
        assert.equal(await page.locator('.simulation-graph').first().isVisible(), true);
        assert.deepEqual(errors, []); await page.close();
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
