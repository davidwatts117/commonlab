# Generated engine and verification API

Verified generation covers science engines, controls, cards and graphs. Use `lessons: []` and omit `assessment`: guided learning content is not exercised by this verifier and can be added later in the manual editor.

Use only the closed CommonLab definition schema and native canvas drawing. No imports, HTML, network, document/window/globalThis, storage or external assets. Only helper function declarations outside `export function mount(ui)`.

## Minimal engine

```js
export function mount(ui) {
  const canvas = ui.getElementById(ui.definition.canvas.id);
  const T = SimLib.Theme.use('light');
  class Lab extends SimLib.Simulation {
    onInit() { this.onReset(); /* bind declared controls here exactly once */ }
    onReset() { this.state = { time: 0, x: 1, velocity: 0 }; }
    onTick(dt) { this.state.time += dt; /* integrate the actual equations */ }
    onDraw(ctx) {
      const { w, h } = this.app.logical;
      SimLib.Draw.paper(ctx, w, h, { theme: T });
      ctx.fillStyle = T.accent;
      ctx.fillRect(w / 2 + this.state.x * 20, h / 2, 20, 20);
      ctx.fillStyle = T.text;
      ctx.font = T.font(14, 400);
      ctx.fillText('Position (m)', 20, 24);
    }
  }
  const app = SimLib.attach({ canvas, logicalWidth: ui.definition.canvas.width,
    logicalHeight: ui.definition.canvas.height, SimulationClass: Lab });
  app.sim.start();
  return { app, inspectState: () => ({ ...app.sim.state }) };
}
```

`Simulation` provides onInit(), onReset(), onTick(dt seconds), onDraw(ctx), start(), stop(), reset(), app.logical.{w,h}. `attach` calls onInit and onDraw. The harness pauses animation and advances onTick with fixed 1/120-second steps before repainting. Never call start() from onTick/onDraw. Every dynamic physics scalar must be exposed through inspectState() as finite JSON. Do not expose DOM, methods or circular objects.

`ui.getElementById(id)` throws on undeclared slots. Read input defaults from .value and .checked. Readout items and slider outputs are text elements: update `.textContent`, NOT `.value`. Likewise change a button's visible label with `.textContent`. Listen to input/change/click through addEventListener; write textContent, hidden, value, checked. `ui.setContent(id,parts)` and `ui.setRows(id,rows)` build rich text without HTML. A content part is a string or `{text,strong?,sup?,color?,key?,swatch?}`. **Table rows are arrays of cells, NOT objects keyed by column ID**: `ui.setRows('impactLog', log.map(r => [r.time, r.event, r.detail]))`. Each cell is a string or an array of content parts; order cells exactly like the declared columns. `ui.querySelector(All)` is scoped to simulation UI.

Use T.ink/text/muted/accent/secondary/series[] for colors, T.font(size,weight) for fonts. Prefer ordinary ctx paths/lines/fillText over guessing unlisted SimLib helper signatures. Draw axes, units and velocity/state cues. Draw inside the logical canvas extents; responsive canvas bitmap sizes are not the physical coordinate system. Reset restores deterministic state and correct readouts. Every declared control must have an observable effect on state, readouts or scene.

## Definition and graph cross-references

Always supply `id`, `title`, `subject`, `summary`, `canvas`, `controls`, `cards`, `graphs`, `lessons` (empty arrays still count). Every UI slot ID must be unique, including nested slider outputs and graph canvases. Slider `output` is `{id,text}`, not a string. Action buttons require `id`, `label`, `variant`; optional `active` and `pressed` are booleans.

A graph is an additional canvas, not a chart-data declaration: `{id,label,width,height,legend?,caption?,controls?,view?}`. Draw it using `ui.getElementById(graphId).getContext('2d')`; expose its physics in `inspectState()`. **Omit `graph.view` unless you explicitly declare fullscreen `views`.** It is a reference to a `views.options[].value`, not a graph title/type/ID. Without views, graphs appear below the main simulation; this is usually simplest. The first fullscreen view shows the simulation; graphs assigned another view appear on that tab. Cards require `title`, `formulas: []`, `paragraphs: []` even when empty.

## Tests: tests.json

```json
{"cases":[{"name":"mass changes the readout","steps":[
  {"action":"set","id":"mass","value":2},
  {"action":"expectText","id":"massValue","contains":"2"}
]}]}
```

Each case starts from a fresh mounted engine. At most 12 cases, 30 steps each. Actions: set(id,value) for inputs; select(id,value); click(id); check(id,checked); reset; step(seconds 0–10). Assertions: expectText(id,equals/contains/nonEmpty), expectValue(id,equals), expectVisible(id,equals boolean), expectChecked(id,equals boolean), expectCanvas(id,nonBlank/minColors/minInkFraction/maxInkFraction). No empty/expectation-free tests. Once full verification passes, its checks remain required across later repairs. Never weaken those passing baselines. Failing authored expectations may be corrected, but any edit/write of an existing test file after a failed check must include a `reason` explaining the independently correct expectation and the old error; the independent reviewer audits these corrections.

## Tests: tests.js

```js
export async function run(api) {
  await api.reset();
  const initial = await api.state();
  await api.step(0.5);
  const state = await api.state();
  api.assert(state.time > initial.time, 'time advances');
  api.near(state.time, 0.5, 0.01, 'fixed-step elapsed time');
}
```

Available api: assert(condition,message), near(actual,expected,absoluteTolerance,message), state(), step(seconds), reset(), set(id,value), select(id,value), check(id,boolean), click(id), text(id), value(id), pixels(id). Assertions must execute; returned pass flags/scores do not count. No imports. Each module runs in its own fresh engine. Use actual equations, initial conditions, conservation laws (with tolerances), reset and edge-case interactions. Tests are executable checks, not proof of scientific correctness. Physics tests need independently computed expectations, not values copied from the engine implementation.

## Workspace operations

Only definition.json, engine.js, tests.json and tests.js exist. read_artifact returns the current hash and text. write_artifact requires that hash and replaces or appends text; use append for complete helper chunks to avoid repeating long engines. Current artifact source is supplied verbatim in each author request. edit_artifact requires an expected hash and a unique nonempty exact-text match, including whitespace. If matching fails, use write_artifact with the current inventory hash to replace the full file rather than repeating an invalid edit. Both write_artifact and edit_artifact accept `reason`; it is required when correcting an existing tests.json/tests.js after failed verification. Do not remove scientific coverage to hide a physics error. run_verification validates the full artifact and runs host checks/tests/screenshots; do not call it on incomplete code. The host automatically schedules independent review on a passing result. inspect_screenshot selects labeled evidence; author repairs also receive the latest bounded image set automatically.
