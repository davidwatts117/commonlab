import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCertificate } from '../public/completion-certificate.mjs';
import { makeDocument } from './dom-shim.mjs';

function setup({ lessons = [], session } = {}) {
  const document = makeDocument();
  let prints = 0, time = 0;
  const windowEvents = makeDocument();
  document.defaultView = {
    print() { prints++; }, performance: { now: () => time },
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  };
  const simulationRoot = document.createElement('section');
  const host = document.createElement('section'); host.ownerDocument = document;
  const handlers = new Map();
  const bus = {
    on(type, handler) { handlers.set(type, handler); return () => handlers.delete(type); },
    emit(type, experimentId) { handlers.get(type)?.({ experimentId }); },
  };
  const definition = { title: '<img src=x onerror=alert(1)>', summary: '<script>bad()</script>', lessons };
  const learning = { check: session ? { session } : null };
  const mounted = mountCertificate({ host, definition, learning, bus, simulationRoot });
  const input = host.querySelector('input');
  input.setCustomValidity = message => { input.validationMessage = message; };
  input.reportValidity = () => {};
  const form = host.querySelector('form');
  function submit(name) {
    input.value = name;
    form.listeners.submit[0]({ preventDefault() {} });
    return host.querySelector('article');
  }
  function interact({ type = 'input', isTrusted = true, key, control = true, learning = false } = {}) {
    const target = { closest: selector => selector.startsWith('.') ? (learning ? target : null) : (control ? target : null) };
    for (const fn of simulationRoot.listeners[type]) fn({ type, isTrusted, key, target });
  }
  function hide(hidden) {
    document.hidden = hidden;
    document.listeners.visibilitychange.forEach(fn => fn());
  }
  return { host, document, handlers, bus, input, submit, mounted, simulationRoot, windowEvents,
    interact, hide, advance: ms => { time += ms; }, prints: () => prints };
}

test('free exploration produces a dated, named, printable certificate without inventing activities', () => {
  const { host, document, input, submit, prints, interact, advance } = setup();
  assert.equal(host.querySelector('article').hidden, true);
  assert.equal(input.required, true); assert.equal(input.maxLength, 100);
  interact(); advance(65_000);
  const certificate = submit('  Ada Lovelace  ');
  assert.equal(certificate.hidden, false);
  assert.equal(document.activeElement, certificate);
  assert.equal(certificate.querySelector('.certificate-name').textContent, 'Ada Lovelace');
  assert.match(certificate.textContent, /Certificate of completion/);
  assert.match(certificate.textContent, /Issued .+\d{4}/);
  assert.match(certificate.textContent, /not a verified qualification/);
  assert.deepEqual(certificate.querySelectorAll('li').map(el => el.textContent), ['Simulation exploration: time spent: 1m 0s (this visit)']);
  host.querySelectorAll('button').at(-1).click();
  assert.equal(prints(), 1);
});

test('exploration requires trusted simulation interaction, not loading, form entry, or generated events', () => {
  const { submit, advance, interact, host } = setup();
  advance(120_000);
  interact({ isTrusted: false });
  interact({ type: 'click', control: false });
  interact({ type: 'keydown', key: 'Tab' });
  interact({ type: 'click', learning: true });
  advance(10_000);
  assert.match(submit('Student').textContent, /Simulation exploration: not recorded/);
  // Certificate input is outside the simulation root.
  host.querySelector('input').listeners.input[0]();
  assert.match(submit('Student').textContent, /Simulation exploration: not recorded/);
  interact({ type: 'keydown', key: 'ArrowRight' });
  assert.match(submit('Student').textContent, /time spent: less than 1 second/);
  advance(2_999);
  assert.match(submit('Student').textContent, /time spent: 0m 2s/);
});

test('exploration accumulates visible time, caps idle intervals, suspends for bfcache, and cleans up', () => {
  const { submit, advance, interact, hide, mounted, document, simulationRoot, windowEvents } = setup();
  interact({ type: 'pointerdown' }); advance(5_000);
  hide(true); advance(120_000); interact(); hide(false);
  advance(10_000); // Returning to the tab requires another interaction.
  assert.match(submit('Student').textContent, /time spent: 0m 5s/);
  interact({ type: 'click' }); advance(90_000);
  assert.match(submit('Student').textContent, /time spent: 1m 5s/);
  advance(90_000);
  assert.match(submit('Student').textContent, /time spent: 1m 5s/);
  interact({ type: 'change' }); advance(3_000);
  windowEvents.listeners.pagehide.forEach(fn => fn());
  advance(120_000);
  assert.match(submit('Student').textContent, /time spent: 1m 8s/);
  interact(); advance(2_000);
  assert.match(submit('Student').textContent, /time spent: 1m 10s/);
  mounted.destroy();
  assert.ok(Object.values(simulationRoot.listeners).every(list => list.length === 0));
  assert.equal(document.listeners.visibilitychange.length, 0);
  assert.equal(windowEvents.listeners.pagehide.length, 0);
});

test('blank and oversized names are rejected and all certificate content stays literal text', () => {
  const { host, input, submit } = setup();
  for (const name of ['', '   ', 'a'.repeat(101)]) {
    assert.equal(submit(name).hidden, true);
    assert.match(input.validationMessage, /Enter a name/);
  }
  input.listeners.input[0](); assert.equal(input.validationMessage, '');
  const name = '<img src=x onerror=alert(1)> & "Name"';
  const certificate = submit(name);
  assert.equal(certificate.querySelector('.certificate-name').textContent, name);
  assert.match(certificate.textContent, /<script>bad\(\)<\/script>/);
  assert.equal(host.querySelectorAll('img, script').length, 0);
});

test('only engaged lessons are listed, with independent started/completed states and no duplicates', () => {
  const lessons = ['one', 'two', 'untouched'].map(id => ({ id, title: `<${id}>` }));
  const { bus, submit, handlers, host, mounted } = setup({ lessons });
  bus.emit('guided:step', 'one'); bus.emit('guided:step', 'one');
  bus.emit('guided:step', 'two'); bus.emit('guided:complete', 'two');
  bus.emit('guided:step', 'two'); // Restart must not erase a completed engagement.
  bus.emit('guided:complete', 'unknown');
  const certificate = submit('Student');
  assert.deepEqual(certificate.querySelectorAll('li').map(el => el.textContent), [
    'Simulation exploration: not recorded (no interaction this visit)', 'Guided experiment started (not completed): <one>', 'Guided experiment completed: <two>',
  ]);
  assert.equal(certificate.querySelectorAll('one, two').length, 0);
  bus.emit('guided:complete', 'one'); submit('Another student');
  assert.equal(certificate.querySelectorAll('li').length, 3);
  assert.match(certificate.textContent, /completed: <one>/);
  assert.doesNotMatch(certificate.textContent, /Student/);
  mounted.destroy();
  assert.equal(handlers.size, 0); assert.equal(host.children.length, 0);
});

test('assessment participation is read at generation time and distinguishes unfinished from completed checks', () => {
  const session = { active: null, latest: null };
  const { submit } = setup({ session });
  assert.doesNotMatch(submit('Student').textContent, /Check Understanding/);
  session.active = { index: 0 };
  assert.match(submit('Student').textContent, /Check Understanding in progress/);
  assert.doesNotMatch(submit('Student').textContent, /Check Understanding completed/);
  session.active = null; session.latest = { answers: [] };
  assert.match(submit('Student').textContent, /Check Understanding completed \(latest local result\)/);
  assert.doesNotMatch(submit('Student').textContent, /in progress/);
  session.active = { index: 0 };
  assert.match(submit('Student').textContent, /completed.*in progress/);
});
