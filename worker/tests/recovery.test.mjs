import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointStore } from '../checkpoints.mjs';
import { ModelCaller, emptyLedger } from '../model-call.mjs';
import { createRuntimeForModel } from '../models.mjs';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { PROTOCOL } from '../protocol.mjs';
import { job } from './fixtures.mjs';
import { spawn } from 'node:child_process';
import { processIdentity, stopRecordedProcess } from '../processes.mjs';
test('restart cleanup kills only the recorded process identity, not a reused PID', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const closed = new Promise((resolve) => child.once('exit', resolve));
  const identity = await processIdentity(child.pid);
  assert.equal(await stopRecordedProcess({ pid: child.pid, identity: 'wrong' }), false);
  assert.equal(await stopRecordedProcess({ pid: child.pid, identity }), true);
  await closed;
});
test('checkpoint identity, durable roundtrip, private permissions and symlink refusal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commonlab-recovery-'));
  try {
    const store = await CheckpointStore.open(dir);
    await store.save(job, { phase: 'build', files: { 'engine.js': 'saved' } });
    assert.equal((await stat(store.path(job.id))).mode & 0o777, 0o600);
    assert.equal((await store.load(job)).files['engine.js'], 'saved');
    await assert.rejects(store.load({ ...job, prompt: 'different' }), /identity/);
    const link = join(dir, 'symlink');
    await symlink(dir, link);
    await assert.rejects(CheckpointStore.open(link), /private/);
    await rm(store.path(job.id));
    await symlink(join(dir, 'missing'), store.path(job.id));
    await assert.rejects(store.load(job));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
async function caller({
  streamOverride,
  limits = {},
  ledger = emptyLedger(),
  deadlineAt = Date.now() + 60000,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'commonlab-call-'));
  const { runtime, model } = await createRuntimeForModel({
    dir,
    provider: 'openrouter',
    modelId: 'xiaomi/mimo-v2.6-flash',
    apiKey: 'test-only-never-sent',
  });
  const saves = [];
  const c = new ModelCaller({
    dir,
    runtime,
    model,
    ledger,
    deadlineAt,
    streamOverride,
    onSave: async () => saves.push(structuredClone(ledger)),
    limits: { ...PROTOCOL.limits, ...limits },
  });
  return { c, saves, ledger, close: () => rm(dir, { recursive: true, force: true }) };
}
const options = {
  system: 'System',
  prompt: 'Prompt',
  tools: [
    {
      name: 'test_tool',
      label: 'test',
      description: 'Test only',
      parameters: Type.Object({}, { additionalProperties: false }),
    },
  ],
  targetTokens: 1000,
};
test('no-first-response deadline aborts inference, retains the reservation and clears timers', async () => {
  const fixture = await caller({
    streamOverride: () => createAssistantMessageEventStream(),
    limits: { firstMs: 20, callMs: 200, idleMs: 50 },
  });
  try {
    const start = Date.now();
    await assert.rejects(fixture.c.call(options), (e) => e.code === 'provider_first_timeout');
    assert.ok(Date.now() - start < 2000);
    assert.equal(fixture.ledger.requests, 1);
    assert.ok(fixture.ledger.inflight);
    assert.ok(fixture.saves[0].costMicros > 0);
  } finally {
    await fixture.close();
  }
});
function partial(model) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'working' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}
test('a stream that starts and then stalls has a distinct idle deadline', async () => {
  const fixture = await caller({
    streamOverride: (model) => {
      const stream = createAssistantMessageEventStream();
      const message = partial(model);
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'working', partial: message });
      return stream;
    },
    limits: { firstMs: 200, idleMs: 25, callMs: 300 },
  });
  try {
    await assert.rejects(fixture.c.call(options), (e) => e.code === 'provider_idle_timeout');
    assert.ok(fixture.ledger.inflight);
  } finally {
    await fixture.close();
  }
});
test('active streaming cannot bypass the total call deadline', async () => {
  let tick;
  const fixture = await caller({
    streamOverride: (model) => {
      const stream = createAssistantMessageEventStream();
      const message = partial(model);
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      tick = setInterval(
        () => stream.push({ type: 'text_delta', contentIndex: 0, delta: 'x', partial: message }),
        5,
      );
      return stream;
    },
    limits: { firstMs: 200, idleMs: 100, callMs: 40 },
  });
  try {
    await assert.rejects(fixture.c.call(options), (e) => e.code === 'provider_timeout');
  } finally {
    clearInterval(tick);
    await fixture.close();
  }
});
test('overall job deadline prevents new provider spending', async () => {
  let requests = 0;
  const fixture = await caller({
    deadlineAt: Date.now() + 1000,
    streamOverride: () => {
      requests++;
    },
  });
  try {
    await assert.rejects(fixture.c.call(options), (e) => e.code === 'timeout');
    assert.equal(requests, 0);
    assert.equal(fixture.ledger.requests, 0);
  } finally {
    await fixture.close();
  }
});
test('estimated-cost and token reservations deny calls before reaching the network', async () => {
  let requests = 0;
  const fixture = await caller({
    limits: { costMicros: 1 },
    streamOverride: () => {
      requests++;
    },
  });
  try {
    await assert.rejects(fixture.c.call(options), (e) => e.code === 'budget_exhausted');
    assert.equal(requests, 0);
  } finally {
    await fixture.close();
  }
});
