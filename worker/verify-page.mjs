// Trusted helpers inside an opaque-origin disposable frame. Never app/account origin.
import { renderSimulation } from '/simulation-ui.mjs';
const PREFIX = 'verify-';
let ui,
  controller,
  assertions = 0,
  bindings = new Set();
const slot = (id) => ui.getElementById(id);
function draw() {
  controller.app.sim.onDraw(controller.app.ctx);
}
export async function reset() {
  controller.app.sim.stop();
  controller.app.sim.onReset();
  draw();
}
export function state() {
  const data = controller.inspectState();
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length)
    throw new Error('inspectState must expose a nonempty scientific state object');
  const seen = new WeakSet();
  let values = 0;
  const walk = (v) => {
    if (++values > 5000) throw new Error('Scientific state is too large');
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Nonfinite scientific state');
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof v))
      throw new Error('Scientific state must contain only JSON values');
    if (v && typeof v === 'object') {
      if (seen.has(v) || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype))
        throw new Error('Scientific state must be acyclic plain JSON');
      seen.add(v);
      Object.values(v).forEach(walk);
      seen.delete(v);
    }
  };
  walk(data);
  return structuredClone(data);
}
export function step(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 10)
    throw new Error('step outside 0–10 seconds');
  controller.app.sim.stop();
  let left = seconds;
  while (left > 1e-9) {
    const dt = Math.min(left, 1 / 120);
    controller.app.sim.onTick(dt);
    left -= dt;
  }
  draw();
  return state();
}
export function pixelStats(id) {
  const c = slot(id),
    ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data,
    counts = new Map();
  let total = 0;
  const stride = Math.max(1, Math.ceil((c.width * c.height) / 20000));
  for (let p = 0; p < c.width * c.height; p += stride) {
    const i = p * 4,
      key = `${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4},${d[i + 3] >> 6}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    total++;
  }
  const dominant = Math.max(0, ...counts.values());
  return {
    id,
    width: c.width,
    height: c.height,
    distinctColors: counts.size,
    nonBackgroundFraction: 1 - dominant / total,
    blank: counts.size < 2,
  };
}
function expect(ok, message) {
  assertions++;
  if (!ok) throw new Error(String(message || 'Assertion failed').slice(0, 500));
}
export async function action(s) {
  const el = s.id ? slot(s.id) : null;
  switch (s.action) {
    case 'set':
    case 'select':
      el.value = String(s.value);
      el.dispatchEvent(new Event(s.action === 'select' ? 'change' : 'input', { bubbles: true }));
      if (s.action === 'set') el.dispatchEvent(new Event('change', { bubbles: true }));
      draw();
      return;
    case 'click':
      el.click();
      draw();
      return;
    case 'check':
      el.checked = s.checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      draw();
      return;
    case 'step':
      return step(s.seconds);
    case 'reset':
      return reset();
    case 'expectText': {
      const t = el.textContent.trim();
      if ('equals' in s)
        expect(t === String(s.equals), `#${s.id}: Expected text ${s.equals}; got ${t}`);
      if ('contains' in s)
        expect(
          t.includes(String(s.contains)),
          `#${s.id}: Expected text containing ${s.contains}; got ${t}`,
        );
      if (s.nonEmpty) expect(t.length > 0, `#${s.id}: Empty text`);
      return;
    }
    case 'expectValue':
      expect(
        String(el.value) === String(s.equals),
        `#${s.id}: Expected value ${s.equals}; got ${el.value}`,
      );
      return;
    case 'expectVisible':
      expect(
        Boolean(el.getClientRects().length && !el.hidden) === (s.equals ?? true),
        `#${s.id}: Visibility differs`,
      );
      return;
    case 'expectChecked':
      expect(el.checked === (s.equals ?? true), `#${s.id}: Checked state differs`);
      return;
    case 'expectCanvas': {
      const p = pixelStats(s.id);
      if (s.nonBlank) expect(!p.blank, `#${s.id}: Blank canvas`);
      if ('minColors' in s)
        expect(p.distinctColors >= s.minColors, `#${s.id}: Too few canvas colors`);
      if ('minInkFraction' in s)
        expect(p.nonBackgroundFraction >= s.minInkFraction, `#${s.id}: Too little canvas ink`);
      if ('maxInkFraction' in s)
        expect(p.nonBackgroundFraction <= s.maxInkFraction, `#${s.id}: Too much canvas ink`);
      return;
    }
    default:
      throw new Error('Unsupported test action');
  }
}
export async function runCase(test) {
  assertions = 0;
  try {
    for (const [index, s] of test.steps.entries()) {
      try {
        await action(s);
      } catch (error) {
        throw new Error(
          `Step ${index + 1} ${s.action}${s.id ? ` #${s.id}` : ''}: ${error.message}`,
        );
      }
    }
    if (!assertions) throw new Error('No assertions executed');
    return { name: test.name, ok: true, assertions };
  } catch (e) {
    return { name: test.name, ok: false, assertions, message: String(e.message).slice(0, 500) };
  }
}
export async function runModuleTests(source) {
  assertions = 0;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const m = await import(url);
    if (typeof m.run !== 'function') throw new Error('Export async function run(api)');
    await m.run(
      Object.freeze({
        assert: expect,
        near: (actual, expected, tolerance = 1e-6, message) =>
          expect(
            Number.isFinite(actual) &&
              Number.isFinite(expected) &&
              Number.isFinite(tolerance) &&
              Math.abs(actual - expected) <= Math.abs(tolerance),
            `${message || 'Numeric comparison'}: expected ${typeof expected === 'number' ? expected : typeof expected} ± ${typeof tolerance === 'number' ? tolerance : typeof tolerance}; got ${typeof actual === 'number' ? actual : typeof actual}`,
          ),
        state,
        step,
        reset,
        text: (id) => slot(id).textContent.trim(),
        value: (id) => slot(id).value,
        pixels: pixelStats,
        set: (id, value) => action({ action: 'set', id, value }),
        select: (id, value) => action({ action: 'select', id, value }),
        check: (id, checked) => action({ action: 'check', id, checked }),
        click: (id) => action({ action: 'click', id }),
      }),
    );
    if (!assertions) throw new Error('Test module executed no assertions');
    return { name: 'scientific test module', ok: true, assertions };
  } catch (e) {
    return {
      name: 'scientific test module',
      ok: false,
      assertions,
      message: String(e.message).slice(0, 500),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function mount(definition, moduleCode) {
  ui = renderSimulation(document.getElementById('sandbox-root'), definition, { idPrefix: PREFIX });
  bindings = new Set();
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...args) {
    if (['click', 'input', 'change', 'pointerdown', 'keydown'].includes(type)) bindings.add(this);
    return original.call(this, type, ...args);
  };
  const url = URL.createObjectURL(new Blob([moduleCode], { type: 'text/javascript' }));
  try {
    const m = await import(url);
    controller = m.mount(ui);
  } finally {
    URL.revokeObjectURL(url);
    EventTarget.prototype.addEventListener = original;
  }
  if (!controller?.app?.sim || typeof controller.inspectState !== 'function')
    throw new Error('Return { app, inspectState() } with finite scientific state');
  controller.app.sim.stop();
  state();
  draw();
  return true;
}
export async function hostChecks() {
  const results = [];
  const record = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, message: String(e.message).slice(0, 300) });
    }
  };
  record('state finite', () => state());
  const initial = JSON.stringify(state());
  step(0.25);
  await reset();
  record('reset restores initial scientific state', () => {
    if (JSON.stringify(state()) !== initial) throw new Error('Reset did not restore initial state');
  });
  const canvases = [ui.definition.canvas, ...ui.definition.graphs];
  for (const c of canvases)
    record(`canvas ${c.id} draws`, () => {
      if (pixelStats(c.id).blank) throw new Error('Canvas is blank');
    });
  const controls = [...ui.root.querySelectorAll('input,select,button')].filter((el) =>
    el.id.startsWith(PREFIX),
  );
  if (controls.length > 40)
    throw new Error('Too many interactive controls for bounded verification');
  if (ui.definition.lessons?.length)
    record('lessons have an adapter', () => {
      if (!controller.adapter) throw new Error('Declared lessons require an adapter');
    });
  const isBound = (el) => {
    for (let p = el; p && ui.root.contains(p); p = p.parentElement)
      if (bindings.has(p)) return true;
    return Boolean(el.onclick || el.oninput || el.onchange);
  };
  for (const el of controls) {
    record(`control ${el.id.slice(PREFIX.length)} is bound`, () => {
      if (!isBound(el)) throw new Error('No engine input binding observed');
    });
    if (el.tagName === 'INPUT' && ['range', 'number'].includes(el.type)) {
      for (const v of [el.min, el.max]) {
        await action({ action: 'set', id: el.id.slice(PREFIX.length), value: v });
        step(0.1);
        record(`control ${el.id.slice(PREFIX.length)} at ${v}: finite state`, () => state());
      }
    } else if (el.type === 'checkbox')
      await action({ action: 'check', id: el.id.slice(PREFIX.length), checked: !el.checked });
    else if (el.tagName === 'SELECT') {
      for (const option of el.options)
        await action({ action: 'select', id: el.id.slice(PREFIX.length), value: option.value });
    } else if (el.tagName === 'BUTTON') el.click();
  }
  for (const group of ui.root.querySelectorAll('fieldset.simulation-choices, .simulation-views')) {
    record(`choice ${group.id.slice(PREFIX.length)} is bound`, () => {
      if (!isBound(group) && ![...group.querySelectorAll('button')].some(isBound))
        throw new Error('No engine choice binding observed');
    });
    for (const option of group.querySelectorAll('[data-value]')) {
      option.click();
      draw();
      step(0.1);
      record(`choice ${group.id.slice(PREFIX.length)} remains finite`, () => state());
    }
  }
  await reset();
  record('responsive layout fits viewport', () => {
    if (document.documentElement.scrollWidth > innerWidth + 2)
      throw new Error('Horizontal page overflow');
  });
  record('reset/state remain finite after control exploration', () => state());
  return results;
}
