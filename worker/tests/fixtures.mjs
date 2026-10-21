import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export const simulationId = 'ai-012345678901234567890123';
export const job = { id: 42, prompt: 'A small spring simulation.', simulationId };
export const definition = { id: simulationId, title: 'Spring', subject: 'physics', summary: 'Explore a spring.', canvas: { id: 'scene', label: 'Scene', width: 640, height: 400 }, controls: [], cards: [], graphs: [], lessons: [] };
export const plan = { summary: 'A spring lab.', physics: ['F = -kx; a = F/m'], state: ['position and velocity'], controls: ['mass and reset'], assumptions: ['ideal spring'], checks: ['Reset restores initial displacement; period grows with sqrt(m).'] };
export const source = 'export function mount(ui) { return { app: {} }; }';
export const call = (name, args, id = name) => ({ type: 'toolCall', name, arguments: args, id });
export const planRound = () => ({ content: [call('plan_simulation', plan)] });
export const definitionRound = (def = definition) => ({ content: [call('define_simulation', { definition: def })] });
export const checks = { manifest: { cases: [{ name: 'mounts', steps: [{ action: 'expectCanvas', id: 'scene', nonBlank: true }] }] }, module: '' };
export const engineRound = (moduleCode = source, tests = checks) => ({ content: [call('submit_draft', { moduleCode, tests })] });
export function streamMessage(model, round) {
  const message = { role: 'assistant', content: round.content || [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: round.stopReason || 'toolUse', errorMessage: round.errorMessage, timestamp: Date.now() };
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
  else stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end(); return stream;
}
export function modelEnvironment() {
  const before = { ...process.env };
  Object.assign(process.env, { CL_MODEL_PROVIDER: 'openai', CL_MODEL_ID: 'gpt-4.1', CL_MODEL_API_KEY: 'test-only-not-sent' });
  return () => {
    for (const key of ['CL_MODEL_PROVIDER', 'CL_MODEL_ID', 'CL_MODEL_API_KEY']) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  };
}
