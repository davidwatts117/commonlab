import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { validateCatalog, validateDefinition, loadCatalog } from '../public/simulation-schema.mjs';
import { renderSimulation, mountLearning } from '../public/simulation-ui.mjs';
import { makeDocument } from './dom-shim.mjs';

const catalog = JSON.parse(readFileSync(new URL('../public/simulations/catalog.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
function documentWithDialogs() {
  const document = makeDocument();
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const el = create(tag);
    if (tag === 'dialog') {
      el.showModal = () => { el.open = true; };
      el.close = () => { el.open = false; el.onclose?.(); };
    }
    return el;
  };
  return document;
}
function rootFor(document) {
  const root = document.createElement('div'); root.ownerDocument = document; return root;
}

test('catalog validates all seven simulations and every module is mount-only code, not a page', async () => {
  assert.equal(validateCatalog(catalog).simulations.length, 7);
  const files = readdirSync(new URL('../public/simulations/', import.meta.url));
  assert.equal(files.some(file => file.endsWith('.html')), false);
  for (const definition of catalog.simulations) {
    const module = await import(`../public/simulations/${definition.id}.js`);
    assert.equal(typeof module.mount, 'function');
    assert.deepEqual(Object.keys(module), ['mount']);
    const source = readFileSync(new URL(`../public/simulations/${definition.id}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.body|createElement/);
    const document = documentWithDialogs();
    const ui = renderSimulation(rootFor(document), definition);
    // Every legacy DOM binding must refer to a declared slot in the fixed shell.
    for (const match of source.matchAll(/document\.getElementById\('([^']+)'\)/g)) {
      assert.ok(ui.getElementById(match[1]), `${definition.id}: ${match[1]}`);
    }
  }
});

test('UI schema rejects markup/CSS/module escape hatches, unknown components, duplicate ids, and bad defaults', () => {
  const bad = [
    d => { d.html = '<script>alert(1)</script>'; },
    d => { d.styles = 'body { display: none; }'; },
    d => { d.module = 'https://example.com/anything.js'; },
    d => { d.id = '../other'; },
    d => { d.controls[0].type = 'raw-html'; },
    d => { d.controls[0].attributes = { onclick: 'alert(1)' }; },
    d => { d.controls[0].id = d.canvas.id; },
    d => { d.controls[0].value = 999; },
    d => { d.controls[0].step = 0; },
    d => { d.cards[0].html = '<b>unsafe</b>'; },
    d => { d.graphs[0].legend[0].color = 'url(https://example.com)'; },
    d => { d.assessment.questions[0].correct = ['missing']; },
    d => { d.lessons[0].steps[5].question = 'missing'; },
    d => { d.lessons[0].steps[5].question = 'scaling'; },
  ];
  for (const mutate of bad) {
    const definition = clone(catalog.simulations[0]); mutate(definition);
    assert.throws(() => validateDefinition(definition), /Simulation definition/);
  }
  const duplicate = clone(catalog); duplicate.simulations.push(duplicate.simulations[0]);
  assert.throws(() => validateCatalog(duplicate), /duplicate simulation/);
  assert.throws(() => validateCatalog({ ...catalog, schemaVersion: 2 }), /schema version/);
});

test('submission definitions cannot shadow shell slots or allocate unbounded canvas area', () => {
  const reserved = clone(catalog.simulations[0]); reserved.canvas.id = 'simulation-root';
  assert.throws(() => validateDefinition(reserved), /reserved/);
  const huge = clone(catalog.simulations[0]); huge.canvas.width = 4096; huge.canvas.height = 4096;
  assert.throws(() => validateDefinition(huge), /combined canvas area/);
  const inheritedInfo = clone(catalog.simulations[0]); inheritedInfo.info = {}; inheritedInfo.controls[0].info = 'constructor';
  assert.throws(() => validateDefinition(inheritedInfo), /unknown info reference/);
});

test('different simulations cannot share an assessment persistence bank ID', () => {
  const original = clone(catalog.simulations[0]); const copy = clone(original); copy.id = 'new-pendulum';
  copy.lessons.forEach(lesson => { lesson.sim = copy.id; });
  assert.throws(() => validateCatalog({ schemaVersion: 1, simulations: [original, copy] }), /duplicate assessment/);
  copy.assessment.id = 'new-pendulum';
  assert.equal(validateCatalog({ schemaVersion: 1, simulations: [original, copy] }).simulations.length, 2);
});

test('approved component slots render labels and untrusted strings as plain text', () => {
  const document = documentWithDialogs(); const root = rootFor(document);
  const definition = clone(catalog.simulations[0]);
  definition.cards[0].paragraphs = ['<img src=x onerror=alert(1)>'];
  const ui = renderSimulation(root, definition);
  assert.ok(root.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(root.querySelectorAll('img').length, 0);
  const slider = ui.getElementById('lengthSlider');
  assert.equal(slider.type, 'range'); assert.equal(slider.value, 1.2);
  assert.equal(root.querySelector('label').htmlFor, 'lengthSlider');
  assert.equal(ui.getElementById('pendulumCanvas').width, 700);
  assert.equal(ui.getElementById('energyGraphCanvas').height, 150);
  assert.throws(() => ui.getElementById('undeclared'), /Missing declared UI slot/);
  ui.destroy(); assert.equal(root.children.length, 0);
});

test('extended components validate cross-field rules and slot ids wherever they are nested', () => {
  const byId = id => clone(catalog.simulations.find(def => def.id === id));
  const bad = [
    ['titration', d => { d.controls.find(c => c.type === 'number').value = 99; }, /range/],
    ['titration', d => { d.controls.find(c => c.type === 'toggles').items[0].id = d.canvas.id; }, /duplicate slot/],
    ['titration', d => { d.controls.find(c => c.type === 'dock').swatch.id = 'phReadout'; }, /duplicate slot/],
    ['titration', d => { d.cards[0].components[0].columns[2].id = 'phReadout'; }, /duplicate slot/],
    ['titration', d => { d.cards[0].components.push({ type: 'raw-html', html: '<b>x</b>' }); }, /unknown component/],
    ['titration', d => { d.controls.find(c => c.type === 'text').style = 'banner'; }, /text style/],
    ['build-a-nucleus', d => { d.views.value = 'missing'; }, /initial selection/],
    ['build-a-nucleus', d => { d.graphs[0].view = 'missing'; }, /declared views/],
    ['build-a-nucleus', d => { delete d.views; }, /declared views/],
    ['build-a-nucleus', d => { d.graphs[0].controls[1].id = 'simulation-root'; }, /reserved/],
  ];
  for (const [id, mutate, message] of bad) {
    const definition = byId(id); mutate(definition);
    assert.throws(() => validateDefinition(definition), message, `${id}: ${message}`);
  }
});

test('module-filled panels and tables receive text parts, never markup', () => {
  const document = documentWithDialogs(); const root = rootFor(document);
  const ui = renderSimulation(root, catalog.simulations.find(def => def.id === 'titration'));
  ui.setContent('titrMessage', ['<img src=x>', { strong: true, text: '<b>5 mL</b>' }]);
  assert.ok(ui.getElementById('titrMessage').textContent.includes('<img src=x>'));
  assert.equal(root.querySelectorAll('img').length, 0);
  ui.setRows('dataBody', [['1', '0.50', { swatch: 'rgb(1, 2, 3)', text: 'colour' }]]);
  assert.equal(ui.getElementById('dataBody').children.length, 1);
  assert.equal(ui.getElementById('dataBody').children[0].children.length, 3);
  assert.equal(ui.getElementById('dockSwatch').hidden, true);
  assert.throws(() => ui.setContent('undeclared', 'x'), /Missing declared UI slot/);
  ui.destroy();
});

test('preview slot IDs are namespaced while UI bindings and labels remain consistent', () => {
  const document = documentWithDialogs(); const root = rootFor(document);
  const ui = renderSimulation(root, catalog.simulations[0], { idPrefix: 'review-preview-' });
  assert.equal(ui.getElementById('lengthSlider').id, 'review-preview-lengthSlider');
  assert.equal(root.querySelector('label').htmlFor, 'review-preview-lengthSlider');
  assert.equal(Array.from(root.querySelectorAll('input')).some(input => input.id === 'lengthSlider'), false);
  ui.destroy();
});

test('shared learning resolves bank references, keeps practice separate, and owns mutual exclusion', () => {
  const document = documentWithDialogs();
  const sandbox = { document, console, setTimeout, clearTimeout,
    getComputedStyle: () => ({ position: 'relative' }), addEventListener() {}, removeEventListener() {},
    SimLib: { CanvasUtils: {} } };
  for (const file of ['cfu.js', 'guided.js']) vm.runInNewContext(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), sandbox);
  const { SimLib } = sandbox;
  const root = rootFor(document); const ui = renderSimulation(root, catalog.simulations[0]);
  const app = { canvas: ui.getElementById('pendulumCanvas') };
  const adapter = SimLib.Guided.adapter(app, {});
  const learning = mountLearning(ui, { app, adapter }, document.createElement('div'), SimLib);
  assert.equal(learning.experiments.length, 1);
  assert.equal(learning.experiments[0].steps[5].question.id, 'length');
  assert.equal(learning.check.session.questions.length, 5);
  learning.check.open();
  learning.guided.start(learning.experiments[0]);
  assert.equal(learning.check.panel.hidden, true);
  learning.check.open(); assert.equal(learning.guided.runner, null);
  assert.equal(learning.check.session.active.answers.length, 0);
  learning.destroy();
});

test('catalog fetch failures are explicit rather than leaving an empty simulation', async () => {
  await assert.rejects(loadCatalog(async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(loadCatalog(async () => ({ ok: true, json: async () => ({ schemaVersion: 2 }) })), /schema version/);
});
