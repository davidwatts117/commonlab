// One explicit OpenAI-compatible provider definition for OpenRouter.
// Keeping the catalog static avoids provider-specific model discovery and makes
// image support, context and pricing reviewable in source control.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export const MODELS_PATH = fileURLToPath(new URL('./models.json', import.meta.url));

export async function createRuntimeForModel({ dir, provider, modelId, apiKey }) {
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: MODELS_PATH,
    // The catalog is read-only in the worker image; keep pi's store in the job temp dir.
    modelsStorePath: join(dir, 'models-store.json'),
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey(provider, apiKey);
  return { runtime, model: runtime.getModel(provider, modelId) };
}
