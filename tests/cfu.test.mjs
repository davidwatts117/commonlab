import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { makeDocument } from './dom-shim.mjs';

function load(storage) {
  const document = makeDocument();
  const sandbox = { document, console, setTimeout, clearTimeout, localStorage: storage,
    getComputedStyle: () => ({ position: 'relative' }),
    addEventListener() {}, removeEventListener() {}, SimLib: { CanvasUtils: {} } };
  for (const file of ['cfu.js', 'guided.js', 'simulations/pendulum-cfu.js']) {
    vm.runInNewContext(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), sandbox);
  }
  return { ...sandbox.SimLib, document };
}
function memory() {
  const map = new Map();
  return { getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v), map };
}
function change(input, checked = true) {
  input.checked = checked;
  for (const fn of input.listeners.change || []) fn();
}

test('bank validates tags, keys, types and duplicates; Pendulum has five ordered assessment questions', () => {
  const { CFU, PendulumCFU: bank } = load();
  assert.equal(CFU.questions(bank, 'assessment').map(q => q.id).join(','), 'length,mass,gravity,scaling,dependencies');
  assert.equal(CFU.questions(bank, 'lesson').length, 4);
  const q = bank.questions[0];
  for (const bad of [{ ...q, use: 'wrong' }, { ...q, correct: ['missing'] }, { ...q, type: 'text' }, { ...q, choices: [q.choices[0], q.choices[0]] }]) {
    assert.throws(() => CFU.bank({ id: 'bad', version: 1, questions: [bad] }), /CFU/);
  }
  assert.throws(() => CFU.bank({ id: 'bad', version: 1, questions: [q, q] }), /duplicate/);
});

test('exact-set grading rejects partial, extra, duplicate and empty answers', () => {
  const { CFU, PendulumCFU: bank } = load();
  const q = bank.questions.find(q => q.id === 'dependencies');
  assert.equal(CFU.grade(q, ['gravity', 'length']), true);
  for (const a of [[], ['length'], ['length', 'gravity', 'mass'], ['length', 'length'], ['unknown']]) assert.equal(CFU.grade(q, a), false);
  assert.equal(CFU.grade(bank.questions[0], ['increase', 'same']), false);
});

test('standalone persists drafts and submitted locks, resumes unfinished and retains latest through restart', () => {
  const storage = memory();
  const { CFU, PendulumCFU: bank } = load(storage);
  let s = new CFU.Session(bank);
  s.restart(); s.draft(['same']);
  s = new CFU.Session(bank);
  assert.equal(s.active.draft.join(','), 'same');
  assert.equal(s.next(), false);
  assert.equal(s.submit(['same']), true);
  s = new CFU.Session(bank);
  assert.equal(s.active.submitted, true);
  assert.equal(s.submit(['increase']), false);
  s.draft(['increase']);
  assert.equal(s.active.answers[0].join(','), 'same');
  s.next();
  while (s.active) { s.submit(s.questions[s.active.index].correct); s.next(); }
  assert.equal(s.score(), 4);
  const completed = new CFU.Session(bank);
  assert.equal(completed.active, null);
  assert.equal(completed.score(), 4);
  completed.restart();
  assert.equal(new CFU.Session(bank).score(), 4);
});

test('version invalidation, corrupt records and storage API errors fail safely', () => {
  const storage = memory();
  const { CFU, PendulumCFU: bank } = load(storage);
  const s = new CFU.Session(bank); s.restart(); s.submit(['increase']);
  const v2 = CFU.bank({ ...bank, version: 2 });
  const invalidated = new CFU.Session(v2, storage);
  assert.equal(invalidated.active, null); assert.equal(invalidated.latest, null);
  storage.setItem(s.key, '{broken');
  assert.equal(new CFU.Session(bank, storage).storageAvailable, true);
  storage.setItem(s.key, JSON.stringify({ schema: 1, bankVersion: 1, active: { index: 0, submitted: true, answers: [['unknown']], draft: [] } }));
  assert.equal(new CFU.Session(bank, storage).active, null);
  const broken = new CFU.Session(bank, { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } });
  assert.equal(broken.storageAvailable, false); broken.restart(); broken.submit(['increase']);
  assert.equal(broken.active.submitted, true);
  const quota = new CFU.Session(bank, { getItem() { return null; }, setItem() { throw Error('quota'); } });
  quota.restart(); assert.equal(quota.storageAvailable, false);
  assert.equal(new CFU.Session(bank, null).storageAvailable, false);
});

test('shared DOM question requires explicit submit, locks inputs and shows explanation then Continue', () => {
  const { CFU, PendulumCFU: bank, document } = load();
  const host = document.createElement('div');
  let answer = null, continued = false;
  const view = CFU.renderQuestion(host, bank.questions[0], { onSubmit: a => { answer = a; }, onContinue: () => { continued = true; } });
  assert.equal(view.submit.disabled, true); assert.equal(view.continueButton.disabled, true);
  change(view.inputs[1]); assert.equal(answer, null); assert.equal(view.submit.disabled, false);
  view.submit.click(); assert.equal(answer.join(','), 'same');
  assert.ok(view.inputs.every(i => i.disabled)); assert.match(host.textContent, /Not quite.*Correct answer.*T =/);
  view.continueButton.click(); assert.equal(continued, true);
  change(view.inputs[0]); view.submit.click(); assert.equal(answer.join(','), 'same');
  const resumed = CFU.renderQuestion(document.createElement('div'), bank.questions[0], { answer, onContinue() {} });
  assert.ok(resumed.inputs.every(i => i.disabled)); assert.equal(resumed.submit.disabled, true);
});

test('multi-choice DOM supports exact-set submit and full standalone review, close and restart', () => {
  const { CFU, PendulumCFU: bank, document } = load(memory());
  const host = document.createElement('div');
  const view = CFU.renderQuestion(host, bank.questions[4]);
  change(view.inputs[0]); change(view.inputs[2]); view.submit.click();
  assert.match(host.textContent, /Correct\. Correct answer/);
  const mounted = CFU.mount({ bank, host }); mounted.open();
  const s = mounted.session;
  while (s.active) { s.submit(s.questions[s.active.index].correct); s.next(); }
  mounted.close(); mounted.open();
  assert.match(mounted.panel.textContent, /Score: 5 \/ 5/);
  assert.equal(mounted.panel.querySelectorAll('.cfu-review').length, 5);
  assert.match(mounted.panel.textContent, /Your answer:.*Correct answer:/);
  mounted.panel.querySelectorAll('button').find(b => b.textContent === 'Restart check').click();
  assert.equal(s.active.index, 0); assert.equal(s.latest.answers.length, 5);
});

test('guided checkpoints remain locked on Back/re-entry; HUD Next cannot bypass submission; restart clears', () => {
  const { CFU, Guided, PendulumCFU: bank, document } = load();
  const root = document.createElement('div');
  const adapter = Guided.adapter({ canvas: document.createElement('canvas') }, {});
  const overlay = new Guided.Overlay(root, adapter);
  const experiment = Guided.define({ id: 'lesson', steps: [
    { id: 'check', type: 'checkpoint', question: bank.questions[0] }, { id: 'end', type: 'conclusion' },
  ] });
  const runner = new Guided.Runner({ experiment, adapter, overlay, app: {} });
  runner.start();
  assert.equal(overlay.hud.querySelector('[data-next]').hidden, true);
  runner.next(); assert.equal(runner.index, 0);
  const inputs = overlay.modalWrap.querySelectorAll('input');
  assert.equal(document.activeElement, inputs[0]);
  change(inputs[1]);
  overlay.modalWrap.querySelector('.cfu-button').click();
  runner.next(); runner.back();
  assert.ok(overlay.modalWrap.querySelectorAll('input').every(i => i.disabled));
  assert.equal(document.activeElement.textContent, 'Continue');
  assert.equal(runner.answers.check.join(','), 'same');
  assert.match(overlay.modalWrap.textContent, /Not quite/);
  assert.equal(overlay.hud.querySelector('[data-next]').hidden, true);
  runner.restart();
  assert.ok(overlay.modalWrap.querySelectorAll('input').every(i => !i.disabled));
  assert.equal(runner.answers.check, undefined);
  runner.skip(); assert.equal(runner.index, 1);
  assert.equal(CFU.grade(bank.questions[0], ['same']), false);
});

test('lesson and standalone hooks mutually exclude panels without changing simulation controls', () => {
  const { CFU, Guided, PendulumCFU: bank, document } = load(memory());
  const host = document.createElement('div');
  const sim = { canvas: document.createElement('canvas'), paused: false };
  const adapter = Guided.adapter(sim, {});
  const lesson = Guided.define({ id: 'lesson', steps: [{ id: 'intro' }] });
  let check;
  const guided = Guided.mount({ app: { canvas: sim.canvas }, adapter, overlayRoot: host, launcherMount: host,
    experiments: [lesson], beforeStart: () => check.close() });
  check = CFU.mount({ bank, host, beforeOpen: () => { if (guided.runner) guided.runner.exit(); } });
  check.open(); guided.start(lesson);
  assert.equal(check.panel.hidden, true); assert.equal(guided.runner.running, true);
  check.open();
  assert.equal(guided.runner, null); assert.equal(guided.overlay.modalWrap.hidden, true);
  assert.equal(check.panel.hidden, false); assert.equal(sim.paused, false);
});
