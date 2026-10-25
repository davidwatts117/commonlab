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
  // Measure in one frame: focusing the certificate can still be scrolling the page.
  const spacing = await certificate.evaluate(el => {
    const descriptionBox = el.querySelector('.certificate-description').getBoundingClientRect();
    const participationBox = el.querySelector('.certificate-activities').getBoundingClientRect();
    return participationBox.top - descriptionBox.bottom;
  });
  assert.ok(spacing >= 16, 'Description and record need visible spacing');
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
      assert.equal(await page.locator('#original-simulations .sim-card').count(), catalog.simulations.length);
      assert.equal(await page.locator('#community-simulations .sim-card').count(), 0);
      assert.equal(await page.locator('#community-simulations-empty').isVisible(), true);
      assert.match(await page.locator('#simulation-catalog').innerText(), /guided lesson/i);
      await page.locator('#simulation-catalog .sim-card').first().click();
      await page.waitForSelector('[data-ready="true"]');
      assert.equal(await page.locator('h1').innerText(), 'Pendulum Lab'); await page.close();
    });

    await t.test('catalog groups use provenance rather than order, subject or engine, including static hosting', async () => {
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        // A community definition deliberately precedes an original with the same subject.
        const mixed = { schemaVersion: 1, simulations: [catalog.simulations[0], catalog.simulations[1]], communitySimulationIds: ['pendulum'] };
        await page.route('**/simulations/catalog.json', route => route.fulfill({ json: mixed }));
        await page.goto(`${base}/#simulations`);
        await page.waitForFunction(() => document.getElementById('catalog-status').hidden);
        assert.equal(await page.locator('#original-simulations .sim-name').innerText(), catalog.simulations[1].title);
        assert.equal(await page.locator('#community-simulations .sim-name').innerText(), catalog.simulations[0].title);
        assert.equal(await page.getByRole('region', { name: 'Original simulations', exact: true }).count(), 1);
        assert.equal(await page.getByRole('region', { name: 'Community simulations', exact: true }).count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        delete mixed.communitySimulationIds;
        await page.reload();
        await page.waitForFunction(() => document.getElementById('catalog-status').hidden);
        assert.equal(await page.locator('#original-simulations .sim-card').count(), 2);
        assert.equal(await page.locator('#community-simulations-empty').isVisible(), true);
        // An all-community catalog still has an explicit, correct original empty state.
        mixed.communitySimulationIds = ['pendulum', 'circuits'];
        await page.reload();
        await page.waitForFunction(() => document.getElementById('catalog-status').hidden);
        assert.equal(await page.locator('#original-simulations-empty').isVisible(), true);
        assert.equal(await page.locator('#community-simulations .sim-card').count(), 2);
        await page.close();
      }
    });

    await t.test('homepage contact links to the official support address on desktop and mobile', async () => {
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.goto(base);
        await page.getByRole('link', { name: 'Contact', exact: true }).click();
        await page.waitForFunction(() => {
          const box = document.querySelector('#contact a[href^="mailto:"]').getBoundingClientRect();
          return box.top >= 0 && box.bottom <= innerHeight;
        });
        const contact = page.locator('#contact a[href^="mailto:"]');
        assert.equal(await contact.count(), 1);
        assert.equal(await contact.innerText(), 'support@common-lab.org');
        assert.equal(await contact.getAttribute('href'), 'mailto:support@common-lab.org');
        assert.equal(await contact.isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.close();
      }
    });

    await t.test('community cards get safe subject artwork without loading engines', async () => {
      const literal = '<img src=x onerror="x = 1">';
      const community = [
        { id: 'community-physics', subject: 'physics', title: literal },
        { id: 'community-chemistry', subject: 'chemistry', title: 'Community chemistry' },
        // A valid slug must not resolve an inherited property of the artwork map.
        { id: 'constructor', subject: 'physics', title: 'Constructor lab' },
      ].map(fields => ({ ...structuredClone(catalog.simulations[0]), ...fields, lessons: [], assessment: undefined }));
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [], engineRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (/\/simulations\/.*\.js(?:\?|$)/.test(request.url())) engineRequests.push(request.url()); });
        await page.route('**/simulations/catalog.json', route => route.fulfill({ json: { schemaVersion: 1, simulations: [...catalog.simulations, ...community], communitySimulationIds: community.map(definition => definition.id) } }));
        await page.goto(base);
        await page.waitForFunction(() => document.getElementById('catalog-status').hidden);
        assert.equal(await page.locator('.sim-card').count(), catalog.simulations.length + community.length);
        assert.equal(await page.locator('.sim-thumb svg').count(), catalog.simulations.length + community.length);
        assert.equal(await page.locator('#community-simulations .sim-card').count(), community.length);
        assert.equal(await page.locator('#original-simulations .sim-card').count(), catalog.simulations.length);
        const artwork = [];
        for (const definition of community) {
          const card = page.locator(`.sim-card[href="/simulation.html?id=${definition.id}"]`);
          assert.equal(await card.locator('.sim-name').innerText(), definition.title);
          const svg = card.locator('.sim-thumb svg');
          assert.equal(await svg.getAttribute('aria-hidden'), 'true');
          assert.equal(await svg.getAttribute('viewBox'), '0 0 240 130');
          assert.ok(await svg.locator('path, circle, ellipse, line').count() > 0);
          const box = await svg.boundingBox();
          assert.ok(box.width > 0 && box.height > 0, 'preview artwork is visible');
          artwork.push(await svg.innerHTML());
        }
        assert.notEqual(artwork[0], artwork[1], 'subjects have distinct illustrations');
        assert.equal(artwork[0], artwork[2], 'inherited keys use the physics fallback');
        const pendulum = page.locator('.sim-card[href="/simulation.html?id=pendulum"] .sim-thumb svg');
        assert.equal(await pendulum.locator('circle[cx="154"][cy="99"]').count(), 1, 'built-in pendulum artwork is preserved');
        assert.equal(await page.locator('.sim-card img, .sim-card script, .sim-card iframe').count(), 0);
        assert.equal(await page.evaluate(() => window.x), undefined);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(engineRequests, []);
        assert.deepEqual(errors, []);
        await page.close();
      }
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

    await t.test('Pendulum survives a hidden minute and retains a user pause on return', async () => {
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      // Observe the actual engine without adding a production debugging API.
      await page.route('**/library.js*', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: `${await response.text()}
          const attach = SimLib.attach;
          SimLib.attach = options => {
            const app = attach(options); window.testSim = app.sim; return app;
          };` });
      });
      await page.goto(`${base}/simulations/pendulum`);
      await page.waitForSelector('#simulation-root[data-ready="true"]');
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      await page.clock.runFor(100);
      // Headless tabs stay visible: dispatch the browser lifecycle signal explicitly.
      const before = await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        return { time: testSim.simTime, angle: testSim.angle, velocity: testSim.angularVel };
      });
      await page.clock.fastForward(60_000);
      assert.deepEqual(await page.evaluate(() => ({ time: testSim.simTime, angle: testSim.angle, velocity: testSim.angularVel })), before);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.clock.runFor(100);
      const resumed = await page.evaluate(() => ({ time: testSim.simTime, angle: testSim.angle, energy: testSim._computeEnergy().total }));
      assert.ok(resumed.time > before.time && resumed.time - before.time <= 0.15);
      assert.ok(Number.isFinite(resumed.angle) && Number.isFinite(resumed.energy));
      assert.ok(Math.abs(resumed.angle) < Math.PI / 2, 'pendulum must not explode after returning');
      await page.locator('#pauseBtn').click();
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.clock.fastForward(60_000);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.clock.runFor(100);
      assert.equal(await page.evaluate(() => testSim.simTime), resumed.time);
      assert.equal(await page.locator('#pauseBtn').innerText(), 'Resume');
      assert.deepEqual(errors, []); await page.close();
    });

    await t.test('nucleus readout text and stepper labels stay inside their boxes', async () => {
      const { page, errors } = await pageFor('build-a-nucleus', true);
      await page.waitForFunction(() => !document.getElementById('btnProtonPlus').disabled);
      for (const width of [320, 390, 900, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const element of ['Carbon', 'Nitrogen']) {
          if (element === 'Nitrogen') await page.locator('#btnProtonPlus').click();
          assert.equal(await page.locator('#elementName').innerText(), element);
          const leaks = await page.evaluate(() => {
            const leaks = [];
            for (const box of document.querySelectorAll('.sim-readout, .sim-stepper .sim-btn')) {
              const bounds = box.getBoundingClientRect();
              const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
              let text;
              while ((text = walker.nextNode())) {
                const range = document.createRange(); range.selectNodeContents(text);
                for (const rect of range.getClientRects()) {
                  if (rect.width && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 ||
                    rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)) {
                    leaks.push({ box: box.className, text: text.textContent });
                  }
                }
              }
            }
            return leaks;
          });
          assert.deepEqual(leaks, [], `${element} text leaks at ${width}px`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        await page.locator('#btnProtonMinus').click();
      }
      assert.deepEqual(errors, []); await page.close();
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

    await t.test('Gas controls update the rendered pressure gauge and particle readout', async () => {
      const { page, errors } = await pageFor('gas-laws');
      async function pressureFill() {
        // Wait for drawing, then measure actual accent pixels in the gauge's center column.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        return page.evaluate(() => {
          const canvas = document.getElementById('gasCanvas');
          const sample = document.createElement('canvas').getContext('2d');
          sample.fillStyle = SimLib.Theme.use('light').accent; sample.fillRect(0, 0, 1, 1);
          const color = sample.getImageData(0, 0, 1, 1).data;
          const scale = canvas.height / 450;
          const pixels = canvas.getContext('2d').getImageData(Math.round(592 * canvas.width / 700), Math.ceil(60 * scale), 1, Math.floor(340 * scale)).data;
          let count = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] === color[0] && pixels[i + 1] === color[1] && pixels[i + 2] === color[2]) count++;
          }
          return count / scale;
        });
      }
      let previousPressure = Number(await page.locator('#pressureDisplay').innerText());
      let previousFill = await pressureFill();
      assert.ok(previousFill > 0);
      for (const [id, value] of [['volumeSlider', '2.5'], ['tempSlider', '500'], ['molesSlider', '3']]) {
        await page.locator(`#${id}`).fill(value); await page.locator(`#${id}`).dispatchEvent('input');
        const pressure = Number(await page.locator('#pressureDisplay').innerText());
        const fill = await pressureFill();
        assert.ok(pressure > previousPressure, `${id} changes the numeric pressure`);
        assert.ok(fill > previousFill + 1, `${id} changes the visible pressure bar`);
        previousPressure = pressure; previousFill = fill;
      }
      assert.equal(await page.locator('#particleCount').innerText(), '105');
      await page.locator('#molesSlider').fill('0.5'); await page.locator('#molesSlider').dispatchEvent('input');
      assert.equal(await page.locator('#particleCount').innerText(), '18');
      assert.ok(await pressureFill() < previousFill - 1);
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

    await t.test('Circuit wires draw in open space and connect at endpoints and mid-wire junctions', async () => {
      for (const mobile of [false, true]) {
        const { page, errors } = await pageFor('circuits', mobile);
        const canvas = page.locator('#circuitCanvas');
        const tool = value => page.locator(`#tools [data-value="${value}"]`).click();
        async function point(x, y) {
          await canvas.scrollIntoViewIfNeeded();
          const box = await canvas.boundingBox();
          return { x: box.x + x * box.width / 900, y: box.y + y * box.height / 560 };
        }
        async function draw(ax, ay, bx, by) {
          const a = await point(ax, ay), b = await point(bx, by);
          await page.mouse.move(a.x, a.y); await page.mouse.down();
          await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
        }
        async function currentBetween(min, max) {
          await page.waitForFunction(([lo, hi]) => {
            const current = Number(document.getElementById('current').textContent);
            return current > lo && current < hi;
          }, [min, max]);
        }
        await page.locator('#clearBtn').click();
        await tool('wire');
        // Neither end touches a part: the wire must still be placed and selectable.
        await draw(150, 150, 350, 150);
        assert.match(await page.locator('#selectedPanel').innerText(), /^Wire/);
        await tool('select');
        const middle = await point(250, 150); await page.mouse.click(middle.x, middle.y);
        assert.match(await page.locator('#selectedPanel').innerText(), /^Wire/);
        // Dragged parts use the same placement path as wires.
        await tool('battery'); await draw(300, 400, 370, 400);
        assert.match(await page.locator('#selectedPanel').innerText(), /^Battery/);
        await tool('resistor'); await draw(500, 150, 570, 150);
        assert.match(await page.locator('#selectedPanel').innerText(), /^Resistor/);
        await tool('wire');
        await draw(350, 150, 500, 150); // wire endpoint to resistor
        await draw(150, 150, 150, 400); // wire endpoint to open space
        await draw(150, 400, 300, 400);
        await draw(570, 150, 700, 150);
        await draw(700, 150, 700, 400);
        await currentBetween(-0.001, 0.001); // still an open circuit
        await draw(700, 400, 370, 400);
        await currentBetween(0.08, 0.10); // 9 V through 100 ohms
        // Add a second 100-ohm branch, starting AND ending on wire interiors.
        await tool('resistor'); await draw(350, 300, 420, 300);
        // Aim slightly off the wire to exercise interior snapping, not just
        // coincident grid points.
        await tool('wire'); await draw(254, 157, 350, 300);
        await draw(420, 300, 620, 157);
        await currentBetween(0.17, 0.19);
        assert.equal(await page.locator('#warning').isVisible(), false);
        // Select still moves a wire, including its attached branch. Disconnect
        // the branch at its resistor so the original single path remains live.
        await tool('select'); await draw(302, 225, 352, 225);
        await currentBetween(0.08, 0.10);
        // The first click only anchors a wire; the second commits its endpoint.
        await page.locator('#clearBtn').click(); await tool('wire');
        let p = await point(300, 200); await page.mouse.click(p.x, p.y);
        assert.match(await page.locator('#selectedPanel').innerText(), /Select a part/);
        p = await point(450, 200); await page.mouse.move(p.x, p.y);
        await page.mouse.click(p.x, p.y);
        assert.match(await page.locator('#selectedPanel').innerText(), /^Wire/);
        await tool('select'); p = await point(400, 200); await page.mouse.click(p.x, p.y);
        assert.match(await page.locator('#selectedPanel').innerText(), /^Wire/);
        // Inserting into an existing live wire must add series resistance, not a bypass.
        await page.locator('#presetSeries').click();
        await currentBetween(0.285, 0.295);
        await tool('resistor'); await draw(420, 430, 490, 430);
        await currentBetween(0.06, 0.08);
        assert.equal(await page.getByLabel('Resistance (Ω)', { exact: true }).count(), 2);
        assert.equal(await page.locator('label[for="selNum"]').innerText(), 'Resistance (Ω)');
        await page.locator('#undoBtn').click(); await currentBetween(0.285, 0.295);
        // Erase several wires in one stroke, then restore the complete circuit.
        await tool('delete'); await draw(150, 390, 750, 390);
        await currentBetween(-0.001, 0.001);
        await page.locator('#undoBtn').click(); await currentBetween(0.285, 0.295);
        await tool('select'); p = await point(315, 430); await page.mouse.click(p.x, p.y);
        assert.equal(await page.locator('label[for="selNum"]').innerText(), 'Voltage (V)');
        await page.locator('#selNum').fill('12'); await page.locator('#selNum').press('Tab');
        await currentBetween(0.385, 0.395);
        await canvas.focus(); await page.keyboard.press('Control+z'); await currentBetween(0.285, 0.295);
        await page.locator('#showValues').check();
        assert.deepEqual(errors, [], mobile ? 'phone' : 'desktop');
        await page.close();
      }
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
