import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { GenerationError } from './protocol.mjs';
export const MODELS_PATH = fileURLToPath(new URL('./models.json', import.meta.url));
function config() {
  try {
    return JSON.parse(readFileSync(MODELS_PATH, 'utf8'));
  } catch {
    throw new GenerationError('configuration_error');
  }
}
export function configuredModel(provider, modelId) {
  const name = provider === 'openrouter' ? 'commonlab-openrouter' : provider;
  const entry = config().providers[name];
  const model = entry?.models?.find((m) => m.id === modelId);
  if (
    !entry ||
    !model ||
    entry.api !== 'openai-completions' ||
    entry.baseUrl !== 'https://openrouter.ai/api/v1' ||
    !Array.isArray(model.input) ||
    !model.input.includes('text') ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow < 1024 ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens < 256 ||
    model.maxTokens > model.contextWindow ||
    !['input', 'output', 'cacheRead', 'cacheWrite'].every(
      (key) => Number.isFinite(model.cost?.[key]) && model.cost[key] >= 0,
    )
  )
    throw new GenerationError('configuration_error');
  return { provider: name, ...model, api: entry.api, baseUrl: entry.baseUrl };
}
export async function createRuntimeForModel({ dir, provider, modelId, apiKey }) {
  const configured = configuredModel(provider, modelId);
  if (!apiKey) throw new GenerationError('configuration_error');
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: MODELS_PATH,
    modelsStorePath: join(dir, 'models-store.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  await runtime.setRuntimeApiKey(configured.provider, apiKey);
  const model = runtime.getModel(configured.provider, modelId);
  if (!model) throw new GenerationError('configuration_error');
  return { runtime, model };
}
