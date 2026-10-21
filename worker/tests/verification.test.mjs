import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyArtifact } from '../verify.mjs';
import { SMOKE_ARTIFACT } from '../preflight.mjs';
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
