import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyArtifact, formatVerification } from '../verify.mjs';
import { SMOKE_ARTIFACT } from '../preflight.mjs';
test('repair feedback prioritizes failures instead of truncating them behind passing checks', () => {
  const text = formatVerification({
    ok: false,
    tests: {
      total: 101,
      passed: 100,
      failed: 1,
      results: [
        ...Array.from({ length: 100 }, () => ({
          name: 'unneeded passing detail '.repeat(100),
          ok: true,
        })),
        { name: 'critical collision law', ok: false, message: 'Expected momentum 3; got 7' },
      ],
    },
  });
  assert.ok(text.includes('critical collision law'));
  assert.ok(text.includes('Expected momentum 3; got 7'));
  assert.ok(!text.includes('unneeded passing detail'));
  assert.ok(text.includes('scientific reason'));
});
const enabled = process.env.CL_TEST_BROWSER === '1';
const run = (name, fn) => test(name, { skip: !enabled, timeout: 30000 }, fn);
run('real opaque-origin Chromium renders desktop/mobile and counts real assertions', async () => {
  const a = structuredClone(SMOKE_ARTIFACT);
  a.tests.module = `export async function run(api){const a=api.state();api.step(.5);const b=api.state();api.near(b.time-a.time,.5,.001);api.assert(true,'real assertion');}`;
  const r = await verifyArtifact(a, { timeoutMs: 15000 });
  assert.equal(r.ok, true, JSON.stringify(r.warnings));
  assert.ok(r.tests.results.some((t) => t.assertions === 2));
  assert.equal(r.screenshots.length, 4);
  assert.ok(r.screenshots.some((i) => i.viewport.width === 390));
});
run('trusted math modules, stylesheet and font load in the opaque verification frame', async () => {
  const a = structuredClone(SMOKE_ARTIFACT);
  a.definition.cards = [{
    title: 'Energy',
    paragraphs: [],
    formulas: [String.raw`\(E = \frac{1}{2}mv^2\)`],
  }];
  a.tests.module = `export async function run(api){
    api.assert(document.querySelector('.equation-formula math'), 'formula renders MathML');
    const fonts = await document.fonts.load('16px Temml');
    api.assert(fonts.length > 0 && fonts.every(f => f.status === 'loaded'), 'local math font loads');
    let blocked = false;
    try { await fetch('/simulation-page.mjs'); } catch { blocked = true; }
    api.assert(blocked, 'assets outside the trusted allowlist remain blocked');
  }`;
  const r = await verifyArtifact(a, { timeoutMs: 15000 });
  assert.equal(r.ok, true, formatVerification(r));
  assert.ok(r.tests.results.some((t) => t.assertions === 3));
});
run('failing declarative assertions identify their exact step, slot and actual value', async () => {
  const a = structuredClone(SMOKE_ARTIFACT);
  a.definition.controls = [{ type: 'text', id: 'probeValue', text: 'actual value', hidden: false }];
  a.tests = {
    manifest: {
      cases: [
        {
          name: 'specific diagnostic',
          steps: [{ action: 'expectText', id: 'probeValue', equals: 'expected value' }],
        },
      ],
    },
  };
  const r = await verifyArtifact(a, { timeoutMs: 15000 });
  const failure = r.tests.results.find((t) => t.name === 'specific diagnostic');
  assert.equal(failure.ok, false);
  assert.match(failure.message, /Step 1/);
  assert.match(failure.message, /#probeValue/);
  assert.match(failure.message, /actual value/);
});
run('self-reported pass flags without executed assertions fail', async () => {
  const a = structuredClone(SMOKE_ARTIFACT);
  a.tests = {
    manifest: { cases: [] },
    module: `export async function run(api){return [{name:'fake',ok:true}]}`,
  };
  const r = await verifyArtifact(a, { timeoutMs: 15000 });
  assert.equal(r.ok, false);
  assert.ok(r.tests.results.some((t) => !t.ok && t.message?.includes('no assertions')));
});
run('a scientific test gets fresh initial state and invalid values fail', async () => {
  const a = structuredClone(SMOKE_ARTIFACT);
  a.tests = {
    manifest: {
      cases: [
        {
          name: 'first',
          steps: [
            { action: 'step', seconds: 1 },
            { action: 'expectCanvas', id: 'scene', nonBlank: true },
          ],
        },
      ],
    },
    module: `export async function run(api){api.near(api.state().time,0,.00001);api.near(Number.NaN,0,1);}`,
  };
  const r = await verifyArtifact(a, { timeoutMs: 15000 });
  assert.equal(r.ok, false);
  assert.ok(r.tests.results.some((t) => !t.ok && t.message?.includes('got NaN')));
});
run('missing inspectState / mount crash cannot pass', async () => {
  const a = structuredClone(SMOKE_ARTIFACT);
  a.moduleCode = 'export function mount(ui){throw new Error("broken mount")}';
  const r = await verifyArtifact(a, { timeoutMs: 15000 });
  assert.equal(r.ok, false);
  assert.equal(r.infrastructure, false);
  assert.match(r.warnings.join(' '), /broken mount/);
});
run('an infinite synchronous engine is stopped by the independent process watchdog', async () => {
  const a = structuredClone(SMOKE_ARTIFACT);
  a.moduleCode = 'export function mount(ui){while(true){}}';
  const start = Date.now();
  const r = await verifyArtifact(a, { timeoutMs: 2500 });
  assert.equal(r.ok, false);
  assert.match(r.warnings.join(' '), /watchdog/);
  assert.ok(Date.now() - start < 10000);
});
run('network/account/storage remain unavailable inside the opaque origin', async () => {
  const a = structuredClone(SMOKE_ARTIFACT);
  a.tests.module = `export async function run(api){let blocked=false;try{localStorage.setItem('x','y')}catch{blocked=true}api.assert(blocked,'opaque-origin storage');let network=false;try{await fetch('https://example.com')}catch{network=true}api.assert(network,'network denied');}`;
  const r = await verifyArtifact(a, { timeoutMs: 15000 });
  assert.equal(r.ok, true, JSON.stringify(r.warnings));
});
run('browser configuration failure is infrastructure, not an engine test failure', async () => {
  const before = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = '/nonexistent/chromium';
  try {
    const r = await verifyArtifact(SMOKE_ARTIFACT, { timeoutMs: 5000 });
    assert.equal(r.infrastructure, true);
    assert.equal(r.ok, false);
  } finally {
    if (before === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = before;
  }
});
