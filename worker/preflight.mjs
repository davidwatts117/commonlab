import { checkConfiguration } from './runner.mjs';
import { verifyArtifact } from './verify.mjs';
import { GenerationError } from './protocol.mjs';
export const SMOKE_ARTIFACT = {
  definition: {
    id: 'ai-000000000000000000000000',
    title: 'Verification self-test',
    subject: 'physics',
    summary: 'Host-owned self-test.',
    canvas: { id: 'scene', label: 'Scene', width: 640, height: 400 },
    controls: [],
    cards: [],
    graphs: [],
    lessons: [],
  },
  moduleCode: `export function mount(ui){const T=SimLib.Theme.use('light');class S extends SimLib.Simulation{onInit(){this.onReset()}onReset(){this.state={time:0}}onTick(dt){this.state.time+=dt}onDraw(ctx){SimLib.Draw.paper(ctx,640,400,{theme:T});ctx.fillStyle=T.accent;ctx.fillRect(20,20,30,30)}}const app=SimLib.attach({canvas:ui.getElementById('scene'),logicalWidth:640,logicalHeight:400,SimulationClass:S});return {app,inspectState:()=>({...app.sim.state})}}`,
  tests: {
    manifest: {
      cases: [
        { name: 'scene draws', steps: [{ action: 'expectCanvas', id: 'scene', nonBlank: true }] },
      ],
    },
  },
};
export async function preflight() {
  checkConfiguration();
  const r = await verifyArtifact(SMOKE_ARTIFACT, { timeoutMs: 20000 });
  if (!r.ok) throw new GenerationError('verification_unavailable');
  return true;
}
