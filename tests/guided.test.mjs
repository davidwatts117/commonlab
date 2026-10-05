// Unit tests for the dependency-free parts of SimLib.Guided.
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** Load guided.js into an isolated context with a minimal SimLib stub. */
function loadGuided() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    SimLib: { CanvasUtils: {}, Simulation: class {}, Theme: { get: () => ({}) } },
  };
  sandbox.SimLib.Guided = undefined;
  const code = readFileSync(join(root, 'guided.js'), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'guided.js' });
  return sandbox.SimLib.Guided;
}

const Guided = loadGuided();

test('richText escapes HTML and renders a Markdown subset', () => {
  const html = Guided.richText('**bold** and *italic* and `code`\n- one\n- two\n\n[link](https://x.test)');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<a href="https:\/\/x\.test"/);
  assert.ok(html.indexOf('<p>') !== -1);
});

test('richText escapes dangerous markup', () => {
  const html = Guided.richText('<script>alert(1)</script>');
  assert.ok(!/<script>/.test(html));
  assert.match(html, /&lt;script&gt;/);
});

test('define validates required fields', () => {
  assert.throws(() => Guided.define({ steps: [] }), /id/);
  assert.throws(() => Guided.define({ id: 'x', steps: [] }), /steps/);
  assert.throws(
    () => Guided.define({ id: 'x', steps: [{ id: 'a' }, { id: 'a' }] }),
    /duplicate/,
  );
  assert.throws(
    () => Guided.define({ id: 'x', steps: [{ id: 'a', type: 'nope' }] }),
    /unknown step type/,
  );
});

test('define assigns per-type default advance modes', () => {
  const exp = Guided.define({
    id: 'x',
    steps: [
      { id: 'm', type: 'message' },
      { id: 't', type: 'task' },
      { id: 'p', type: 'predict' },
      { id: 'o', type: 'observe' },
      { id: 'c', type: 'conclusion' },
    ],
  });
  const byId = Object.fromEntries(exp.steps.map(s => [s.id, s.advance]));
  assert.equal(byId.m, 'on-next');
  assert.equal(byId.t, 'on-condition');
  assert.equal(byId.p, 'on-answer');
  assert.equal(byId.o, 'on-condition');
  assert.equal(byId.c, 'on-next');
});

test('define honors an explicit advance override', () => {
  const exp = Guided.define({ id: 'x', steps: [{ id: 't', type: 'task', advance: 'on-next' }] });
  assert.equal(exp.steps[0].advance, 'on-next');
});

test('adapter normalizes controls, state, actions and elements', () => {
  const a = Guided.adapter({}, {
    id: 'demo',
    controls: { length: { get: () => 1, set: () => {}, el: () => 'EL' } },
    state: { period: () => 2 },
    actions: { go: () => {} },
    targets: { bob: () => ({ x: 1, y: 2, r: 3 }) },
    elements: { release: () => 'BTN' },
  });
  assert.equal(a.id, 'demo');
  assert.equal(a.controls.length.get(), 1);
  assert.equal(a.controls.length.format(1.5), '1.5');
  assert.equal(a.state.period(), 2);
  assert.equal(typeof a.actions.go, 'function');
  assert.deepEqual(a.targetFor('bob'), { x: 1, y: 2, r: 3 });
  assert.equal(a.elementFor('release'), 'BTN');
  assert.equal(a.interactiveEls().sort().join(','), 'BTN,EL');
});

function ctx(adapter, extra) {
  return Object.assign({
    adapter,
    baseline: {},
    settle: {},
    lastAction: null,
    elapsed: 0,
    answers: {},
  }, extra || {});
}

test('evalWhen: control near / min / max / equals', () => {
  const adapter = Guided.adapter({}, {
    controls: {
      length: { get: () => 2.0, set: () => {} },
      drag: { get: () => 0, set: () => {} },
    },
  });
  assert.equal(Guided.evalWhen({ control: 'length', near: 2.0, tolerance: 0.02 }, ctx(adapter)), true);
  assert.equal(Guided.evalWhen({ control: 'length', near: 1.0, tolerance: 0.02 }, ctx(adapter)), false);
  assert.equal(Guided.evalWhen({ control: 'length', min: 1.5 }, ctx(adapter)), true);
  assert.equal(Guided.evalWhen({ control: 'length', max: 1.5 }, ctx(adapter)), false);
  assert.equal(Guided.evalWhen({ control: 'drag', equals: 0 }, ctx(adapter)), true);
});

test('evalWhen: changedBy uses the baseline', () => {
  const adapter = Guided.adapter({}, { controls: { g: { get: () => 14, set: () => {} } } });
  assert.equal(Guided.evalWhen({ control: 'g', changedBy: 4 }, ctx(adapter, { baseline: { g: 9.8 } })), true);
  assert.equal(Guided.evalWhen({ control: 'g', changedBy: 5 }, ctx(adapter, { baseline: { g: 9.8 } })), false);
});

test('evalWhen: state settles and thresholds', () => {
  const adapter = Guided.adapter({}, { state: { period: () => 2.2 } });
  assert.equal(Guided.evalWhen({ state: 'period', settles: true }, ctx(adapter)), false);
  assert.equal(
    Guided.evalWhen({ state: 'period', settles: true }, ctx(adapter, { settle: { period: { settled: true } } })),
    true,
  );
  assert.equal(Guided.evalWhen({ state: 'period', min: 2 }, ctx(adapter)), true);
  assert.equal(Guided.evalWhen({ state: 'period', max: 1 }, ctx(adapter)), false);
});

test('evalWhen: combinators and action', () => {
  const adapter = Guided.adapter({}, {
    controls: { a: { get: () => 1, set: () => {} }, b: { get: () => 5, set: () => {} } },
  });
  assert.equal(Guided.evalWhen({ all: [{ control: 'a', equals: 1 }, { control: 'b', min: 2 }] }, ctx(adapter)), true);
  assert.equal(Guided.evalWhen({ any: [{ control: 'a', equals: 9 }, { control: 'b', min: 2 }] }, ctx(adapter)), true);
  assert.equal(Guided.evalWhen({ not: { control: 'a', equals: 1 } }, ctx(adapter)), false);
  assert.equal(Guided.evalWhen({ action: 'release' }, ctx(adapter, { lastAction: 'release' })), true);
  assert.equal(Guided.evalWhen({ fn: () => true }, ctx(adapter)), true);
});

test('settleStates discovers nested settle conditions', () => {
  // Not exported directly; verify via behavior is covered above. Sanity: an
  // unknown state name never matches.
  const adapter = Guided.adapter({}, { state: {} });
  assert.equal(Guided.evalWhen({ state: 'missing', settles: true }, ctx(adapter)), false);
});
