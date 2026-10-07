// Unit tests for Guided.Launcher using a minimal DOM shim (no browser).
// Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    type: '',
    children: [],
    attrs: {},
    listeners: {},
    _classes: new Set(),
    get classList() {
      const self = this;
      return {
        add: (...c) => c.forEach(x => self._classes.add(x)),
        remove: (...c) => c.forEach(x => self._classes.delete(x)),
        toggle: (c, on) => (on === undefined ? (self._classes.has(c) ? self._classes.delete(c) : self._classes.add(c)) : (on ? self._classes.add(c) : self._classes.delete(c))),
        contains: (c) => self._classes.has(c),
      };
    },
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    append(...children) { for (const child of children) this.appendChild(child); },
    get textContent() { return (this._text || '') + this.children.map(child => child.textContent).join(''); },
    set textContent(value) { this._text = String(value); this.children = []; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    remove() {},
  };
  return node;
}

function makeDocument() {
  return {
    _all: [],
    createElement(tag) { const n = makeNode(tag); this._all.push(n); return n; },
    createTextNode(text) { return { textContent: String(text) }; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, '');
      const out = [];
      const walk = (n) => {
        if (n.className && n.className.split(/\s+/).includes(cls)) out.push(n);
        (n.children || []).forEach(walk);
      };
      this._all.forEach(walk);
      return out;
    },
  };
}

function loadGuided() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    document: makeDocument(),
    SimLib: { CanvasUtils: {}, Simulation: class {}, Theme: { get: () => ({}) } },
  };
  const code = readFileSync(join(root, 'guided.js'), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'guided.js' });
  return sandbox.SimLib.Guided;
}

test('Launcher creates one card per experiment and toggles the panel', () => {
  const Guided = loadGuided();
  const exp = Guided.define({
    id: 'a',
    title: 'Experiment A',
    summary: 'Do a thing',
    subject: 'Physics',
    minutes: 5,
    steps: [{ id: 's1', type: 'message' }, { id: 's2', type: 'conclusion' }],
  });
  const host = makeNode('div');
  const launcher = new Guided.Launcher(host, [exp], () => {});

  assert.equal(launcher.panel.hidden, true, 'panel starts hidden');
  assert.ok(host.children.includes(launcher.el), 'launcher is attached to the host');
  assert.ok(launcher.el.children.includes(launcher.panel), 'panel is attached to the launcher root');
  const cards = launcher.panel.children
    .flatMap(c => c.children)
    .filter(c => c.className === 'guided-card-btn');
  assert.equal(cards.length, 1, 'one card rendered');
  assert.match(cards[0].textContent, /Experiment A/);
  assert.match(cards[0].textContent, /2 steps/);

  // Simulate a click on the toggle.
  launcher.button.listeners.click[0]();
  assert.equal(launcher.panel.hidden, false, 'panel opens on click');
  launcher.button.listeners.click[0]();
  assert.equal(launcher.panel.hidden, true, 'panel closes on second click');
});

test('Launcher start callback fires with the experiment', () => {
  const Guided = loadGuided();
  const exp = Guided.define({ id: 'a', title: 'A', steps: [{ id: 's', type: 'message' }] });
  const host = makeNode('div');
  let started = null;
  const launcher = new Guided.Launcher(host, [exp], (e) => { started = e; });
  const card = launcher.panel.children.flatMap(c => c.children)
    .filter(c => c.className === 'guided-card-btn')[0];
  card.listeners.click[0]();
  assert.equal(started, exp);
});
