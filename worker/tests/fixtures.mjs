import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { SMOKE_ARTIFACT } from '../preflight.mjs';
import { hash } from '../checkpoints.mjs';
export const simulationId = SMOKE_ARTIFACT.definition.id;
export const job = { id: 42, prompt: 'A simple motion lab.', simulationId };
export const definition = SMOKE_ARTIFACT.definition,
  source = SMOKE_ARTIFACT.moduleCode;
export const design = {
  summary: 'Motion lab',
  physics: ['x=v*t'],
  assumptions: ['constant speed'],
  checks: ['Reset restores time zero.'],
  definition,
};
export const call = (name, args) => ({
  content: [{ type: 'toolCall', name, arguments: args, id: name }],
});
export function rounds() {
  return [
    call('design_simulation', design),
    call('write_artifact', { name: 'engine.js', expectedHash: hash(''), content: source }),
    call('write_artifact', {
      name: 'tests.json',
      expectedHash: hash(''),
      content: JSON.stringify(SMOKE_ARTIFACT.tests.manifest),
    }),
    call('run_verification', {}),
  ];
}
export const passReview = () =>
  call('review_critique', { verdict: 'pass', summary: 'No major defects.', defects: [] });
export const failedReview = () =>
  call('review_critique', {
    verdict: 'fail',
    summary: 'A scientific defect.',
    defects: [
      {
        id: 'period',
        severity: 'major',
        problem: 'Period ignores mass.',
        evidence: 'Equation in onTick.',
        fix: 'Correct equation and add independent test.',
      },
    ],
  });
export const passedReport = () => ({
  ok: true,
  infrastructure: false,
  runtimeErrors: [],
  consoleErrors: [],
  tests: { total: 1, passed: 1, failed: 0, results: [{ name: 'motion', ok: true }] },
  canvases: [],
  warnings: [],
  screenshots: [
    {
      label: 'initial',
      viewport: { width: 10, height: 10 },
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH9sAAAAASUVORK5CYII=',
    },
  ],
  durationMs: 5,
});
export function streamMessage(model, round) {
  const message = {
    role: 'assistant',
    content: round.content || [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: round.stopReason || 'toolUse',
    errorMessage: round.errorMessage,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === 'error')
    stream.push({ type: 'error', reason: 'error', error: message });
  else stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end();
  return stream;
}
export function modelEnvironment() {
  const keys = [
    'CL_MODEL_PROVIDER',
    'CL_MODEL_ID',
    'CL_MODEL_API_KEY',
    'CL_REVIEW_MODEL_PROVIDER',
    'CL_REVIEW_MODEL_ID',
    'CL_REVIEW_MODEL_API_KEY',
    'CL_REVIEW_IMAGES',
    'CL_MODEL_REASONING_EFFORT',
    'CL_REVIEW_REASONING_EFFORT',
  ];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    CL_MODEL_PROVIDER: 'openrouter',
    CL_MODEL_ID: 'xiaomi/mimo-v2.6-flash',
    CL_MODEL_API_KEY: 'test-only-never-sent',
    CL_REVIEW_MODEL_ID: 'deepseek/deepseek-v4.1-flash-1017',
    CL_REVIEW_IMAGES: '1',
    CL_MODEL_REASONING_EFFORT: 'low',
    CL_REVIEW_REASONING_EFFORT: '',
  });
  return () => {
    for (const k of keys)
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
  };
}
export const scripted = (items) => {
  let index = 0;
  return (model) => {
    if (index >= items.length) throw new Error('Unexpected extra request');
    return streamMessage(model, items[index++]);
  };
};
