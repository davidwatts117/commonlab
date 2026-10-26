import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderSimulation } from '../public/simulation-ui.mjs';
import { makeDocument } from './dom-shim.mjs';

const definition = JSON.parse(readFileSync(new URL('../public/simulations/catalog.json', import.meta.url), 'utf8')).simulations.find(sim => sim.id === 'gas-laws');
const source = readFileSync(new URL('../public/simulations/gas-laws.js', import.meta.url), 'utf8');

test.after(() => { delete globalThis.document; });

function setup() {
  const document = makeDocument();
  globalThis.document = document;
  const root = document.createElement('div'); root.ownerDocument = document;
  const ui = renderSimulation(root, definition);
  const labels = [];
  const ctx = new Proxy({ fillText: (...args) => labels.push(args) }, {
    get: (target, key) => target[key] ?? (() => {}),
  });
  const sandbox = { SimLib: {
    Theme: { use: () => ({ font: () => 'font' }) },
    Color: { heat: value => value },
    CanvasUtils: { eventPos: (_canvas, event) => event.pos },
    Simulation: class {
      constructor(app) { Object.assign(this, { app, ctx, logical: app.logical }); }
      start() {}
    },
    attach({ canvas, logicalWidth: w, logicalHeight: h, SimulationClass }) {
      const app = { canvas, ctx, logical: { w, h } };
      app.sim = new SimulationClass(app); app.sim.onInit(); return app;
    },
  } };
  vm.runInNewContext(source.replace('export function mount', 'function mount'), sandbox);
  const { app: { sim } } = sandbox.mount(ui);
  const rectangles = [];
  sim.roundRect = (_ctx, x, y, w, h) => rectangles.push({ x, y, w, h });
  const get = id => ui.getElementById(id);
  function input(id, value) {
    get(id).value = String(value);
    for (const listener of get(id).listeners.input) listener();
  }
  function gauge() {
    rectangles.length = 0; labels.length = 0; sim.drawPressureGauge();
    return { fill: rectangles.find(rect => rect.x === 580), labels: labels.map(([text, x, y]) => ({ text, x, y })) };
  }
  return { sim, get, input, gauge, rectangles };
}

test('pressure gauge responds to every gas variable on a fixed, labeled scale', () => {
  const { input, gauge } = setup();
  const initial = gauge();
  const ticks = result => result.labels.filter(label => label.x === 616);
  let previous = initial.fill.h;
  for (const [id, value] of [['volumeSlider', 2.5], ['tempSlider', 500], ['molesSlider', 3]]) {
    input(id, value);
    const current = gauge();
    assert.ok(current.fill.h > previous, `${id} must increase the visible pressure fill`);
    assert.deepEqual(ticks(current), ticks(initial), 'scale labels and positions must stay fixed');
    previous = current.fill.h;
  }
  assert.ok(initial.labels.some(label => label.text === 'log(1+P)'));
  input('volumeSlider', 5); input('tempSlider', 300); input('molesSlider', 1.5);
  assert.deepEqual(gauge().fill, initial.fill, 'returning to the same pressure restores the same fill');

  let last = 0;
  for (const [n, temperature, volume] of [[0.5, 100, 10], [1.5, 300, 5], [30, 500, 0.5]]) {
    input('molesSlider', n); input('tempSlider', temperature); input('volumeSlider', volume);
    const { fill } = gauge();
    const pressure = n * 0.082057 * temperature / volume;
    assert.ok(Math.abs(fill.h - 336 * Math.log1p(pressure) / Math.log1p(3000)) < 1e-9);
    assert.ok(fill.h > last && fill.h <= 336);
    assert.ok(fill.y >= 62 && fill.y + fill.h <= 398);
    last = fill.h;
  }
});

test('gas sliders synchronize all readouts and particle counts in the same input event', () => {
  const { sim, get, input } = setup();
  function check() {
    const pressure = sim.n * sim.R * sim.T / sim.V;
    assert.equal(get('molesValue').textContent, `${sim.n.toFixed(1)} mol`);
    assert.equal(get('tempValue').textContent, `${sim.T.toFixed(0)} K`);
    assert.equal(get('volumeValue').textContent, `${sim.V.toFixed(1)} L`);
    assert.equal(get('pressureDisplay').textContent, pressure.toFixed(2));
    assert.equal(get('pressureKpaDisplay').textContent, (pressure * 101.325).toFixed(1));
    assert.equal(get('particleCount').textContent, String(Math.round(sim.n * 35)));
    assert.equal(sim.particles.length, Math.round(sim.n * 35));
    assert.equal(get('nRTproduct').textContent, (sim.n * sim.R * sim.T).toFixed(2));
    const nRT = sim.n * sim.R * sim.T;
    assert.equal(get('idealGasSub').textContent, `${pressure.toFixed(2)} × ${sim.V.toFixed(1)} = ${sim.n.toFixed(1)} × 0.0821 × ${sim.T.toFixed(0)}; PV = ${(pressure * sim.V).toFixed(2)}, nRT = ${nRT.toFixed(2)}`);
  }
  check();
  for (const [id, value] of [['molesSlider', 3], ['molesSlider', 0.5], ['tempSlider', 500], ['volumeSlider', 0.5]]) {
    input(id, value); check();
  }
});

test('temperature controls thermometer fill and particle speed, including endpoints', () => {
  const { sim, input, rectangles } = setup();
  let previous = -1;
  for (const temperature of [100, 300, 500]) {
    input('tempSlider', temperature);
    rectangles.length = 0; sim.drawThermometer((sim.T - 100) / 400);
    assert.ok(rectangles.every(rect => rect.h >= 0), 'no negative fill at minimum temperature');
    const height = rectangles.find(rect => rect.x === 43)?.h ?? 0;
    assert.ok(height > previous); previous = height;
    const bounds = sim.getChamberBounds();
    sim.particles = [{ x: 300, y: (bounds.top + bounds.bottom) / 2, vx: 1, vy: 0 }];
    sim.updateParticles();
    assert.ok(Math.abs(sim.particles[0].x - 300 - Math.sqrt(temperature / 300)) < 1e-9);
  }
});

test('piston dragging synchronizes volume, chamber geometry and pressure indicator', () => {
  const { sim, get, gauge } = setup();
  const initial = gauge().fill.h;
  const canvas = get('gasCanvas');
  let captured;
  canvas.setPointerCapture = id => { captured = id; };
  const emit = (type, pos) => canvas.listeners[type].forEach(listener => listener({ pos, pointerId: 1, preventDefault() {} }));
  emit('pointerdown', { x: 300, y: sim.getChamberBounds().top - 10 });
  assert.equal(captured, 1);
  emit('pointermove', { x: 300, y: sim.dragStartY + 90 });
  assert.equal(get('volumeSlider').value, '2.6');
  assert.equal(get('volumeValue').textContent, '2.6 L');
  assert.equal(sim.getChamberBounds().top, 420 - 2.6 / 10 * 360);
  assert.ok(gauge().fill.h > initial);
  emit('pointerup', { x: 300, y: sim.dragStartY + 90 });
  assert.equal(sim.isDraggingPiston, false);
});
