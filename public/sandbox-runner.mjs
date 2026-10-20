// Runs inside a sandboxed, opaque-origin frame: no cookies, storage, host DOM or network.
// It renders the trusted shell and mounts engine source supplied by the authoring page.
import { renderSimulation } from '/simulation-ui.mjs';

const root = document.getElementById('sandbox-root');
const status = document.getElementById('sandbox-status');
let ui, controller, heightObserver, mounted = false;

function tell(type, extra = {}) { parent.postMessage({ type, ...extra }, '*'); }
function report(text, error = false) {
  status.textContent = text;
  status.setAttribute('role', error ? 'alert' : 'status');
  tell(error ? 'commonlab:error' : 'commonlab:status', { message: text.slice(0, 600) });
}
function stop() {
  mounted = false;
  heightObserver?.disconnect(); heightObserver = undefined;
  try { controller?.app?.sim?.stop?.(); } catch { /* engine teardown is untrusted */ }
  try { controller?.destroy?.(); } catch { /* ignore */ }
  ui?.destroy(); ui = undefined; controller = undefined;
  root.replaceChildren();
}
function measure() {
  const height = Math.ceil(root.getBoundingClientRect().height + 24);
  tell('commonlab:height', { height: Math.min(Math.max(height, 240), 4000) });
}

addEventListener('error', event => { if (mounted) report(`Engine error: ${event.message}`, true); });
addEventListener('unhandledrejection', event => { if (mounted) report(`Engine error: ${event.reason?.message || 'unhandled rejection'}`, true); });

async function run(message) {
  stop();
  const { definition, moduleCode, engineId } = message;
  if (!definition || typeof definition !== 'object') return report('No validated definition was supplied.', true);
  if (!engineId && typeof moduleCode !== 'string') return report('No engine source was supplied.', true);
  status.hidden = false;
  report('Starting the isolated preview…');
  try {
    ui = renderSimulation(root, definition, { idPrefix: 'sandbox-preview-' });
  } catch (error) {
    return report(`Definition could not be rendered: ${error.message}`, true);
  }
  try {
    // Installed engines are served by the app; author source runs from an inert blob module.
    const module = engineId
      ? await import(`/simulations/${encodeURIComponent(engineId)}.js`)
      : await import(URL.createObjectURL(new Blob([moduleCode], { type: 'text/javascript' })));
    if (typeof module.mount !== 'function') throw new Error('The engine must export mount(ui).');
    controller = module.mount(ui);
    if (!controller?.app?.sim) throw new Error('mount(ui) must return { app } with a simulation.');
    controller.app.sim.start();
  } catch (error) {
    stop();
    return report(`The engine failed to start: ${error.message}`, true);
  }
  mounted = true;
  status.hidden = true;
  tell('commonlab:running');
  heightObserver = new ResizeObserver(measure);
  heightObserver.observe(root);
  measure();
}

addEventListener('message', event => {
  // Only the embedding page may drive this frame.
  if (event.source !== parent) return;
  const message = event.data;
  if (!message || message.type !== 'commonlab:run') return;
  run(message).catch(error => { stop(); report(`Preview failed: ${error.message}`, true); });
});

tell('commonlab:ready');
