import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { generate } from '../runner.mjs';

test('OpenRouter MiMo resolves from the pinned catalog and finalizes with dedicated tools', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, { CL_MODEL_PROVIDER: 'openrouter', CL_MODEL_ID: 'xiaomi/mimo-v2.6-flash', CL_MODEL_API_KEY: 'test-only-never-sent' });
  const simulationId = 'ai-012345678901234567890123';
  const definition = { id: simulationId, title: 'Test', subject: 'physics', summary: 'Test draft.', canvas: { id: 'scene', label: 'Scene', width: 640, height: 400 }, controls: [], cards: [], graphs: [], lessons: [] };
  try {
    const result = await generate({ prompt: 'Test draft', simulationId }, {
      streamOverride(model, context, options) {
        assert.equal(model.provider, 'openrouter');
        assert.equal(model.id, 'xiaomi/mimo-v2.6-flash');
        assert.equal(model.baseUrl, 'https://openrouter.ai/api/v1');
        assert.equal(options.maxTokens, 8192);
        const tools = context.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded || []);
        assert.deepEqual(tools.map(tool => tool.name).sort(), ['authoring_reference', 'finish_draft', 'validate_draft']);
        const message = { role: 'assistant', content: [{ type: 'toolCall', id: 'finish-1', name: 'finish_draft', arguments: { definitionJson: JSON.stringify(definition), moduleCode: 'export function mount(ui) { return { app: {} }; }' } }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: Date.now() };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: 'toolUse', message }); stream.end(); return stream;
      },
    });
    assert.equal(result.model, 'openrouter/xiaomi/mimo-v2.6-flash');
    assert.equal(result.artifact.definition.id, simulationId);
  } finally {
    for (const name of ['CL_MODEL_PROVIDER', 'CL_MODEL_ID', 'CL_MODEL_API_KEY']) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});
