// Operator/deployment check only. No inference call, credentials or model discovery.
import { readFile } from 'node:fs/promises';
let config;
try {
  config = JSON.parse(await readFile(new URL('./models.json', import.meta.url), 'utf8'));
} catch {
  throw new Error('Bundled worker/models.json is missing or invalid');
}
const response = await fetch('https://openrouter.ai/api/v1/models', {
  redirect: 'error',
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`OpenRouter metadata HTTP ${response.status}`);
const { data } = await response.json();
let failed = false;
for (const model of config.providers['commonlab-openrouter'].models) {
  const remote = data.find((m) => m.id === model.id);
  const image = remote?.architecture?.input_modalities?.includes('image') === true;
  const reasoning = !!remote?.reasoning;
  const mandatory = remote?.reasoning?.mandatory === true;
  const reasoningOk =
    typeof model.reasoning === 'boolean' &&
    model.reasoning === reasoning &&
    (!mandatory || model.thinkingLevelMap?.off === null);
  const ok = !!remote && (!model.input.includes('image') || image) && reasoningOk;
  console.log(
    JSON.stringify({
      id: model.id,
      available: !!remote,
      image,
      reasoning,
      mandatory,
      defaultEffort: remote?.reasoning?.default_effort || null,
      reasoningOk,
      ok,
      checkedAt: new Date().toISOString(),
    }),
  );
  if (!ok) failed = true;
}
if (failed) process.exitCode = 1;
