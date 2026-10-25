# Data-driven simulations

All seven simulations use **one page**, `public/simulation.html`, and **one stylesheet**, `public/simulation.css`. A simulation is an entry in `public/simulations/catalog.json` plus a trusted physics/rendering module, `public/simulations/<id>.js`. There are no per-simulation HTML pages or stylesheets.

## Add a simulation

**Through the UI:** open `/submit.html`, select an installed engine or supply new module code, use the visual explanation/question editors (or advanced JSON), optionally run the engine in the isolated sandboxed preview, and submit a private draft. Complete-bundle download/restore saves both the definition and its engine choice/code without executing the source. A trusted maintainer reviews/publishes it at `/review.html`; SQLite-backed publications appear immediately, without a restart. Layout previews never execute submitted engines and use namespaced DOM IDs so draft slots cannot shadow author/reviewer controls. See [Submission setup and safety](submissions.md).

**Through the repository:**

1. Add a definition to the catalog's `simulations` array. Keep `schemaVersion: 1`.
2. Add `<id>.js` exporting `mount(ui)` and returning `{ app }` (or `{ app, adapter }` for lessons).
3. Run the Node catalog tests, Rust tests, and browser tests.
4. Restart Axum so it registers the new catalog entry's URLs.

Homepage cards use built-in static artwork when available, or a physics/chemistry illustration for community simulations. These are decorative previews, not captures of the running engine; browsing the catalog never executes simulation code or loads contributor-supplied images.

No homepage markup, routing code, or shell code changes are needed. Axum serves the shared shell at `/simulations/<id>` and `/simulations/<id>.html`. Unregistered simulation URLs return 404. Homepage links use `/simulation.html?id=<id>` so the same frontend also works with ordinary static hosting. Browser assets must be served at the site root.

The server checks the catalog version, IDs, uniqueness, and module/shell availability at startup. The browser validates the complete UI/learning definition before loading a module. `tests/simulation-catalog.test.mjs` validates the repository catalog and checks each module's DOM bindings against declared slots. Deploy the catalog, modules, and shell together; don't edit the deployed catalog without restarting the server.

## Minimal definition

```json
{
  "id": "spring",
  "title": "Spring Lab",
  "subject": "physics",
  "summary": "Explore the relationship between force and extension.",
  "canvas": { "id": "springCanvas", "label": "Spring scene", "width": 700, "height": 480 },
  "controls": [
    {
      "type": "slider", "id": "massSlider", "label": "Mass (kg)",
      "min": 0.1, "max": 5, "step": 0.1, "value": 1,
      "output": { "id": "massValue", "text": "1.0 kg" }
    },
    {
      "type": "readouts",
      "items": [{ "id": "extensionValue", "label": "Extension (m)", "value": "0.00", "tone": "highlight" }]
    }
  ],
  "cards": [{ "title": "Hooke's law", "formulas": ["F = kx"], "paragraphs": ["Force is proportional to extension within the elastic limit."] }],
  "graphs": [],
  "lessons": []
}
```

Simulation IDs are lowercase slugs, up to 80 characters; the module filename is derived from the ID. There is deliberately no arbitrary module URL field. Every DOM slot ID must be unique within the definition. Canvas dimensions are positive integers up to 4096, with a combined area limit of 16,777,216 pixels. Shell-owned IDs such as `simulation-root` and `lesson-launcher` are reserved. Assessment bank IDs must also be unique across simulations. The supported subjects are `physics` and `chemistry`.

## Fixed component vocabulary

`controls` is an ordered list of these components. Each is rendered by the shared shell, not by the physics module:

| Type | Fields |
| --- | --- |
| `slider` | `id`, `label`, numeric `min/max/step/value`; optional `output: {id,text}`, two `icons: [{id,text}]`, and `info` key |
| `actions` | `buttons: [{id,label,variant,active?,pressed?}]`; variants: `primary`, `ghost`, `soft`, `outline`, `display` |
| `choices` | `id`, `label`, `style` (`toolbar`, `segments`, `chips`), `options: [{value,label}]`, initial `value` |
| `select` | `id`, `label`, `options: [{value,label}]`, initial `value` |
| `readouts` | optional group `id` and `hidden`; `items: [{id,label,value,tone}]`, tones: `default`, `highlight`, `success` |
| `text` | `text`, optional `id` and `label` for dynamic notes; optional `style` (`note`, `message`, `alert`) and `hidden` |
| `number` | `id`, `label`, numeric `min/max/step/value`; optional `unit` text and `hint: {id,text}` |
| `toggles` | optional group `id`; `items: [{id,label,checked?}]` rendered as checkboxes |
| `panel` | `id`, initial `text`, optional `label`; a region the module fills with `ui.setContent` |
| `table` | `id` (the table body), `columns: [{id?,label}]`, optional `label`, `empty: {id,text}` hint and `hidden` |
| `dock` | `buttons` (1–5), optional `readout: {id, value, label: {id,text}}` and `swatch: {id}`; a bar pinned below the canvas while scrolling |
| `stepper` | `label`, `output: {id,text}`, `increase` button, optional `decrease` button |
| `meter` | `id` for the fill, `label`, `output: {id,text}`, `ticks: [text]` |

`cards` contains `{title, formulas: [text], paragraphs: [text]}`, plus optional `components` (up to 10 of the components above, such as a log `table`). Content is plain text, including mathematical notation; HTML is never interpreted. `graphs` contains additional canvases with `id/label/width/height`, optional `caption`, optional `legend: [{label,color}]` (six-digit hex colors), and optional `controls` (up to 10 components shown above that canvas).

The live simulation workspace uses the available page width. At desktop widths of 1280px and above, graphs form a column beside the scene and controls remain alongside; at 1800px and above, explanation cards occupy a separate reference column (two card columns from 2200px). Smaller screens stack these sections in reading order. Simulations without graphs or cards do not reserve empty columns. Embedded authoring previews keep graphs below the scene and do not use the new wide-page columns.

Optional top-level `views: {id, value, options: [{value,label}]}` declares fullscreen tabs. The first option shows the main canvas and controls; a graph with `view` set to another option is shown on its own tab. Outside fullscreen every view stays visible. The tab group's `.value` holds the current view and it dispatches `change` when a tab is chosen.

For information dialogs, define `info: {key: {title,formula,explanation,detail}}` and reference the key from a slider. The shell provides the accessible native dialog and focus restoration.

Unknown fields/component types, duplicate IDs/options, invalid defaults/ranges, invalid question keys, and missing question references are rejected. There are **no raw HTML, CSS, arbitrary attributes, custom layout trees, or executable callbacks in definitions**. To add a genuine new UI primitive, extend the browser validator, renderer, stylesheet, server JSON Schema (`schema/simulation.schema.json`), Rust cross-field/binding checks, and tests once for everyone. Submitted definitions are validated on the server both when stored and when published; browser-only validation is not an authorization boundary.

## Physics module contract

```js
export function mount(ui) {
  const canvas = ui.getElementById('springCanvas');
  const massSlider = ui.getElementById('massSlider');
  const output = ui.getElementById('massValue');
  class SpringSim extends SimLib.Simulation {
    onInit() {
      this.mass = Number(massSlider.value);
      massSlider.addEventListener('input', () => {
        this.mass = Number(massSlider.value);
        output.textContent = `${this.mass.toFixed(1)} kg`;
      });
    }
    onTick(dt) { /* Integrate physics. */ }
    onDraw(ctx) { /* Draw only inside the declared canvases. */ }
  }
  const app = SimLib.attach({
    canvas,
    logicalWidth: ui.definition.canvas.width,
    logicalHeight: ui.definition.canvas.height,
    SimulationClass: SpringSim,
  });
  app.sim.start();
  return { app };
}
```

`ui` provides `definition`, `getElementById(id)` (throws for undeclared slots), and scoped `querySelector/querySelectorAll`. For dynamic rich text, `ui.setContent(id, parts)` fills a declared slot and `ui.setRows(id, rows)` fills a declared table body (rows are arrays of cells). A part is a string or `{text, strong?, sup?, color?, key?, swatch?}`: `key` draws a legend colour bar and `swatch` a colour square; the shell builds the elements, so modules never write markup. Hide or reveal a declared slot with its `hidden` property. Choice buttons have `data-value`; selectors/classes are supplied by the shared renderer. Choice groups expose their current `.value`. `ui.addEventListener('keydown', handler)` only forwards events originating on a declared, focused canvas, preventing shortcuts from hijacking controls or answers. Read defaults from the generated controls. Readout updates use `textContent`; modules must not construct page UI or inject markup.

`SimLib.Simulation` suspends physics, drawing, and guided ticks while the document is hidden (for example, after switching browser tabs). Returning resumes the existing state without integrating time spent away or changing a module's own Pause setting. `running` tracks the requested loop state, even while hidden. Visible frame gaps are capped at 50 ms before speed scaling to avoid unstable physics steps after stalls; missed time is discarded, not caught up.

Modules are trusted application code, **not a security sandbox**. They own simulation state, input bindings, physics, and canvas drawing. The shell owns page chrome, controls, explanations, graphs' containers, error states, fullscreen, learning UI, and page lifecycle. Avoid module-level side effects; initialize only inside `mount(ui)`.

## Drawing and theme

Every scene draws from one shared canvas theme, so all labs read as figures on the same sheet of graph paper. Call `const T = SimLib.Theme.use('light');` once at the top of `mount(ui)` and take every colour and font from it:

| Need | Use |
| --- | --- |
| Background | `SimLib.Draw.paper(ctx, w, h, { theme: T })` (cream stock, 20px minor and 100px major rules; pass `minor` to match a snap grid) |
| Lines and text | `T.ink`, `T.text`, `T.muted`, `T.faint` |
| Surfaces and rules | `T.bg`, `T.surface`, `T.surface2`, `T.border`, `T.borderStrong`, `T.grid`, `T.gridStrong`, `T.rule` |
| Emphasis | `T.accent`, `T.accentDark`, `T.accentSoft`, `T.secondary`, `T.secondarySoft`, `T.glow` |
| Status | `T.success`, `T.warn`, `T.danger` (+ `successSoft`, `dangerSoft`), or `SimLib.Theme.status(level)` |
| Data series | `T.series[0…4]`, in order; built-in graph `legend` colours in `catalog.json` must be the same `--series-*` values |
| Translucency, blends, scales | `SimLib.Color.alpha(c, a)`, `SimLib.Color.mix(a, b, t)`, `lighten`/`darken`, and `SimLib.Color.heat(t)` for cold-to-hot |
| Type | `T.font(size, weight)` for labels and numbers (IBM Plex Mono); `SimLib.Draw.title(…)` for scene titles (Atma) |
| Bodies (bobs, particles) | `SimLib.CanvasUtils.drawGlossySphere(ctx, x, y, r, fill)`: flat fill, ink outline, small highlight |

House style: square corners, ink outlines rather than soft shadows, and no gradient washes or emoji.

The palette's source of truth is the `:root` block of `public/main.css`. `SimLib.Theme` reads those custom properties when the page loads (`SimLib.Theme.cssTokens` lists which property feeds which token), so changing a colour there restyles the page chrome and every canvas together. The literals in `library.js` are only a fallback for non-browser test hosts.

`tests/simulation-theme.test.mjs` enforces this. It fails on hex colours, `rgb()`/`hsl()` literals and font strings in `public/simulations/*.js`. It also fails if a module never calls `SimLib.Theme.use()`, if the `library.js` fallbacks drift from `main.css`, or if a built-in legend uses an off-palette colour. When a colour is data rather than styling (indicator dye colours, a standard chart encoding), mark it with `// theme-exempt: <reason>` on the line, or wrap a table in `// theme-exempt-start: <reason>` … `// theme-exempt-end`. A reason is required. Reviewers should run the same test against submitted engine source before publishing it.

## Lessons and checks

Add `assessment: {id,version,questions}` to the definition using the [CFU schema](guided-experiments-authoring.md#9-shared-check-understanding-cfu-questions). Pendulum's bank ID remains `pendulum-period`, version 1, preserving saved attempts. Projectile's four former page-specific questions now use the same shared CFU flow.

Add lesson objects to `lessons`, using the guided engine's declarative fields. Set `sim` to the simulation ID. Checkpoint `question` is a **question ID string**, not a question object:

```json
{ "id": "check-length", "type": "checkpoint", "title": "Check the length relationship", "question": "length" }
```

The referenced question must have `use: "lesson"` or `"both"`. Return an `adapter` alongside `app` from the module to expose semantic control/state/action/target names. See [the guided API reference](guided-experiments-authoring.md) for these names and condition behavior. JSON conditions use the built-in comparisons/combinators; custom `when.fn` callbacks are intentionally unsupported. Setup/condition names must match the adapter.

The shell resolves question references, mounts the launcher/check panel, and owns mutual exclusion. Do not call `Guided.mount` or `CFU.mount` in individual modules. Practice answers and standalone scores remain separate; standalone progress uses versioned localStorage. Bump the bank version for content/key/order changes.

## Verification

```sh
cargo test
node --test tests/*.test.mjs
npm ci
npx playwright install chromium
npm run test:browser
```

Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm run test:browser` to test with an existing Chromium binary. Browser tests start Axum on an ephemeral port and check all seven simulations at desktop/mobile sizes, key interactions, dialogs, persisted checks, guided mounting, legacy links, and error states. The nuclear-data request is blocked to exercise its offline fallback deterministically.

Still manually verify scientific accuracy, touch input, screen-reader announcements, fullscreen/resize, the full lesson path, performance, and any external data sources. Browser tests are not a complete accessibility audit.
