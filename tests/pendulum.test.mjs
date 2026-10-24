import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderSimulation } from '../public/simulation-ui.mjs';
import { makeDocument } from './dom-shim.mjs';

const definition = JSON.parse(readFileSync(new URL('../public/simulations/catalog.json', import.meta.url), 'utf8')).simulations.find(sim => sim.id === 'pendulum');
const source = readFileSync(new URL('../public/simulations/pendulum.js', import.meta.url), 'utf8');

function recordingContext() {
  const labels = [], strokes = [];
  let path = [];
  const ctx = new Proxy({
    labels, strokes,
    fillText: (text, x, y) => labels.push({ text, x, y }),
    beginPath: () => { path = []; },
    moveTo: (x, y) => path.push({ x, y }),
    lineTo: (x, y) => path.push({ x, y }),
    stroke() { strokes.push({ color: this.strokeStyle, path }); },
  }, { get: (target, key) => target[key] ?? (() => {}) });
  return ctx;
}

function setup() {
  const document = makeDocument();
  const root = document.createElement('div'); root.ownerDocument = document;
  const ui = renderSimulation(root, definition);
  const contexts = {};
  for (const id of ['pendulumCanvas', 'energyGraphCanvas', 'angleGraphCanvas']) {
    const ctx = contexts[id] = recordingContext();
    ui.getElementById(id).getContext = () => ctx;
  }
  const sandbox = { SimLib: {
    Theme: { use: () => ({ font: () => 'font', series: ['ke', 'pe', 'thermal', 'total'], accent: 'angle' }) },
    Draw: { axisLabel() {} },
    UI: { bindSlider(element, { oninput }) {
      const apply = () => oninput(+element.value);
      element.addEventListener('input', apply); apply();
    } },
    Guided: { adapter: () => ({}) },
    Simulation: class {
      constructor(app) { Object.assign(this, { app, canvas: app.canvas, logical: app.logical }); }
      start() {}
    },
    attach({ canvas, logicalWidth: w, logicalHeight: h, SimulationClass }) {
      const app = { canvas, ctx: contexts.pendulumCanvas, logical: { w, h } };
      app.sim = new SimulationClass(app); app.sim.onInit(); return app;
    },
  } };
  vm.runInNewContext(source.replace('export function mount', 'function mount'), sandbox);
  const { app: { sim } } = sandbox.mount(ui);
  function input(id, value) {
    const element = ui.getElementById(id); element.value = String(value);
    element.listeners.input.forEach(listener => listener());
  }
  function graph(kind) {
    const ctx = contexts[kind === 'energy' ? 'energyGraphCanvas' : 'angleGraphCanvas'];
    ctx.labels.length = 0; ctx.strokes.length = 0;
    if (kind === 'energy') sim.drawEnergyGraph(); else sim.drawAngleGraph();
    return ctx;
  }
  return { sim, input, graph };
}

const energy = (t, total) => ({ t, ke: total / 4, pe: total / 4, thermal: total / 2, total });
const ceiling = ctx => Number(ctx.labels.find(label => label.x === 36 && label.y === 10).text);
const series = (ctx, color) => ctx.strokes.find(stroke => stroke.color === color).path;

function assertInside(points, canvas) {
  for (const { x, y } of points) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
    assert.ok(x >= 42 && x <= canvas.width - 10, `x=${x} outside plot`);
    assert.ok(y >= 10 && y <= canvas.height - 20, `y=${y} outside plot`);
  }
}

test('energy range retains historical peaks when mass, gravity or length decreases', () => {
  for (const [id, low] of [['massSlider', 0.1], ['gravitySlider', 0.5], ['lengthSlider', 0.3]]) {
    const { sim, input, graph } = setup();
    input('massSlider', 5); input('gravitySlider', 20); input('lengthSlider', 3); input('angleSlider', 85);
    sim.onTick(0.01); sim.onTick(0.01);
    const peak = Math.max(...sim.energyHistory.map(p => p.total));
    const before = ceiling(graph('energy'));
    input(id, low);
    assert.equal(ceiling(graph('energy')), before, 'controls alone must not rescale retained data');
    sim.onTick(0.01);
    const ctx = graph('energy');
    assert.ok(Math.abs(ceiling(ctx) - peak * 1.15) < 0.06);
    for (const key of ['ke', 'pe', 'thermal', 'total']) {
      assertInside(series(ctx, key), definition.graphs.find(g => g.id === 'energyGraphCanvas'));
    }
    assert.ok(series(ctx, 'total')[0].y > 10, 'old peak must not be flattened against the ceiling');
  }
});

test('energy range uses every plotted series and only the visible 20-second window', () => {
  for (const key of ['ke', 'pe', 'thermal', 'total']) {
    const { sim, graph } = setup();
    sim.simTime = 25;
    sim.energyHistory = [energy(4.99, 1000), { ...energy(5, 1), [key]: 20 }, energy(25, 1)];
    const ctx = graph('energy');
    assert.equal(ceiling(ctx), 23, `${key} peak at the left edge must set the scale`);
    const height = definition.graphs.find(g => g.id === 'energyGraphCanvas').height;
    assert.ok(Math.abs(series(ctx, key)[0].y - (height - 20 - 20 / 23 * (height - 30))) < 1e-9, 'use the true value, not a clipped one');
    sim.simTime = 25.01;
    sim.energyHistory.push(energy(25.01, 1));
    assert.equal(ceiling(graph('energy')), 1.1, 'offscreen peak and trim padding must no longer set the scale');
  }
});

test('angle range follows visible positive and negative peaks without a 90-degree cap', () => {
  for (const peak of [80, -120]) {
    const { sim, graph } = setup();
    sim.simTime = 10; sim.angleDeg = 1;
    sim.angleHistory = [{ t: 1.99, a: 300 }, { t: 2, a: peak }, { t: 10, a: 1 }];
    const ctx = graph('angle');
    assert.equal(ctx.labels[0].text, `${Math.round(Math.abs(peak) * 1.12)}°`);
    assertInside(series(ctx, 'angle'), definition.graphs.find(g => g.id === 'angleGraphCanvas'));
    sim.simTime = 10.01; sim.angleDeg = 170;
    sim.angleHistory.push({ t: 10.01, a: -2 });
    assert.equal(graph('angle').labels[0].text, '6°', 'offscreen history and current state must not rescale visible samples');
  }
});

test('empty, single-sample, zero and reset histories have finite nonzero ranges', () => {
  const { sim, graph } = setup();
  for (const count of [0, 1, 2]) {
    sim.energyHistory = Array.from({ length: count }, (_, i) => energy(i, 0));
    sim.angleHistory = Array.from({ length: count }, (_, i) => ({ t: i, a: 0 }));
    sim.simTime = 2;
    assert.equal(ceiling(graph('energy')), 0.1);
    assert.equal(graph('angle').labels[0].text, '6°');
  }
  sim._resetEnergy();
  assert.equal(ceiling(graph('energy')), 0.1);
  assert.equal(graph('angle').labels[0].text, '6°');
});
