// Real locked SDK and OpenAI wire conversion; only HTTP transport is replaced.
// No provider request, inference, credentials or private thinking text is logged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { createRuntimeForModel, configuredModel, configuredReasoning } from '../models.mjs';
import { ModelCaller, emptyLedger } from '../model-call.mjs';
import { PROTOCOL, safeDetails } from '../protocol.mjs';
test('reasoning settings default low, inherit by role, and reject unsupported effort before spending', () => {
  const model = configuredModel('openrouter', 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(configuredReasoning(model, 'author', {}), 'low');
  assert.equal(
    configuredReasoning(model, 'reviewer', { CL_MODEL_REASONING_EFFORT: 'high' }),
    'high',
  );
  assert.equal(
    configuredReasoning(model, 'reviewer', {
      CL_MODEL_REASONING_EFFORT: 'off',
      CL_REVIEW_REASONING_EFFORT: 'max',
    }),
    'max',
  );
  for (const level of ['typo', 'medium', 'minimal'])
    assert.throws(
      () => configuredReasoning(model, 'author', { CL_MODEL_REASONING_EFFORT: level }),
      (e) => e.code === 'configuration_error',
    );
  const mandatory = configuredModel('openrouter', 'openai/gpt-6.1-sol');
  assert.equal(
    configuredReasoning(mandatory, 'author', { CL_MODEL_REASONING_EFFORT: 'off' }),
    'low',
  );
});
for (const effort of ['low', 'high', 'max'])
  test(`configured reasoning reaches actual HTTP payload: ${effort}`, async () => {
    await fixture(
      'deepseek/deepseek-v4.1-flash-1017',
      async ({ caller, payloads, events }) => {
        await caller.call({ system: 'Offline test', prompt: 'Return finish', tools: [tool] });
        assert.equal(payloads[0].reasoning.effort, effort);
        assert.equal(
          payloads[0].max_completion_tokens ?? payloads[0].max_tokens,
          PROTOCOL.limits.buildTokens,
        );
        assert.equal(
          events.find((e) => e.code === 'model_request').details.reasoningEffort,
          effort,
        );
      },
      effort,
    );
  });
const hidden = 'PRIVATE_SYNTHETIC_THINKING_NEVER_LOG';
const tool = {
  name: 'finish',
  label: 'Finish',
  description: 'Return the small completed operation.',
  parameters: Type.Object({ ok: Type.Boolean() }),
};
function response(stopReason = 'tool_calls', reasoning = 0) {
  const frame = (delta, finish_reason = null) => ({
    id: 'offline-test',
    choices: [{ index: 0, delta, finish_reason }],
  });
  const frames = [];
  if (reasoning) frames.push(frame({ role: 'assistant', reasoning: hidden }));
  frames.push(
    frame({
      tool_calls: [
        {
          index: 0,
          id: 'operation',
          type: 'function',
          function: { name: 'finish', arguments: '{"ok":true}' },
        },
      ],
    }),
  );
  frames.push({
    ...frame({}, stopReason),
    usage: {
      prompt_tokens: 10,
      completion_tokens: 12,
      completion_tokens_details: { reasoning_tokens: reasoning },
      total_tokens: 22,
    },
  });
  return new Response(
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
async function fixture(modelId, run, reasoningEffort = 'off') {
  const dir = await mkdtemp(join(tmpdir(), 'commonlab-reasoning-'));
  try {
    const { runtime, model } = await createRuntimeForModel({
      dir,
      provider: 'openrouter',
      modelId,
      apiKey: 'test-only-not-sent',
    });
    const payloads = [],
      events = [],
      ledger = emptyLedger();
    let nextResponse = () => response(),
      operations = 0;
    const caller = new ModelCaller({
      runtime,
      model,
      dir,
      ledger,
      deadlineAt: Date.now() + 60000,
      reasoningEffort,
      onOperation: () => operations++,
      emit: (code, details) => events.push({ code, details: safeDetails(details) }),
      streamOverride: (m, c, o) =>
        streamSimple(m, c, {
          ...o,
          apiKey: 'test-only-not-sent',
          fetch: async (input, init) => {
            const body = typeof init?.body === 'string' ? init.body : await input.clone().text();
            payloads.push(JSON.parse(body));
            return nextResponse();
          },
        }),
    });
    await run({
      caller,
      model,
      ledger,
      payloads,
      events,
      setResponse: (f) => (nextResponse = f),
      operations: () => operations,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
for (const id of [
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4.1-flash-1017',
  'xiaomi/mimo-v2.6-flash',
  'xiaomi/mimo-v2.6-pro',
  'openai/gpt-6.1-sol',
]) {
  test(`actual wire request controls reasoning for author AND reviewer: ${id}`, async () => {
    await fixture(id, async ({ caller, model, payloads }) => {
      assert.equal(model.reasoning, true);
      for (const role of ['author', 'reviewer']) {
        const result = await caller.call({
          system: 'Offline adapter test.',
          prompt: 'Return one finish operation.',
          tools: [tool],
          role,
          targetTokens: 5000,
        });
        assert.deepEqual(result.arguments, { ok: true });
      }
      assert.equal(payloads.length, 2);
      for (const body of payloads) {
        assert.equal(body.reasoning?.effort, id === 'openai/gpt-6.1-sol' ? 'low' : 'none');
        assert.equal(body.max_completion_tokens ?? body.max_tokens, 5000);
      }
    });
  });
}
test('a terminated partial SSE stream is retryable but never executes an incomplete operation', async () => {
  await fixture(
    'deepseek/deepseek-v4.1-flash-1017',
    async ({ caller, ledger, setResponse, operations }) => {
      setResponse(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ id: 'offline', choices: [{ index: 0, delta: { role: 'assistant', reasoning: hidden } }] })}\n\n`,
                  ),
                );
                setTimeout(() => controller.error(new Error('terminated')), 10);
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      );
      await assert.rejects(
        caller.call({
          system: 'Offline',
          prompt: 'Return finish',
          tools: [tool],
          targetTokens: 5000,
        }),
        (e) => e.code === 'provider_unavailable' && e.retryable === true,
      );
      assert.equal(operations(), 0);
      assert.equal(ledger.outputTokens, 5000);
      assert.ok(ledger.thinkingBytes > 0);
    },
  );
});
test('an error after streaming cannot refund an ambiguous call as zero usage', async () => {
  await fixture(
    'deepseek/deepseek-v4.1-flash-1017',
    async ({ caller, ledger, events, setResponse }) => {
      setResponse(() => response('unsupported_finish_reason', 8));
      await assert.rejects(
        caller.call({
          system: 'Offline test',
          prompt: 'Return finish',
          tools: [tool],
          targetTokens: 5000,
        }),
      );
      assert.equal(ledger.outputTokens, 5000);
      assert.equal(
        ledger.costMicros,
        events.find((e) => e.code === 'model_request').details.costMicros,
      );
      assert.ok(ledger.thinkingBytes > 0);
    },
  );
});
test('length recovery keeps reasoning off, counts reported thinking without double charging, and does not expose text', async () => {
  await fixture(
    'deepseek/deepseek-v4.1-flash-1017',
    async ({ caller, ledger, payloads, events, setResponse, operations }) => {
      setResponse(() => response('length', 8));
      const options = {
        system: 'Offline adapter test.',
        prompt: 'Return one finish operation.',
        tools: [tool],
        targetTokens: 5000,
      };
      await assert.rejects(caller.call(options), (e) => e.code === 'output_truncated');
      assert.equal(operations(), 0, 'truncated tools must never execute');
      setResponse(() => response('tool_calls', 2));
      await caller.call({ ...options, targetTokens: 10000 });
      assert.equal(operations(), 1);
      assert.deepEqual(
        payloads.map((b) => b.reasoning),
        [{ effort: 'none' }, { effort: 'none' }],
      );
      assert.equal(
        ledger.outputTokens,
        24,
        'reported reasoning is already part of completion tokens',
      );
      assert.equal(ledger.reportedReasoningTokens, 10);
      assert.ok(ledger.thinkingBytes > 0);
      assert.ok(ledger.answerBytes > 0);
      assert.equal(
        events.filter((e) => e.code === 'model_finished').at(-1).details.reportedReasoningTokens,
        10,
      );
      assert.ok(!JSON.stringify({ events, ledger }).includes(hidden));
    },
  );
});
