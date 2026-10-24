import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeForModel, configuredModel } from '../models.mjs';
test('operator OpenRouter setting maps to a distinct strict OpenAI-compatible provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commonlab-provider-'));
  try {
    const { model } = await createRuntimeForModel({
      dir,
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4.1-flash-1017',
      apiKey: 'test-only',
    });
    assert.equal(model.provider, 'commonlab-openrouter');
    assert.equal(model.api, 'openai-completions');
    assert.equal(model.baseUrl, 'https://openrouter.ai/api/v1');
    assert.ok(model.input.includes('image'));
    assert.throws(() => configuredModel('openrouter', 'auto'));
    assert.throws(() => configuredModel('openai', 'gpt-4.1'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
