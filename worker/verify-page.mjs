// Browser-side verification helpers. This module runs inside the disposable
// headless page, never in the app origin. Engine and test source are untrusted.
const PREFIX = 'verify-';
const slot = id => {
  const el = document.getElementById(`${PREFIX}${id}`);
  if (!el) throw new Error(`Missing declared UI slot: ${id}`);
  return el;
};
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
async function settle(ms = 40) {
  await nextFrame(); await nextFrame();
  await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(ms, 0), 500)));
}
function compare(actual, expected) {
  return String(actual) === String(expected);
}
export function pixelStats(id) {
  const canvas = slot(id);
  const ctx = canvas.getContext('2d');
  const width = canvas.width, height = canvas.height;
  if (!width || !height) return { id, width, height, blank: true, distinctColors: 0, nonBackgroundFraction: 0 };
  let data;
  try { data = ctx.getImageData(0, 0, width, height).data; }
  catch (error) { return { id, width, height, error: `canvas pixels are not readable: ${error.message}` }; }
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  const samples = [];
  const counts = new Map();
  let luma = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      const key = `${r >> 3},${g >> 3},${b >> 3},${a >> 6}`;
      const entry = counts.get(key);
      if (entry) entry.count++; else counts.set(key, { count: 1, r, g, b, a });
      samples.push([x, y, r, g, b, a]);
      luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }
  // The background is the modal colour, not the corner: paper, gradients and
  // anti-aliased edges otherwise make a mostly-empty scene look fully inked.
  let mode = null;
  for (const entry of counts.values()) if (!mode || entry.count > mode.count) mode = entry;
  const bg = mode ? [mode.r, mode.g, mode.b, mode.a] : [255, 255, 255, 255];
  const distance = (r, g, b, a) => Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) + Math.abs(a - bg[3]);
  let nonBg = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  const edge = Math.max(1, Math.round(Math.min(width, height) * 0.02));
  let edgeInk = 0, edgeTotal = 0;
  for (const [x, y, r, g, b, a] of samples) {
    if (distance(r, g, b, a) > 24) {
      nonBg++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (x < edge || x >= width - edge || y < edge || y >= height - edge) {
      edgeTotal++;
      if (distance(r, g, b, a) > 24) edgeInk++;
    }
  }
  const total = samples.length;
  return {
    id, width, height,
    background: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`,
    distinctColors: counts.size,
    nonBackgroundFraction: total ? nonBg / total : 0,
    blank: total === 0 || nonBg / total < 0.002,
    meanLuma: total ? luma / total : 0,
    inkBox: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    borderInkFraction: edgeTotal ? edgeInk / edgeTotal : 0,
  };
}
async function runStep(step) {
  if (!step || typeof step !== 'object') throw new Error('Invalid test step');
  switch (step.action) {
    case 'set': {
      const el = slot(step.id);
      el.value = String(step.value ?? '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(step.wait ?? 60);
      return;
    }
    case 'select': {
      const el = slot(step.id);
      el.value = String(step.value ?? '');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(step.wait ?? 60);
      return;
    }
    case 'click': {
      const el = slot(step.id);
      el.click();
      await settle(step.wait ?? 60);
      return;
    }
    case 'check': {
      const el = slot(step.id);
      el.checked = !!step.checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(step.wait ?? 60);
      return;
    }
    case 'reset': {
      window.__cl?.controller?.app?.sim?.reset?.();
      await settle(step.wait ?? 120);
      return;
    }
    case 'wait': await settle(step.ms ?? 100); return;
    case 'expectText': {
      const text = slot(step.id).textContent.trim();
      if (step.equals !== undefined && !compare(text, step.equals)) throw new Error(`text ${JSON.stringify(text)} != ${JSON.stringify(step.equals)}`);
      if (step.contains !== undefined && !text.includes(String(step.contains))) throw new Error(`text ${JSON.stringify(text)} does not contain ${JSON.stringify(step.contains)}`);
      if (step.nonEmpty === true && !text) throw new Error('text is empty');
      return;
    }
    case 'expectValue': {
      const value = slot(step.id).value;
      if (!compare(value, step.equals)) throw new Error(`value ${JSON.stringify(value)} != ${JSON.stringify(step.equals)}`);
      return;
    }
    case 'expectVisible': {
      const el = slot(step.id);
      const rect = el.getBoundingClientRect();
      const visible = !el.hidden && rect.width > 0 && rect.height > 0 && el.getClientRects().length > 0;
      if (visible !== (step.equals ?? true)) throw new Error(`visible is ${visible}, expected ${step.equals ?? true}`);
      return;
    }
    case 'expectChecked': {
      const checked = !!slot(step.id).checked;
      if (checked !== (step.equals ?? true)) throw new Error(`checked is ${checked}, expected ${step.equals ?? true}`);
      return;
    }
    case 'expectCanvas': {
      const stats = pixelStats(step.id);
      if (step.nonBlank === true && stats.blank) throw new Error('canvas is blank');
      if (step.minColors !== undefined && stats.distinctColors < step.minColors) throw new Error(`canvas has ${stats.distinctColors} colors, expected at least ${step.minColors}`);
      if (step.minInkFraction !== undefined && stats.nonBackgroundFraction < step.minInkFraction) throw new Error(`canvas ink fraction ${stats.nonBackgroundFraction.toFixed(4)} < ${step.minInkFraction}`);
      if (step.maxInkFraction !== undefined && stats.nonBackgroundFraction > step.maxInkFraction) throw new Error(`canvas ink fraction ${stats.nonBackgroundFraction.toFixed(4)} > ${step.maxInkFraction}`);
      return;
    }
    default: throw new Error(`Unsupported test action: ${step.action}`);
  }
}
export async function runManifest(manifest = {}) {
  const cases = Array.isArray(manifest.cases) ? manifest.cases.slice(0, 24) : [];
  const results = [];
  for (const item of cases) {
    const name = String(item?.name || item?.id || 'aggressive check').slice(0, 200);
    try {
      // Start every case from the engine's declared reset state.
      try { window.__cl?.controller?.app?.sim?.reset?.(); await settle(80); } catch { /* ignore */ }
      const steps = Array.isArray(item?.steps) ? item.steps.slice(0, 40) : [];
      for (const step of steps) await runStep(step);
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, message: String(error?.message || error).slice(0, 600) });
      // A failed case may leave the scene in an unknown state; reset before the next one.
      try { window.__cl?.controller?.app?.sim?.reset?.(); await settle(80); } catch { /* ignore */ }
    }
  }
  return results;
}
export async function runModuleTests(source) {
  if (!source) return [];
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let module;
  try { module = await import(url); }
  finally { URL.revokeObjectURL(url); }
  const run = module.run || module.test;
  if (typeof run !== 'function') throw new Error('The test module must export async function run(api)');
  const results = [];
  let score = 0;
  const assert = (condition, message) => {
    if (!condition) throw new Error(String(message || 'assertion failed'));
  };
  const api = {
    ui: window.__cl.ui,
    controller: window.__cl.controller,
    app: window.__cl.controller?.app,
    slot,
    text: id => slot(id).textContent.trim(),
    value: id => slot(id).value,
    set: async (id, value) => runStep({ action: 'set', id, value }),
    select: async (id, value) => runStep({ action: 'select', id, value }),
    click: async id => runStep({ action: 'click', id }),
    check: async (id, checked) => runStep({ action: 'check', id, checked }),
    wait: async ms => settle(ms),
    reset: async () => runStep({ action: 'reset' }),
    pixels: id => pixelStats(id),
    assert,
    near: (actual, expected, tolerance = 1e-6, message = '') => assert(Math.abs(Number(actual) - Number(expected)) <= Math.abs(tolerance), message || `${actual} is not within ${tolerance} of ${expected}`),
    score: value => { score = Number(value) || 0; },
  };
  const executed = await Promise.race([
    Promise.resolve().then(() => run(api)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Test module exceeded 15 seconds')), 15000)),
  ]);
  const list = Array.isArray(executed) ? executed : [];
  for (const item of list.slice(0, 40)) {
    if (item && typeof item === 'object' && typeof item.ok === 'boolean') results.push({ name: String(item.name || 'module test').slice(0, 200), ok: item.ok, message: item.message ? String(item.message).slice(0, 600) : undefined });
    else results.push({ name: 'module test', ok: !!item });
  }
  if (!results.length) results.push({ name: 'test module ran', ok: true });
  results.push({ name: 'test module score', ok: true, message: `score ${score}` });
  return results;
}
export async function mount(definition, moduleCode) {
  const { renderSimulation } = await import('/simulation-ui.mjs');
  const root = document.getElementById('sandbox-root');
  root.replaceChildren();
  const ui = renderSimulation(root, definition, { idPrefix: PREFIX });
  const url = URL.createObjectURL(new Blob([moduleCode], { type: 'text/javascript' }));
  let module;
  try { module = await import(url); }
  finally { URL.revokeObjectURL(url); }
  if (typeof module.mount !== 'function') throw new Error('The engine must export mount(ui).');
  const controller = module.mount(ui);
  if (!controller?.app?.sim) throw new Error('mount(ui) must return { app } with a simulation.');
  controller.app.sim.start();
  window.__cl = { ui, controller };
  await settle(120);
  return true;
}
