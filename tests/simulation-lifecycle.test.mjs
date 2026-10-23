import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/library.js', import.meta.url), 'utf8');

function harness(hidden = false) {
  let now = 0, nextId = 0;
  const frames = new Map(), listeners = new Set();
  const document = {
    hidden,
    addEventListener(type, handler) { assert.equal(type, 'visibilitychange'); listeners.add(handler); },
    removeEventListener(type, handler) { assert.equal(type, 'visibilitychange'); listeners.delete(handler); },
  };
  const sandbox = {
    document, performance: { now: () => now }, console,
    requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  vm.runInNewContext(source, sandbox, { filename: 'library.js' });
  const ticks = [], guidedTicks = [];
  let draws = 0, starts = 0, pauses = 0;
  const sim = new sandbox.SimLib.Simulation({ guidedTick: dt => guidedTicks.push(dt) });
  sim.onTick = dt => ticks.push(dt);
  sim.onDraw = () => draws++;
  sim.onStart = () => starts++;
  sim.onPause = () => pauses++;
  return {
    sim, frames, listeners, ticks, guidedTicks,
    get draws() { return draws; }, get starts() { return starts; }, get pauses() { return pauses; },
    advance(ms) { now += ms; },
    frame(ms = 16) {
      now += ms;
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(now);
    },
    visibility(hidden) {
      document.hidden = hidden;
      for (const handler of [...listeners]) handler();
    },
  };
}

test('hidden tabs suspend physics, drawing and guided ticks without changing running intent', () => {
  const h = harness();
  h.sim.start(); h.frame();
  assert.deepEqual(h.ticks, [0.016]);
  h.visibility(true);
  assert.equal(h.sim.running, true);
  assert.equal(h.frames.size, 0);
  h.frame(60_000);
  assert.deepEqual(h.ticks, [0.016]);
  assert.deepEqual(h.guidedTicks, h.ticks);
  assert.equal(h.draws, 1);
  h.visibility(false); h.frame();
  assert.deepEqual(h.ticks, [0.016, 0.016], 'hidden time must not be integrated on return');
  assert.deepEqual(h.guidedTicks, h.ticks);
  assert.equal(h.starts, 1);
  assert.equal(h.pauses, 0);
  assert.equal(h.frames.size, 1);
});

test('long visible frame gaps are bounded before applying simulation speed', () => {
  const h = harness();
  h.sim.setSpeed(2); h.sim.start();
  h.frame(20); h.frame(60_000); h.frame(20);
  assert.deepEqual(h.ticks, [0.04, 0.1, 0.04]);
  assert.deepEqual(h.guidedTicks, h.ticks);
});

test('start while hidden waits for visibility and stop while hidden does not auto-resume', () => {
  const h = harness(true);
  h.sim.start(); h.sim.start();
  assert.equal(h.frames.size, 0);
  h.advance(60_000); h.visibility(false); h.frame();
  assert.deepEqual(h.ticks, [0.016]);
  h.visibility(true); h.sim.stop();
  assert.equal(h.listeners.size, 0);
  h.advance(60_000); h.visibility(false); h.frame();
  assert.equal(h.sim.running, false);
  assert.equal(h.frames.size, 0);
  assert.deepEqual(h.ticks, [0.016]);
});

test('stop/start, reset and repeated visibility events keep exactly one animation loop', () => {
  const h = harness();
  h.sim.start(); h.sim.stop(); h.sim.start();
  assert.equal(h.frames.size, 1, 'stop must cancel its pending callback, including id zero');
  h.sim.reset();
  h.visibility(false); h.visibility(false);
  assert.equal(h.frames.size, 1);
  assert.equal(h.listeners.size, 1);
  h.frame(); h.frame();
  assert.equal(h.ticks.length, 2);
  h.visibility(true); h.visibility(true); h.visibility(false); h.visibility(false);
  assert.equal(h.frames.size, 1);
  h.sim.stop();
  assert.equal(h.frames.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('stopping inside a tick does not schedule another frame', () => {
  const h = harness();
  h.sim.onTick = () => h.sim.stop();
  h.sim.start(); h.frame();
  assert.equal(h.frames.size, 0);
  assert.equal(h.listeners.size, 0);
});
