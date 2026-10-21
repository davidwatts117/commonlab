import test from 'node:test';
import assert from 'node:assert/strict';
import { planRound, definitionRound, engineRound, streamMessage } from './fixtures.mjs';
import { generate } from '../runner.mjs';

test('OpenRouter MiMo resolves from the pinned catalog and finalizes with dedicated tools', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, { CL_MODEL_PROVIDER: 'openrouter', CL_MODEL_ID: 'xiaomi/mimo-v2.6-flash', CL_MODEL_API_KEY: 'test-only-never-sent' });
  const simulationId = 'ai-012345678901234567890123';
  let calls = 0;
  try {
    const result = await generate({ prompt: 'Test draft', simulationId }, {
      streamOverride(model, context, options) {
        assert.equal(model.provider, 'openrouter');
        assert.equal(model.id, 'xiaomi/mimo-v2.6-flash');
        assert.equal(model.baseUrl, 'https://openrouter.ai/api/v1');
        assert.equal(options.maxTokens, [4096, 16384, 32768][calls]);
        const tools = context.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded || []);
        assert.deepEqual(tools.map(tool => tool.name), [['plan_simulation'], ['define_simulation'], ['submit_draft']][calls]);
        return streamMessage(model, [planRound(), definitionRound(), engineRound()][calls++]);
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
