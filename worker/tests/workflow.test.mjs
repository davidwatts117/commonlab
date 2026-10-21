import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../runner.mjs';
import { PROTOCOL } from '../protocol.mjs';
import { hash } from '../checkpoints.mjs';
import { Workspace, validateManifest, supportedDefinition } from '../workspace.mjs';
import {
  job,
  rounds,
  call,
  passReview,
  failedReview,
  passedReport,
  scripted,
  modelEnvironment,
  source,
  definition,
} from './fixtures.mjs';
const response = () =>
  call('respond_review', {
    responses: [
      {
        id: 'period',
        disposition: 'fixed',
        evidence: 'Corrected equation and added regression check.',
      },
    ],
  });
async function run(items = rounds(), options = {}) {
  const restore = modelEnvironment();
  const events = [],
    snapshots = [],
    traces = [];
  try {
    return {
      result: await generate(job, {
        streamOverride: scripted(items),
        reviewStreamOverride: scripted([passReview()]),
        verifyOverride: async () => passedReport(),
        onProgress: (code, details) => events.push({ code, details }),
        onCheckpoint: async (s) => snapshots.push(structuredClone(s)),
        onTrace: (kind, data) => traces.push({ kind, data }),
        ...options,
      }),
      events,
      snapshots,
      traces,
    };
  } finally {
    restore();
  }
}
test('locked SDK exposes only host tools, checkpoints operations and accounts for reviewer usage', async () => {
  const { result, events, snapshots } = await run();
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.report.review, 'passed');
  assert.equal(result.diagnostics.requests, 5);
  assert.equal(result.diagnostics.inputTokens, 500);
  assert.equal(result.artifact.moduleCode, source);
  assert.ok(snapshots.some((s) => s.ledger.inflight));
  assert.ok(events.some((e) => e.code === 'review_passed'));
  assert.ok(snapshots.some((s) => s.files['engine.js']));
});
test('scripted author stream does NOT disable production verification', async () => {
  const restore = modelEnvironment();
  try {
    const result = await generate(job, {
      streamOverride: scripted(rounds()),
      reviewStreamOverride: scripted([passReview()]),
      verifyOverride: async () => {
        throw new Error('Explicit verifier failure');
      },
    });
    assert.notEqual(result.outcome, 'succeeded');
    assert.equal(result.failure, 'verification_unavailable');
  } finally {
    restore();
  }
});
test('failed verification forces repair and cannot become success at repair exhaustion', async () => {
  let checks = 0;
  const items = [
    ...rounds(),
    call('run_verification', {}),
    call('run_verification', {}),
    call('run_verification', {}),
  ];
  const { result, events } = await run(items, {
    verifyOverride: async () => {
      checks++;
      return {
        ...passedReport(),
        ok: false,
        tests: {
          total: 1,
          passed: 0,
          failed: 1,
          results: [{ name: 'readout updates', ok: false, message: 'expected 2, got 0' }],
        },
      };
    },
  });
  assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.failure, 'verification_failed');
  assert.equal(checks, 4);
  assert.ok(!events.some((e) => e.code === 'review_passed'));
  assert.equal(result.report.verification, 'failed');
});
test('reviewer outage is unavailable, not pass, and the private candidate survives', async () => {
  const { result, events } = await run(rounds(), {
    reviewStreamOverride: () => {
      throw new Error('401 unauthorized');
    },
  });
  assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.failure, 'review_unavailable');
  assert.ok(result.artifact);
  assert.ok(!events.some((e) => e.code === 'review_passed'));
});
test('review findings force repair and the two-round limit is independent from validation repairs', async () => {
  const { result } = await run([...rounds(), response(), call('run_verification', {})], {
    reviewStreamOverride: scripted([failedReview(), failedReview()]),
  });
  assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.diagnostics.reviewRounds, 2);
  assert.equal(result.report.review, 'unresolved');
});
test('fresh evidence for a repaired artifact is mandatory before reviewer pass', async () => {
  const { result } = await run(
    [
      ...rounds(),
      call('edit_artifact', {
        name: 'engine.js',
        expectedHash: hash(source),
        oldText: 'time:0',
        newText: 'time:1',
      }),
      response(),
      call('run_verification', {}),
    ],
    { reviewStreamOverride: scripted([failedReview(), passReview()]) },
  );
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.diagnostics.reviewRounds, 2);
});
test('duplicate/batched/wrong tools cannot partially apply work', async () => {
  const batch = { content: [...rounds()[0].content, ...rounds()[1].content] };
  const { result, snapshots } = await run([batch, batch, batch, batch]);
  assert.equal(result.failure, 'tool_protocol');
  assert.ok(!snapshots.some((s) => s.files['engine.js']));
});
test('truncated operations do not execute and retry locally at a bounded larger budget', async () => {
  const all = rounds();
  const budgets = [];
  const script = scripted([{ ...all[0], stopReason: 'length' }, ...all]);
  const { result } = await run([], {
    streamOverride: (m, c, o) => {
      budgets.push(o.maxTokens);
      return script(m, c, o);
    },
  });
  assert.equal(result.outcome, 'succeeded');
  assert.deepEqual(budgets.slice(0, 2), [5000, 10000]);
  assert.equal(result.diagnostics.retries, 1);
});
test('unknown or auth failure is not blindly retried', async () => {
  let calls = 0;
  const { result } = await run([], {
    streamOverride: () => {
      calls++;
      throw new Error('401 unauthorized');
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.failure, 'provider_auth');
});
test('one ledger limits author and reviewer requests together', async () => {
  const { result } = await run(rounds(), { limits: { ...PROTOCOL.limits, requests: 4 } });
  assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.failure, 'review_unavailable');
  assert.equal(result.diagnostics.requests, 4);
});
test('resuming a completed result does not issue a provider call', async () => {
  const { snapshots } = await run();
  const saved = snapshots.at(-1);
  const { result } = await run([], {
    savedState: saved,
    streamOverride: () => {
      throw new Error('must not call');
    },
  });
  assert.equal(result.outcome, 'succeeded');
});
test('restart during inference retains conservative reservation without silently charging again', async () => {
  const { snapshots } = await run();
  const pending = snapshots.find((s) => s.ledger.inflight);
  const { result } = await run([], {
    savedState: pending,
    streamOverride: () => {
      throw new Error('must not replay inference');
    },
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.diagnostics.requests, 1);
});
test('a completed tool operation is replayed without repeating its paid request', async () => {
  const { snapshots } = await run();
  const pending = snapshots.find(
    (s) =>
      s.pendingOperation?.call.name === 'write_artifact' &&
      s.pendingOperation.call.arguments.name === 'engine.js',
  );
  assert.ok(pending && !pending.ledger.inflight);
  assert.equal(pending.files['engine.js'], undefined);
  const { result } = await run(rounds().slice(2), { savedState: pending });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.artifact.moduleCode, source);
  assert.equal(result.diagnostics.requests, 5);
});
test('a completed review is finalized after restart without another review call', async () => {
  const { snapshots } = await run();
  const completed = snapshots.find((s) => s.phase === 'complete' && !s.result);
  const { result } = await run([], {
    savedState: completed,
    reviewStreamOverride: () => {
      throw new Error('must not replay review');
    },
  });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.diagnostics.requests, 5);
});
test('artifact reads/writes are allowlisted, bounded, unique and hash-checked', () => {
  const w = new Workspace();
  assert.throws(() => w.get('../secret'));
  assert.throws(() => w.write('engine.js', 'hello', 'wrong'));
  w.write('engine.js', 'a', hash(''));
  assert.throws(() => w.edit('engine.js', 'missing', 'b', hash('a')));
  w.edit('engine.js', 'a', 'b', hash('a'));
  assert.equal(w.get('engine.js'), 'b');
  assert.throws(() => w.write('engine.js', 'x'.repeat(131073), hash('b')));
});
test('manifest rejects empty assertions, unknown actions and silent truncation', () => {
  for (const manifest of [
    { cases: [{ name: 'empty', steps: [] }] },
    { cases: [{ name: 'fake', steps: [{ action: 'expectText', id: 'value' }] }] },
    { cases: [{ name: 'bad', steps: [{ action: 'bash', id: 'value' }] }] },
    { cases: Array.from({ length: 13 }, () => ({ name: 'x', steps: [] })) },
  ])
    assert.throws(() => validateManifest(manifest));
});
test('bounded UTF-8 report excerpts do not mutate the full checkpoint findings', async () => {
  const defects = Array.from({ length: 8 }, (_, i) => ({
    id: `minor-${i}`,
    severity: 'minor',
    problem: '科'.repeat(600),
    evidence: '学'.repeat(600),
    fix: '実'.repeat(600),
  }));
  const { result, snapshots } = await run(rounds(), {
    reviewStreamOverride: scripted([
      call('review_critique', { verdict: 'pass', summary: 'Minor polish only.', defects }),
    ]),
  });
  assert.equal(result.outcome, 'succeeded');
  assert.ok(Buffer.byteLength(JSON.stringify(result.report)) <= 14000);
  assert.ok(result.report.omitted.findings > 0);
  assert.equal(snapshots.at(-1).review.defects.length, 8);
});
test('unsupported guided content cannot silently pass verified generation', () => {
  assert.throws(
    () => supportedDefinition({ ...definition, assessment: { id: 'q' } }),
    /manual editor/,
  );
  assert.throws(
    () => supportedDefinition({ ...definition, lessons: [{ id: 'l' }] }),
    /manual editor/,
  );
});
test('failing baseline checks cannot be deleted or weakened by a repair', () => {
  const original = { name: 'law', steps: [{ action: 'expectText', id: 'value', equals: '5' }] };
  const w = new Workspace(
    {
      'definition.json': JSON.stringify(definition),
      'engine.js': source,
      'tests.json': '{"cases":[]}',
    },
    [original],
  );
  const artifact = w.artifact(job.simulationId);
  assert.deepEqual(artifact.tests.manifest.cases, [original]);
});
