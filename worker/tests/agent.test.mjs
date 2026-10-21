import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraft } from '../policy.mjs';
import { runChild, deliverResult, watchLease, ProgressQueue } from '../supervisor.mjs';
import { definition, simulationId, source, job } from './fixtures.mjs';
test('static source validation never executes code and rejects imports/top-level effects', () => {
  const draft = { definition, moduleCode: source };
  assert.ok(validateDraft(draft, simulationId));
  for (const moduleCode of [
    'globalThis.executed=true;export function mount(ui){}',
    'export function mount(ui){return import("https://x/")}',
    'invalid javascript',
  ])
    assert.throws(() => validateDraft({ ...draft, moduleCode }, simulationId));
  assert.equal(globalThis.executed, undefined);
});
test('external deadline kills the runner with a categorized outcome', async () => {
  await assert.rejects(
    runChild(job, async () => true, { runtimeMs: 1 }),
    (e) => e.code === 'timeout',
  );
});
test('lease polling tolerates a transient failure and stops on loss', async () => {
  let calls = 0,
    stops = 0;
  const stop = watchLease(
    async () => {
      if (++calls === 1) throw new Error('transient');
      return calls < 3;
    },
    () => stops++,
    { pollMs: 5, maxFailures: 3 },
  );
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.ok(stops > 0);
});
test('delivery retries do not repeat a stale result', async () => {
  let calls = 0;
  const r = await deliverResult(
    async () => {
      calls++;
      const e = new Error();
      e.status = 409;
      throw e;
    },
    async () => {},
  );
  assert.equal(r, null);
  assert.equal(calls, 1);
});
test('progress recovers after a failed event rather than disabling permanently', async () => {
  const sent = [];
  let calls = 0;
  const q = new ProgressQueue(async (e) => {
    calls++;
    if (calls <= 3) throw new Error('offline');
    sent.push(e.code);
  });
  q.push('model_request', {});
  q.push('model_finished', {});
  await q.close();
  assert.ok(sent.includes('model_finished'));
  assert.equal(q.dropped, 1);
});
