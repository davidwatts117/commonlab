import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeForModel } from '../models.mjs';
test('the static OpenRouter provider resolves every configured model and exposes image support', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commonlab-models-'));
  try {
    for (const id of [
      'deepseek/deepseek-v4.1-flash',
      'deepseek/deepseek-v4.1-flash-1017',
      'xiaomi/mimo-v2.6-flash',
      'openai/gpt-6.1-sol',
    ]) {
      const { model } = await createRuntimeForModel({
        dir,
        provider: 'openrouter',
        modelId: id,
        apiKey: 'test-only-not-sent',
      });
      assert.equal(model?.id, id);
      assert.equal(model?.api, 'openai-completions');
      assert.match(model?.baseUrl, /openrouter\.ai\/api\/v1$/);
      assert.ok(model?.input.includes('image'), `${id} must declare image input`);
      assert.ok(model?.contextWindow > 0);
      assert.ok(model?.maxTokens > 0);
    }
    await assert.rejects(
      createRuntimeForModel({
        dir,
        provider: 'openrouter',
        modelId: 'vendor/not-listed',
        apiKey: 'test-only-not-sent',
      }),
      (e) => e.code === 'configuration_error',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
