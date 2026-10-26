import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderSimulation } from '../public/simulation-ui.mjs';
import { makeDocument } from './dom-shim.mjs';

const definition = JSON.parse(readFileSync(new URL('../public/simulations/catalog.json', import.meta.url))).simulations.find(s => s.id === 'circuits');
const source = readFileSync(new URL('../public/simulations/circuits.js', import.meta.url), 'utf8');
function setup() {
  const document = makeDocument();
  const root = document.createElement('div'); root.ownerDocument = document;
  const ui = renderSimulation(root, definition);
  for (const el of root.querySelectorAll('*')) {
    el.closest = selector => {
      let parent = el;
      while (parent && !parent.classList.contains(selector.slice(1))) parent = parent.parentElement;
      return parent;
    };
    el.setPointerCapture = () => {};
  }
  const labels = [], arcs = [];
  const ctx = new Proxy({
    fillText: (text, x, y) => labels.push({ text, x, y }),
    arc: (x, y, r) => arcs.push({ x, y, r }),
    measureText: text => ({ width: text.length * 7 }),
    createRadialGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] ?? (() => {}) });
  const canvas = ui.getElementById('circuitCanvas');
  canvas.getContext = () => ctx;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 560, width: 900, height: 560 });
  const window = makeDocument();
  const sandbox = { window, SimLib: {
    Theme: { use: () => ({ font() {}, series: [] }) }, Color: { alpha() {}, lighten() {} }, Draw: { paper() {} },
    Simulation: class {}, attach: () => ({ sim: { start() {} } }),
  } };
  // Test-only access to the mounted model, without a production debugging API.
  vm.runInNewContext(source.replace('export function mount', 'function mount').replace('return { app };',
    'return { state: () => JSON.parse(snapshot()), tick, draw, buildDragComp, setTool, pending: () => pendingWire, net: () => net };'), sandbox);
  const sim = sandbox.mount(ui);
  const get = id => ui.getElementById(id);
  const emit = (target, type, props = {}) => {
    for (const fn of target.listeners[type] || []) fn({ button: 0, pointerId: 1, preventDefault() {}, ...props });
  };
  const pointer = (type, x, y) => emit(canvas, type, { clientX: x, clientY: y });
  const draw = (ax, ay, bx, by) => { pointer('pointerdown', ax, ay); pointer('pointermove', bx, by); pointer('pointerup', bx, by); };
  const click = (x, y) => { pointer('pointerdown', x, y); pointer('pointerup', x, y); };
  const parts = () => sim.state().comps;
  return { ...sim, render: sim.draw, get, emit, pointer, draw, click, parts, labels, arcs, window, canvas, root, clear: () => get('clearBtn').click() };
}

test('two-click wires wait for an endpoint, snap, cancel, and still support dragging', () => {
  const s = setup(); s.clear(); s.setTool('wire');
  s.click(103, 103); assert.equal(s.parts().length, 0); assert.ok(s.pending());
  s.pointer('pointermove', 247, 203); s.render();
  assert.ok(s.arcs.some(a => a.x === 100 && a.y === 100 && a.r === 7), 'root marker');
  s.click(247, 203);
  assert.deepEqual(JSON.parse(JSON.stringify(s.parts()[0].b)), { x: 250, y: 200 });
  s.click(250, 200); s.emit(s.root, 'keydown', { key: 'Escape', target: s.canvas });
  assert.equal(s.pending(), null);
  s.click(250, 200); s.setTool('select'); assert.equal(s.pending(), null);
  s.setTool('wire'); s.draw(250, 200, 400, 200); assert.equal(s.parts().length, 2);
  s.get('undoBtn').click(); assert.equal(s.parts().length, 1);
});

test('fixed parts snap to 15 degrees, keep their length, and suppress near-root projections', () => {
  const s = setup(); s.clear(); s.setTool('resistor');
  assert.equal(s.buildDragComp({ start: { x: 100, y: 100 }, cur: { x: 105, y: 100 } }), null);
  for (const degrees of [-174, -91, -16, 8, 38, 92, 179]) {
    const rad = degrees * Math.PI / 180;
    const c = s.buildDragComp({ start: { x: 200, y: 200 }, cur: { x: 200 + Math.cos(rad) * 130, y: 200 + Math.sin(rad) * 130 } });
    assert.ok(Math.abs(Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) - 70) < 1e-9);
    const angle = Math.atan2(c.b.y - c.a.y, c.b.x - c.a.x) * 180 / Math.PI;
    assert.ok(Math.abs(angle / 15 - Math.round(angle / 15)) < 1e-9);
  }
  const before = s.state().nextId;
  s.pointer('pointerdown', 200, 200); s.pointer('pointermove', 300, 230);
  for (let i = 0; i < 20; i++) s.tick(0.016);
  assert.equal(s.state().nextId, before, 'drawing previews must not allocate model IDs');
  s.pointer('pointerup', 300, 230); assert.equal(s.parts().length, 1);
});

test('inserting a resistor replaces wire under it, preserves stubs and changes solved current; undo restores topology', () => {
  const s = setup(); s.tick(0.016);
  const original = s.parts().length;
  const current = s.net().total;
  s.setTool('resistor'); s.draw(420, 430, 490, 430); s.tick(0.016);
  assert.equal(s.parts().length, original + 2);
  assert.equal(s.parts().filter(c => c.type === 'resistor').length, 2);
  assert.ok(s.net().total < current / 3, 'new resistance is in series, not shorted by the original wire');
  assert.ok(!s.parts().some(c => c.type === 'wire' && c.a.x <= 420 && c.b.x >= 490 && c.a.y === 430));
  s.get('undoBtn').click(); s.tick(0.016);
  assert.equal(s.parts().length, original);
  assert.ok(Math.abs(s.net().total - current) < 1e-9);
});

test('toolbox drops and board insertions follow arbitrary wire angles without a bypass', () => {
  for (const toolbox of [false, true]) {
    const s = setup(); s.clear(); s.setTool('wire'); s.draw(100, 100, 500, 400);
    if (toolbox) {
      const button = s.get('tools').querySelectorAll('button').find(b => b.dataset.value === 'bulb');
      s.emit(button, 'pointerdown', { clientX: 0, clientY: 0 });
      s.emit(s.window, 'pointermove', { clientX: 300, clientY: 250 });
      const id = s.state().nextId;
      s.render(); s.render();
      assert.equal(s.state().nextId, id);
      s.emit(s.window, 'pointerup');
      assert.equal(s.get('selNum').closest('.simulation-field').querySelector('label').textContent, 'Resistance (Ω)');
    } else {
      s.setTool('resistor'); s.draw(180, 160, 260, 220);
    }
    assert.equal(s.parts().length, 3, 'one part replaces the wire span between two stubs');
    const c = s.parts().find(c => c.type !== 'wire');
    assert.ok(Math.abs(Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) - 70) < 1e-9);
    assert.ok(Math.abs((c.b.y - c.a.y) / (c.b.x - c.a.x) - 0.75) < 1e-9);
    s.get('undoBtn').click(); assert.equal(s.parts().length, 1);
  }
});

test('eraser sweeps between sparse pointer events and undo restores one complete stroke', () => {
  const s = setup(); s.clear(); s.setTool('wire');
  for (const x of [200, 300, 400]) s.draw(x, 100, x, 300);
  s.setTool('delete'); s.draw(100, 200, 500, 200);
  assert.equal(s.parts().length, 0);
  s.get('undoBtn').click(); assert.equal(s.parts().length, 3);
  s.get('undoBtn').click(); assert.equal(s.parts().length, 2);
});

test('numeric edits, switch toggles, moves, endpoint edits, clear and presets are undoable; units are visible', () => {
  const s = setup(); s.setTool('select'); s.click(315, 430);
  assert.equal(s.get('selNum').closest('.simulation-field').querySelector('label').textContent, 'Voltage (V)');
  s.get('selNum').value = 12; s.emit(s.get('selNum'), 'input'); s.emit(s.get('selNum'), 'change');
  assert.equal(s.parts().find(c => c.type === 'battery').voltage, 12);
  s.get('undoBtn').click(); assert.equal(s.parts().find(c => c.type === 'battery').voltage, 9);
  s.click(220, 305);
  assert.equal(s.get('selNum').closest('.simulation-field').querySelector('label').textContent, 'Resistance (Ω)');
  s.click(430, 150); assert.equal(s.parts().find(c => c.type === 'switch').closed, false);
  s.get('undoBtn').click(); assert.equal(s.parts().find(c => c.type === 'switch').closed, true);
  const before = JSON.stringify(s.parts());
  s.draw(220, 305, 250, 305); s.get('undoBtn').click(); assert.equal(JSON.stringify(s.parts()), before);
  s.draw(220, 430, 200, 460); s.get('undoBtn').click(); assert.equal(JSON.stringify(s.parts()), before);
  s.clear(); s.get('undoBtn').click(); assert.equal(JSON.stringify(s.parts()), before);
  s.get('presetParallel').click(); s.get('undoBtn').click(); assert.equal(JSON.stringify(s.parts()), before);
});

test('value labels remain within the board, avoid each other and leave circuit symbols readable', () => {
  const s = setup(); s.get('showValues').checked = true; s.emit(s.get('showValues'), 'change', { target: s.get('showValues') });
  s.labels.length = 0; s.tick(0.016);
  const labels = s.labels.filter(l => / A$| V$|closed|open/.test(l.text));
  assert.ok(labels.length >= 10, 'representative series labels remain available');
  const boxes = labels.map(l => ({ x: l.x - (l.text.length * 7 + 10) / 2, y: l.y - 9, w: l.text.length * 7 + 10, h: 18 }));
  for (const [i, a] of boxes.entries()) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= 900 && a.y + a.h <= 560);
    for (const b of boxes.slice(i + 1)) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    for (const part of s.parts()) for (let step = 0; step <= 20; step++) {
      const x = part.a.x + (part.b.x - part.a.x) * step / 20;
      const y = part.a.y + (part.b.y - part.a.y) * step / 20;
      assert.ok(x < a.x - 3 || x > a.x + a.w + 3 || y < a.y - 3 || y > a.y + a.h + 3, 'labels must not obscure component lines');
    }
  }
});
