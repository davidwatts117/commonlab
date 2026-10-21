import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../runner.mjs';
import { DraftWorkflow } from '../workflow.mjs';
import { DraftValidationError, LIMITS, validateDraft } from '../policy.mjs';
import { safeDetails, safeEvent } from '../protocol.mjs';
import { job, simulationId, definition, plan, source, call, planRound, definitionRound, engineRound, streamMessage, modelEnvironment, checks } from './fixtures.mjs';

async function run(rounds, options = {}) {
  const restore = modelEnvironment();
  const events = [], traces = []; let calls = 0;
  try {
    const result = await generate(options.job || job, {
      ...options,
      streamOverride(model, context, streamOptions) {
        const index = calls++; options.inspect?.(context, index, streamOptions);
        assert.ok(index < rounds.length, 'Unexpected extra model request');
        if (rounds[index] instanceof Error) throw rounds[index];
        return streamMessage(model, rounds[index]);
      },
      onProgress: (code, details) => events.push({ code, details }), onTrace: (kind, data) => traces.push({ kind, data }),
    });
    return { result, events, traces, calls };
  } finally { restore(); }
}
const start = () => [planRound(), definitionRound()];
const badSource = 'export function mount(ui) { const = ; }';

test('guided stages expose exactly one relevant tool and retain accepted development work', async () => {
  const { result, calls, events, traces } = await run([...start(), engineRound()], {
    inspect(context, index) {
      const tools = context.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded || []);
      assert.deepEqual(tools.map(tool => tool.name), [['plan_simulation'], ['define_simulation'], ['submit_draft']][index]);
      assert.equal(context.messages.filter(message => message.role === 'assistant').length, 0);
      const text = JSON.stringify(context);
      if (index === 1) { assert.ok(text.includes('spring lab')); assert.ok(text.includes('$defs')); }
      if (index === 2) { assert.ok(text.includes('scene')); assert.ok(text.includes('F = -kx')); }
    },
  });
  assert.equal(calls, 3); assert.equal(result.artifact.definition.title, 'Spring');
  assert.equal(result.diagnostics.validations, 3); assert.equal(result.diagnostics.phase, 'implementation');
  assert.equal(events.filter(event => event.code === 'stage_completed').length, 2);
  assert.ok(traces.some(trace => trace.kind === 'tool_end' && trace.data.name === 'submit_draft'));
});

test('there is no reference-reading loop: obsolete reference tools are blocked with explicit stage guidance', async () => {
  const read = { content: [call('authoring_reference', { section: 'schema' })] };
  const { result, traces } = await run([read, planRound(), definitionRound(), engineRound()], {
    inspect(context, index) { if (index === 1) assert.ok(JSON.stringify(context).includes('ONLY available tool')); },
  });
  assert.equal(result.diagnostics.validations, 3);
  assert.ok(traces.some(trace => trace.kind === 'message' && trace.data.message.role === 'toolResult' && trace.data.message.isError));
  await assert.rejects(run([read, read]), error => error.code === 'tool_protocol' && error.diagnostics.validations === 0);
});

test('definition mistakes are repaired before engine development and host assigns bookkeeping IDs', async () => {
  const invalid = { ...definition, title: '' };
  const withoutId = structuredClone(definition); delete withoutId.id;
  const { result, events } = await run([planRound(), definitionRound(invalid), definitionRound(withoutId), engineRound()]);
  assert.equal(result.artifact.definition.id, simulationId);
  assert.ok(events.find(event => event.code === 'validation_failed').details.issues.some(issue => issue.path === '/title'));
});

test('engine repair can adjust the definition explicitly while preserving plan and other accepted work', async () => {
  const { result } = await run([...start(), engineRound(badSource), { content: [call('submit_draft', { moduleCode: source, tests: checks, definition: { ...definition, title: 'Revised spring' } })] }], {
    inspect(context, index) { if (index === 3) { const text = JSON.stringify(context); assert.ok(text.includes('syntax error')); assert.ok(text.includes('previousRejectedResult')); } },
  });
  assert.equal(result.artifact.definition.title, 'Revised spring');
});

test('50-call batch is rejected atomically and never replayed into subsequent provider context', async () => {
  const sizes = [];
  const flood = { content: Array.from({ length: 50 }, (_, i) => call('plan_simulation', plan, `bad-${i}`)) };
  const { result, events } = await run([flood, ...start(), engineRound()], { inspect: context => sizes.push(JSON.stringify(context).length) });
  assert.equal(result.diagnostics.validations, 3);
  assert.equal(events.filter(event => event.code === 'validating').length, 3);
  assert.ok(sizes[1] < sizes[0] + 1500);
  assert.ok(events.some(event => event.code === 'tool_batch_rejected'));
});

test('even a valid first result is not accepted from a multi-call batch', async () => {
  const batch = { content: [call('plan_simulation', plan), call('plan_simulation', plan, 'second')] };
  await assert.rejects(run([batch, batch]), error => error.code === 'tool_protocol' && error.diagnostics.validations === 0);
});

test('duplicate invalid engine results use cached feedback and stop without repeated validation', async () => {
  await assert.rejects(run([...start(), engineRound(badSource), engineRound(badSource), engineRound(badSource)]), error => error.code === 'no_progress' && error.diagnostics.validations === 3 && error.diagnostics.duplicates === 2);
});

test('four distinct rejected results exhaust repairs, successful stages do not', async () => {
  const attempts = Array.from({ length: 4 }, (_, i) => engineRound(`${badSource}\n// attempt ${i}`));
  await assert.rejects(run([...start(), ...attempts]), error => error.code === 'repair_limit' && error.diagnostics.validations === 6 && error.diagnostics.issues[0].rule === 'javascript_syntax');
});

test('truncated calls never execute and each one raises the output budget', async () => {
  const truncated = { ...planRound(), stopReason: 'length' };
  const budgets = [];
  const { result, events } = await run([truncated, ...start(), engineRound()], { inspect: (_context, _index, options) => budgets.push(options.maxTokens) });
  assert.equal(result.diagnostics.validations, 3);
  assert.equal(events.filter(event => event.code === 'validating').length, 3);
  assert.deepEqual(budgets.slice(0, 3), [4096, 8192, 32768]);
  assert.ok(events.some(event => event.code === 'model_request' && event.details.maxTokens === 8192));
  await assert.rejects(run([truncated, truncated, truncated]), error => error.code === 'output_truncated' && error.diagnostics.validations === 0);
});

test('provider and host-budget errors preserve categories rather than reporting not-finalized', async () => {
  for (const [message, expected] of [['401 unauthorized secret-key', 'provider_auth'], ['429 billing secret-key', 'provider_rate_limit'], ['503 overloaded secret-key', 'provider_unavailable'], ['Something broke secret-key', 'provider_error']]) {
    await assert.rejects(run([{ stopReason: 'error', errorMessage: message }]), error => error.code === expected && !JSON.stringify(error).includes('secret-key'));
  }
  await assert.rejects(run([new Error('401 unauthorized secret-key')]), error => error.code === 'provider_auth');
  await assert.rejects(run([], { limits: { ...LIMITS, contextBytes: 1 } }), error => error.code === 'context_limit' && error.diagnostics.requests === 0);
  await assert.rejects(run([planRound()], { limits: { ...LIMITS, requests: 1 } }), error => error.code === 'request_limit' && error.diagnostics.requests === 1);
});

test('malformed stage arguments include actual SDK feedback in the next request and trace', async () => {
  const malformed = { content: [call('plan_simulation', { summary: 'Missing the arrays.' })] };
  const { result, traces } = await run([malformed, ...start(), engineRound()], {
    inspect(context, index) { if (index === 1) assert.ok(JSON.stringify(context).includes('Actual tool feedback')); },
  });
  assert.equal(result.diagnostics.validations, 3);
  assert.ok(traces.some(trace => trace.kind === 'message' && trace.data.message.role === 'toolResult' && trace.data.message.isError));
});

test('prose-only runs stop with phase-specific no-progress diagnostics', async () => {
  await assert.rejects(run([{ stopReason: 'stop', content: [{ type: 'text', text: 'I am done.' }] }, { stopReason: 'stop' }]), error => error.code === 'no_progress' && error.diagnostics.phase === 'plan');
});

test('operator-configurable prompts above 8000 bytes reach all stages; hard upper bound remains 64000', async () => {
  const { result } = await run([...start(), engineRound()], { job: { ...job, prompt: 'x'.repeat(9000) } });
  assert.equal(result.diagnostics.requests, 3);
  await assert.rejects(run([], { job: { ...job, prompt: 'x'.repeat(64001) } }), error => error.code === 'worker_error');
});

test('diagnostics select the matching component branch and redact arbitrary generated values', () => {
  const draft = { definition: { ...definition, controls: [{ type: 'slider', id: 'mass', label: 'Mass', min: 0, max: 10, step: 1 }] }, moduleCode: source };
  assert.throws(() => validateDraft(draft, simulationId), error => error instanceof DraftValidationError && error.issues.some(issue => issue.path === '/controls/0/value') && !error.message.includes('buttons'));
  const privateKey = 'secret-arbitrary-info-key';
  assert.throws(() => validateDraft({ ...draft, definition: { ...definition, info: { [privateKey]: { title: 123 } } } }, simulationId), error => !JSON.stringify(error.issues).includes(privateKey));
  assert.deepEqual(safeDetails({ apiKey: 'secret', stopReason: 'raw-secret', issues: [{ path: '/', rule: 'raw-secret' }], requests: -1 }), { issues: [] });
  assert.equal(safeEvent({ code: 'secret' }), null);
});

test('stage rejection is an actual error tool result; successful stages require the next specific tool', () => {
  const flow = new DraftWorkflow(job); flow.begin();
  assert.equal(flow.submit({ summary: '' }).isError, true);
  flow.begin(); assert.equal(flow.submit(plan).isError, false);
  assert.equal(flow.toolName, 'define_simulation');
  flow.begin(); assert.equal(flow.submit({ definition }).isError, false);
  assert.equal(flow.toolName, 'submit_draft');
  flow.begin(); const result = flow.submit({ moduleCode: source }); assert.equal(result.isError, false); assert.equal(result.terminate, true);
});

const passedReport = () => ({ ok: true, runtimeErrors: [], consoleErrors: [], tests: { total: 1, passed: 1, failed: 0, results: [{ name: 'check', ok: true }] }, canvases: [{ id: 'scene', blank: false, distinctColors: 12 }], warnings: [], screenshots: [], durationMs: 5, summary: {} });
test('a failed headless verification reopens engine work with concrete feedback', async () => {
  let verifications = 0;
  const verifyOverride = async () => {
    if (verifications++ === 0) return { ok: false, runtimeErrors: [], consoleErrors: [], tests: { total: 1, passed: 0, failed: 1, results: [{ name: 'readout updates', ok: false, message: 'expected 2.0, got 0.0' }] }, canvases: [{ id: 'scene', blank: true, distinctColors: 1 }], warnings: [], screenshots: [], durationMs: 5, summary: {} };
    return passedReport();
  };
  const { result, calls, events } = await run([...start(), engineRound(), engineRound()], {
    verifyOverride,
    inspect(context, index) {
      if (index === 3) {
        const text = JSON.stringify(context);
        assert.match(text, /Headless verification FAILED/);
        assert.match(text, /readout updates/);
        assert.ok(text.includes('previousRejectedResult'));
      }
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.artifact.definition.id, simulationId);
  assert.equal(verifications, 2);
  assert.ok(events.some(event => event.code === 'visual_check_failed'));
  assert.ok(events.some(event => event.code === 'visual_check_passed'));
  assert.ok(events.some(event => event.code === 'finalized'));
});
test('an adversarial review can force a repair round and is skipped without a reviewer model', async () => {
  let reviews = 0;
  const reviewOverride = async () => {
    if (reviews++ === 0) return { ok: true, verdict: 'fail', summary: 'The period is wrong.', defects: [{ severity: 'major', area: 'physics', problem: 'Period ignores mass.', evidence: 'Screenshot and test report.', fix: 'Use sqrt(m/k).' }], durationMs: 5 };
    return { ok: true, verdict: 'pass', summary: 'No blocking defects.', defects: [], durationMs: 5 };
  };
  const { result, calls, events } = await run([...start(), engineRound(), engineRound()], {
    verifyOverride: async () => passedReport(),
    reviewOverride,
    inspect(context, index) {
      if (index === 3) {
        const text = JSON.stringify(context);
        assert.match(text, /INDEPENDENT ADVERSARIAL REVIEW/);
        assert.match(text, /Period ignores mass/);
      }
    },
  });
  assert.equal(calls, 4);
  assert.equal(reviews, 2);
  assert.equal(result.artifact.definition.id, simulationId);
  assert.ok(events.some(event => event.code === 'review_failed'));
  assert.ok(events.some(event => event.code === 'review_passed'));
});
