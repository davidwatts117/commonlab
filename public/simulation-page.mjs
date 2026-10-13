import { loadCatalog } from './simulation-schema.mjs';
import { renderSimulation, mountLearning } from './simulation-ui.mjs';

const status = document.getElementById('simulation-status');
const root = document.getElementById('simulation-root');
let ui, controller, learning;
try {
  const catalog = await loadCatalog();
  // Axum serves this same file for both canonical and old bookmarked URLs.
  const match = /^\/simulations\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\.html)?$/.exec(location.pathname);
  // Query form also works when public/ is hosted by a plain static server.
  const id = match?.[1] || new URLSearchParams(location.search).get('id');
  const definition = catalog.simulations.find(sim => sim.id === id);
  if (!definition) throw new Error('This simulation is not in the catalog.');

  document.title = `${definition.title} — CommonLab`;
  document.querySelector('meta[name="description"]').content = definition.summary;
  document.getElementById('simulation-title').textContent = definition.title;
  document.getElementById('simulation-summary').textContent = definition.summary;
  ui = renderSimulation(root, definition);
  root.hidden = false;
  // The path is derived from a validated catalog id; data cannot supply arbitrary script URLs.
  const module = await import(`/simulations/${definition.id}.js`);
  if (typeof module.mount !== 'function') throw new Error('Simulation module must export mount(ui).');
  controller = module.mount(ui);
  if (!controller?.app?.sim) throw new Error('Simulation module must return { app }.');
  learning = mountLearning(ui, controller, document.getElementById('lesson-launcher'));
  window.CommonLabSite.initializeSimulationChrome();
  status.hidden = true;
  root.dataset.ready = 'true';
} catch (error) {
  learning?.destroy(); controller?.app?.sim.stop(); ui?.destroy(); root.hidden = true;
  status.textContent = `Unable to load simulation: ${error.message}`;
  status.setAttribute('role', 'alert');
  console.error(error);
}
window.addEventListener('pagehide', event => {
  if (event.persisted) return; // Preserve the rendered slots for browser Back/Forward cache.
  learning?.destroy(); controller?.app?.sim.stop(); ui?.destroy();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) controller?.app?.sim.start();
});
