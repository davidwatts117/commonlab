import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuided } from './dom-shim.mjs';

function harness() {
  const { Guided, document } = loadGuided();
  const root = document.createElement('div');
  const launcher = document.createElement('button');
  launcher.focus();
  const slider = document.createElement('input');
  const sim = { canvas: document.createElement('canvas'), length: 1 };
  const adapter = Guided.adapter(sim, {
    controls: { length: { get: () => sim.length, set: v => { sim.length = v; }, el: slider } },
  });
  const overlay = new Guided.Overlay(root, adapter);
  const experiment = Guided.define({
    id: 'test', title: 'Test experiment',
    setup: { controls: { length: 1 } },
    steps: [
      { id: 'intro', type: 'message', title: 'Intro', body: '**Bold** and *italic* and `code`\n- one\n- two' },
      { id: 'predict', type: 'predict', title: 'Predict', body: 'Your prediction?',
        choices: [{ id: 'yes', label: 'Yes', correct: true }], feedback: { correct: '**Good**' } },
      { id: 'task', type: 'task', title: 'Move length', body: 'Move the slider',
        highlight: ['length'], allow: ['length'], hint: 'Try the **slider**',
        when: { control: 'length', equals: 2 } },
      { id: 'finish', type: 'conclusion', title: 'Finish' },
    ],
  });
  const runner = new Guided.Runner({ experiment, adapter, overlay, app: {} });
  overlay.onEscape = () => runner.handleEscape();
  runner.start();
  return { Guided, document, overlay, runner, slider, launcher };
}

function tab(document, shiftKey = false) {
  let prevented = false;
  for (const handler of document.listeners.keydown || []) {
    handler({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
  }
  return prevented;
}

test('dialog includes visible HUD in its accessible scope and focus cycle', () => {
  const { document, overlay } = harness();
  assert.equal(overlay.hud.hidden, false);
  assert.equal(overlay.hud.parentElement, overlay.modalWrap);
  assert.equal(overlay.modalWrap.getAttribute('role'), 'dialog');
  assert.equal(overlay.modalWrap.getAttribute('aria-modal'), 'true');
  assert.ok(Number.parseInt(overlay.modalWrap.style.paddingTop) > overlay.hud.offsetHeight);
  const next = overlay.modalWrap.querySelector('[data-footer] .guided-btn');
  next.focus();
  assert.equal(tab(document, true), true);
  assert.equal(document.activeElement, overlay.hud.querySelector('[data-exit]'));
  assert.equal(tab(document), true);
  assert.equal(document.activeElement, next);
});

test('HUD restart and exit work while a prediction dialog is open', () => {
  const { overlay, runner } = harness();
  runner.next();
  overlay.modalWrap.querySelector('.guided-choice').click();
  assert.equal(runner.answers.predict, 'yes');
  overlay.hud.querySelector('[data-restart]').click();
  assert.equal(runner.index, 0);
  assert.equal(Object.keys(runner.answers).length, 0);
  overlay.hud.querySelector('[data-exit]').click();
  assert.equal(runner.running, false);
  assert.equal(overlay.modalWrap.hidden, true);
});

test('completion preserves HUD restart/exit and restart restores step controls', () => {
  const { overlay, runner } = harness();
  runner.goTo('finish');
  runner.next();
  assert.equal(overlay.hud.hidden, false);
  assert.equal(overlay.hud.parentElement, overlay.modalWrap);
  assert.equal(overlay.hud.querySelector('[data-back]').hidden, true);
  overlay.hud.querySelector('[data-restart]').click();
  assert.equal(runner.running, true);
  assert.equal(runner.index, 0);
  assert.equal(overlay.hud.querySelector('[data-back]').hidden, false);
  assert.equal(overlay.hud.querySelector('[data-skip]').hidden, false);
});

test('DOM rendering supports Markdown without HTML assignment or unsafe links', () => {
  const { overlay } = harness();
  const body = overlay.modalWrap.querySelector('[data-body]');
  assert.equal(body.querySelector('strong').textContent, 'Bold');
  assert.equal(body.querySelector('em').textContent, 'italic');
  assert.equal(body.querySelector('code').textContent, 'code');
  assert.equal(body.querySelectorAll('li').length, 2);
  overlay.toast('<script>bad()</script> [unsafe](javascript:alert) [safe](https://example.com)');
  assert.equal(overlay.toastEl.querySelector('script'), null);
  assert.match(overlay.toastEl.textContent, /<script>bad\(\)<\/script>/);
  assert.equal(overlay.toastEl.querySelectorAll('a').length, 1);
  assert.equal(overlay.toastEl.querySelector('a').getAttribute('href'), 'https://example.com');
  clearTimeout(overlay._toastTimer);
});

test('task transition restores HUD to root, focuses allowed control, and renders hints/callout', () => {
  const { document, overlay, runner, slider } = harness();
  runner.goTo('task');
  assert.equal(overlay.modalWrap.hidden, true);
  assert.equal(overlay.hud.parentElement, overlay.root);
  assert.equal(document.activeElement, slider);
  assert.equal(overlay._callouts.length, 1);
  assert.match(overlay._callouts[0].callout.el.textContent, /Move length/);
  overlay.revealHint();
  assert.equal(overlay.card.querySelector('[data-hint-text]').hidden, false);
  assert.equal(overlay.card.querySelector('[data-hint-text] strong').textContent, 'slider');
});
