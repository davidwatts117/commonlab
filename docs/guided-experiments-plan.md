# Guided Experiments — Implementation Plan

**Status:** Draft plan
**Working name:** "Guided Experiment" (see [Naming](#11-naming-open-question))
**Depends on:** `library.js` (SimLib), `main.css`, existing `simulations/*.html`

---

## 1. Goal & Scope

Add **guided experiments** to CommonLab: curated, step-by-step interactive lessons
layered on top of an existing simulation. A guided experiment can:

- Present instructions, questions, and checkpoints in an **overlay UI** anchored to
  the simulation (not a separate page).
- **Drive the simulation directly** — set controls, pause/resume, reset, or force a
  starting state.
- **Observe the simulation** — read live values, wait for a condition, detect that a
  student did the right thing.
- **Gate or focus interaction** — highlight one control, dim the rest, prevent
  students from skipping ahead.
- Be **selected from a launcher** on the simulation page (and surfaced on the home
  page), and exited back to free exploration at any time.

A simulation may define **zero or more** guided experiments. Simulations with none
behave exactly as they do today.

### Non-goals (for the first iteration)

- No backend, accounts, grading, teacher dashboards, or analytics upload.
- **No persistence of progress.** Progress lives in memory for the current session only;
  reloading starts fresh. (See [Future Work](#13-future-work).)
- No new simulation engine and no rewrite of existing simulations.
- No i18n until the authoring format is stable.
- No arbitrary third-party content; experiments are authored in-repo.
- No deep links / shareable state yet (deferred; see [Future Work](#13-future-work)).

### Design principles

1. **Additive and non-invasive.** Existing simulations keep working untouched. Guided
   support is opt-in via a small adapter object.
2. **Declarative first, escape hatch second.** Most experiments should be data
   (`{ steps: [...] }`). Functions are allowed where logic is genuinely needed.
3. **One shared engine.** All experiments use the same runner, overlay components, and
   step schema so the UX and code are consistent.
4. **Progressive enhancement / a11y.** The overlay is real DOM, keyboard-navigable,
   screen-reader-announced, and degrades to a simple panel on small screens.
5. **No magic in simulation internals.** Integrations go through a named adapter API,
   so we can refactor a sim without breaking lessons.
6. **Distinct domain names.** Simulation variables (mass, angle) stay distinct from
   guided-experiment variables. No global mutation naming collisions.

---

## 2. Architecture Overview

```
index.html  ──► Guided launcher badges (data from guided/manifest.js)
simulations/*.html
   └─ defines SimulationClass (existing)
   └─ defines 0..n GuidedExperiment definitions
   └─ registers a  GuidedAdapter  (named control/state/target bridge)
        │
        ▼
   SimLib.Guided.Manager        (per-page orchestration)
     ├─ Launcher                 DOM: pick an experiment
     ├─ Runner                   step state machine + conditions (in-memory)
     └─ Overlay                  DOM layer over canvas + HUD + callouts + modal
             │  uses
             ▼
        GuidedAdapter ──► sim (controls, state, actions, events)
```

**Key decision:** put the engine in a **new file** (`guided.js`) plus
`guided.css`, rather than growing `library.js` further. `library.js` stays the
general-purpose sim/UI toolkit; `guided.js` depends on it.

---

## 3. Component Breakdown

### 3.1 GuidedAdapter — the per-simulation bridge

A plain object that maps *semantic names* to the simulation's actual internals. This is
the only place that knows slider IDs and private fields, so experiments stay portable
and sims can be refactored safely.

```js
const adapter = SimLib.Guided.adapter(sim, {
  id: 'pendulum',

  // Named controls: read, write, and mark the DOM element that owns them
  controls: {
    length: {
      get: () => sim.length,
      set: (v, { animate } = {}) => {
        sim.length = v;
        sim.lengthSlider.value = v;
        sim.lengthValue.textContent = v.toFixed(2) + ' m';
      },
      el: () => sim.lengthSlider,     // for highlighting / gating
      format: v => v.toFixed(2) + ' m',
      range: [0.3, 3.0],
    },
    // ...mass, drag, gravity, angle
  },

  // Named live values (read-only)
  state: {
    period: () => sim.measuredPeriod ?? 2 * Math.PI * Math.sqrt(sim.length / sim.gravity),
    angle:  () => sim.angle * 180 / Math.PI,
    energyTotal: () => sim._computeEnergy().total,
  },

  // Named actions
  actions: {
    release: () => { sim.paused = false; sim.pauseBtn.textContent = 'Pause'; },
    pause:   () => { sim.paused = true;  sim.pauseBtn.textContent = 'Resume'; },
    reset:   () => sim.reset(),
  },

  // Named canvas regions for callouts/spotlights, in logical coordinates
  targets: {
    bob:   () => ({ ...sim._bobPos(), r: sim._bobPixelRadius() }),
    pivot: () => ({ x: sim.PIVOT_X, y: sim.PIVOT_Y, r: 12 }),
  },

  // Semantics for gating: which controls count as "interactive" for each step,
  // and whether the sim is currently paused.
  isPaused: () => sim.paused,
});
```

Design notes:

- `controls[*].el()` powers **highlight** and **gate**. If an element isn't available,
  the overlay falls back to a text instruction.
- `targets` are functions returning **logical canvas coordinates + radius/box**, so the
  overlay can position callouts correctly at any display scale (reuse
  `CanvasUtils.logicalSize`, add an inverse `CanvasUtils.logicalToCss`).
- The adapter can also expose `events` if a sim wants push-based notification; otherwise
  the runner polls (see §4).
- For sims with custom controls (build-a-nucleus, circuits), the adapter is where the
  impedance matching lives. No sim internals leak into experiment definitions.

### 3.2 GuidedExperiment — the authoring format

A declarative definition, created with a thin helper for validation and defaults.

```js
const PeriodVsLength = SimLib.Guided.define({
  id: 'pendulum-period-vs-length',
  sim: 'pendulum',
  title: 'What controls a pendulum\u2019s period?',
  summary: 'Predict, then measure how length changes the swing time.',
  subject: 'Physics',
  level: 'Intro',
  minutes: 8,
  tags: ['period', 'isochronism', 'experimental design'],

  // Optional: applied when the experiment starts (and on restart)
  setup: {
    controls: { drag: 0, gravity: 9.8, mass: 1.0, angle: 20, length: 1.0 },
    action: 'pause',          // start frozen so the student chooses when to release
    view: { showTrace: false },
  },

  steps: [
    {
      id: 'intro',
      type: 'message',        // message | task | observe | predict | checkpoint | conclusion
      title: 'A question first',
      body: 'The **period** T is the time for one full back-and-forth swing.\n' +
            'Do you think a longer string makes the period longer, shorter, or the same?',
      choices: [
        { id: 'longer',  label: 'Longer string \u2192 longer period', correct: true },
        { id: 'same',    label: 'No change' },
        { id: 'shorter', label: 'Longer string \u2192 shorter period' },
      ],
      feedback: {
        correct: 'Good \u2014 we\u2019ll test it. T \u2248 2\u03c0\u221a(L/g).',
        any: 'Keep that prediction in mind; you\u2019ll measure it in a moment.',
      },
      advance: 'on-next',
    },
    {
      id: 'set-length',
      type: 'task',
      title: 'Set the length to 2.00 m',
      body: 'Drag the length slider (or use arrow keys) until it reads 2.00 m.',
      highlight: ['length'],
      allow: ['length'],                    // only this control is interactive
      when: { control: 'length', near: 2.0, tolerance: 0.02 },
      hint: 'The slider is the one labelled L.',
      advance: 'on-condition',
    },
    {
      id: 'release',
      type: 'task',
      title: 'Release the pendulum',
      body: 'Press **Resume** and let it swing. It will measure the period for you.',
      highlight: ['release'],
      when: { action: 'release' },
      advance: 'on-condition',
    },
    {
      id: 'measure',
      type: 'observe',
      title: 'Watch the period readout',
      body: 'Wait until at least three full swings have been timed.',
      when: { state: 'period', settles: true, minElapsed: 6 },
      advance: 'on-condition',
    },
    {
      id: 'conclude',
      type: 'conclusion',
      title: 'You tested it',
      body: 'At L = 1.00 m the period was about 2.0 s; at L = 2.00 m it is about 2.8 s.\n' +
            'Period grows with the **square root** of length \u2014 and mass does not matter.',
    },
  ],
});
```

**Step schema**

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Stable key (in-session progress; future deep links) |
| `type` | enum | Controls default chrome/behavior: `message`, `task`, `observe`, `predict`, `checkpoint`, `conclusion` |
| `title` / `body` | string | Rich text (see §3.5). Body supports inline lock/highlight markers |
| `choices` | array | For `predict`/`checkpoint`: `{ id, label, correct? }`; answers are recorded locally |
| `feedback` | object | `{ correct, any }` strings shown after answering |
| `highlight` | string[] | Adapter `controls`/`targets`/`actions` names to spotlight |
| `allow` | string[] | If present, only these controls are interactive; everything else is dimmed/disabled |
| `when` | condition | Completion condition (auto-advance) |
| `hint` | string | Optional hint revealed by a "Hint" button |
| `advance` | enum | `on-next` (default for messages), `on-condition`, `on-answer` |
| `freeze` | boolean | Pause the sim while this step is shown |
| `optional` | boolean | Can be skipped without failing |
| `duration` | number | Suggested max seconds (for pacing/UX only) |

**Completion conditions** (`when`) — evaluated by the runner against the adapter:

```js
// Sugar forms
{ control: 'length', near: 2.0, tolerance: 0.02 }  // value close to target
{ control: 'drag', equals: 0 }                      // exact
{ control: 'gravity', changedBy: 4 }                // relative to setup value
{ state: 'period', settles: true, minElapsed: 6 }   // live value stabilizes
{ state: 'angle', min: 40 }                         // threshold
{ action: 'release' }                               // action was invoked
{ all: [ ... ] } / { any: [ ... ] } / { not: ... }  // combinators
{ fn: (ctx) => boolean }                            // escape hatch, ctx = { adapter, values, elapsed }
```

The runner evaluates `when` at ~10 Hz (see §4) and also immediately after any adapter
control write, so programmatic setups don't cause visible lag.

### 3.3 Runner — step state machine

```js
const runner = SimLib.Guided.run(periodVsLength, {
  app,
  adapter,
  overlay,           // created by Manager
  onStep, onComplete, onExit,
});
runner.next(); runner.back(); runner.skip(); runner.exit(); runner.restart();
runner.goTo('measure');            // deep-link support
runner.getProgress();              // { stepIndex, total, answers, elapsed }
```

Responsibilities:

- Apply `setup` at start and restart (via adapter, with `animate: false` for instant
  setup vs. eased changes for dramatic reveals later).
- Manage `highlight` / `allow` by toggling classes and `disabled` on adapter elements,
  plus dimming non-allowed controls.
- Evaluate `when` conditions, handle `elapsed`, and emit enter/exit lifecycle hooks.
- Track `predict` answers for the recap; keep everything **in memory for the current
  session only** (no `localStorage` yet — see [Future Work](#13-future-work)).
- Support **pause** semantics: when a step has `freeze: true`, call `adapter.actions.pause()`
  on enter and restore the previous run state on exit.
- Be **restartable and cancellable** with no leaks: unbind listeners/overlays on `exit`
  and restore the sim's pre-lesson state.
- Expose step events through `app.bus` (`guided:start`, `guided:step`, `guided:complete`)
  so sims or future features can react.

**Evaluation loop:** rather than adding a rAF loop, subscribe to the existing sim loop.
 Add an optional `SimLib.Simulation.onGuidedTick(dt)` hook called from `_loop` when
   `app.guided` is active (smallest change, no extra rAF).

A single line in `Simulation._loop` and `reset()` that
forwards to `this.app.guidedTick?.(dt)`. This keeps one clock and guarantees the runner
sees the same `dt` as the sim.

### 3.4 Overlay & UI components

All DOM, layered inside `.canvas-wrapper` / `.sim-main` (which already become
`position: relative` for the fullscreen button). New components:

| Component | Role |
|---|---|
| `Guided.Hud` | Top bar over the sim: experiment title, step `n/total`, progress dots, **Back / Next / Skip / Exit**, hint button. Sticky, always reachable. |
| `Guided.Callout` | Anchored bubble pointing at a `target` or `control` element. Supports `placement: auto/top/bottom/left/right`. |
| `Guided.Spotlight` | Dimming layer with a rounded cutout around the highlighted control/target. Implemented as an SVG/`box-shadow` mask; respects `allow`. |
| `Guided.Modal` | Centered, focus-trapped dialog for `predict`/`checkpoint` steps and the experiment intro/summary. Reuses the visual language of the existing `.modal-*` classes in `main.css`. |
| `Guided.Launcher` | Button ("Guided Experiments") + panel/list of cards. Each card shows title, summary, subject tag, `~minutes`, and a Start action. Empty/absent when the sim defines none. (Session progress "3/5 steps" is shown once started; no cross-visit resume.) |
| `Guided.Toast` | Non-blocking confirmations ("Nice — condition met"). Optional. |

**Positioning:** add `CanvasUtils.logicalToCss(canvas, x, y)` (inverse of
`toLogical`) so canvas-space targets map to CSS pixels for callouts. Control targets use
`el().getBoundingClientRect()`. On resize, re-position (the existing `handleResize`
already fires; the overlay subscribes to `window.resize`).

**Responsive behavior:**
- **≤ 768 px:** no floating callouts. The HUD collapses into a bottom sheet / stacked
  card under the canvas; spotlight becomes a pulsing outline on the control plus a
  sticky "Step" card. This matches the current mobile layout where the sidebar moves
  below the canvas.
- **Fullscreen:** the guided overlay must participate. The fullscreen button lives on
  `.canvas-wrapper`; overlays are siblings inside `.canvas-wrapper`/`.sim-main`, so they
  scale with it. Re-check `main.css` fullscreen rules (`:fullscreen .controls-panel`,
  `.fs-active .sim-sidebar`) and add guided equivalents (keep HUD visible, hide launcher).

**Accessibility:**
- Overlay root is `role="region"`; live regions announce step changes
  (`aria-live="polite"`).
- Modal: focus trap + `Esc` to exit; `aria-labelledby`/`aria-describedby`.
- Spotlight never removes the highlighted control from the tab order; `allow` uses
  `inert` where supported, otherwise `disabled` + `pointer-events: none`.
- `prefers-reduced-motion` disables animated transitions and eased control changes.
- All hints/feedback are text, not color-only.

### 3.5 Content/rich text

`body`/`feedback` support a **restricted Markdown subset** (`**bold**`, `*italic*`,
code, links, lists, line breaks) rendered by a tiny in-house renderer
(`SimLib.Guided.richText`) — no third-party dependency, and escaped by default to avoid
injecting HTML. Optionally allow explicit `html` fields for advanced authors, clearly
documented as trusted in-repo content.

### 3.6 Registry & manifest

- **Per-sim:** `simulations/<sim>.html` defines its experiments inline and passes them
  to `SimLib.Guided.mount(...)` alongside the adapter.
- **Site-wide:** `guided/manifest.js` exports lightweight metadata for the home page
  (sim id, experiment id, title, summary, subject, minutes), so `index.html` can show a
  "Guided" badge/count per sim without loading all sims. Keep the manifest generated by
  hand initially; later add a build/check script (`scripts/build-guided-manifest.mjs`)
  that scans `simulations/*.html` annotations to prevent drift.

---

## 4. Simulation integration contract

For a sim to support guided experiments it must provide (via `Guided.adapter`):

1. **Controls** — get/set + owning element + range/format for every control an
   experiment can touch.
2. **State** — read-only accessors for values an experiment can check.
3. **Actions** — at minimum `pause`, `resume`, `reset`; plus sim-specific ones
   (`release`, `addProton`, `ignite`, …).
4. **Targets** (optional) — canvas-space regions for callouts/spotlights.
5. **Lifecycle hook** — expose `app.guidedTick` (see §3.3) or let the runner poll.

**Backward compatibility:** `SimLib.Guided.mount` is only called by sims that opt in.
`Simulation._loop` gets one guarded optional call; sims without guided support see zero
behavior change (undefined hook is a no-op).

**Adapter helpers for common cases:** To reduce boilerplate, provide
`Guided.sliderAdapter({ sim, map: { length: ['lengthSlider', 'lengthValue', ...] } })`
that auto-wires range inputs whose `input` events already update sim state. Many sims
follow the same `bindSlider` pattern, so this should cover the majority.

---

## 5. File Plan

```
docs/guided-experiments-plan.md     ← this plan
guided.js                           ← engine: adapter, define, run, overlay components, richText
guided.css                          ← overlay/HUD/callout/modal/launcher styles (uses --sim-* tokens)
guided/manifest.js                  ← site-wide experiment metadata for the home page
simulations/<sim>.html              ← add adapter + definitions + mount() call (opt-in per sim)
main.css                            ← small additions (guided host positioning, fullscreen rules)
index.html / index.js               ← "Guided" badges + counts from manifest
scripts/build-guided-manifest.mjs   ← (later) generate/verify manifest
tests/                              ← see §8
```

Cache-busting: append `?v=4` to `guided.js`/`guided.css` when introduced, and bump the
shared `main.css?v=` when touched (matches the existing `v=3` convention).

---

## 6. Phased Roadmap

### Phase 0 — Spike & schema lock (0.5–1 day)
- Build a throwaway prototype on **Pendulum** proving: adapter, one message step, one
  condition step, spotlight on a slider, and HUD.
- Validate `CanvasUtils.logicalToCss` positioning at multiple sizes + fullscreen.
- Freeze the step schema and condition sugar based on what the spike needed.
- **Deliverable:** `docs/guided-experiments-plan.md` updated with any schema changes;
  decision recorded on naming.

### Phase 1 — Core engine (`guided.js`)
- `Guided.adapter`, `Guided.define`, `Guided.run`, `Guided.mount`.
- Step state machine: next/back/skip/exit/restart/goTo, `advance` modes.
- Condition evaluator with all sugar forms + `all/any/not/fn`.
- Setup application, highlight/allow gating, freeze semantics.
- `Simulation` hook (`app.guidedTick`) + bus events.
- Unit tests for the state machine and condition evaluator.
- **Exit criteria:** the Pendulum experiment from §3.2 runs end to end from a script,
  including auto-advance and gating.

### Phase 2 — Overlay UI + styles (`guided.css`)
- `Hud`, `Callout`, `Spotlight`, `Modal`, `Toast`, `Launcher`.
- Rich-text renderer.
- Responsive: desktop overlay, mobile bottom-sheet fallback, fullscreen integration.
- A11y pass: focus trap, `aria-live`, keyboard flows, reduced-motion.
- **Exit criteria:** Pendulum + Gas Laws lessons usable by keyboard only; no layout
  regressions at 360 / 768 / 1024 / fullscreen.

### Phase 3 — Roll out to a first wave of sims
Author 1–2 experiments each for sims with clear, curriculum-linked lessons:
- **Pendulum:** period vs. length; mass independence.
- **Gas Laws:** verify Boyle's law at constant T; Charles's law at constant P.
- **Projectile:** range vs. launch angle; complementary angles.
- **Titration:** find the equivalence point; strong vs. weak acid curve.
- **Circuits:** series vs. parallel equivalent resistance.
- **States of Matter:** map the heating curve / phase plateaus.
- **Build a Nucleus:** stability island (magic numbers), alpha vs. beta decay.

Each lesson reuses shared step types, so authoring should be mostly data.

### Phase 4 — Launcher & home-page surfacing
- `Guided.Launcher` wired on every sim page that has experiments.
- `guided/manifest.js` + home-page "Guided" badge/count derived from it.
- "Restart lesson"; completion recap with the student's predictions versus outcomes
  (in-session only).
- **Exit criteria:** a student can discover, start, complete, and exit a lesson without
  documentation; exiting cleanly restores free exploration.

### Phase 5 — Hardening & docs
- Cross-browser check (Chromium, Firefox, Safari; iOS Safari touch).
- Authoring guide (`docs/guided-experiments-authoring.md`) with the schema reference,
  adapter recipes, and copy-paste templates.
- Manifest verification script and CI-friendly check (the repo currently has no CI; keep
  it optional).
- Performance audit: no measurable frame drop while a lesson is active.

---

## 7. Worked Example — Pendulum "Period vs. Length"

The full definition appears in §3.2. Implementation steps in the existing file:

```html
<!-- simulations/pendulum.html, after SimLib.attach(...) -->
<script src="../guided.js?v=4"></script>
<script>
  const app = SimLib.attach({ /* unchanged */ });

  const adapter = SimLib.Guided.adapter(app.sim, {
    id: 'pendulum',
    controls: {
      length: { get: () => app.sim.length, set: v => setSlider(app, 'length', v),
                el: () => app.sim.lengthSlider, range: [0.3, 3.0],
                format: v => v.toFixed(2) + ' m' },
      mass:   { /* ... */ },
      gravity:{ /* ... */ },
      drag:   { /* ... */ },
      angle:  { /* ... */ },
    },
    state: {
      period: () => app.sim.measuredPeriod
                  ?? 2 * Math.PI * Math.sqrt(app.sim.length / app.sim.gravity),
      angle:  () => app.sim.angle * 180 / Math.PI,
    },
    actions: {
      release: () => { app.sim.paused = false; app.sim.pauseBtn.textContent = 'Pause'; },
      pause:   () => { app.sim.paused = true;  app.sim.pauseBtn.textContent = 'Resume'; },
      reset:   () => app.sim.reset(),
    },
    targets: {
      bob:   () => ({ ...app.sim._bobPos(), r: app.sim._bobPixelRadius() }),
      pivot: () => ({ x: app.sim.PIVOT_X, y: app.sim.PIVOT_Y, r: 12 }),
    },
    isPaused: () => app.sim.paused,
  });

  SimLib.Guided.mount({ app, adapter, experiments: [PeriodVsLength] });
  app.sim.start();
</script>
```

---

## 8. Testing Strategy

- **Unit (no DOM):** condition evaluator (all sugar + combinators + `fn`), step
  transitions for each `advance` mode, setup application, progress serialization.
- **Integration (DOM + canvas):** use a small headless-runner (e.g. Playwright) to:
  - start a lesson, assert HUD text and spotlight target,
  - programmatically move a control and assert auto-advance,
  - click through `predict` choices and assert feedback/recap,
  - exit and confirm the sim returns to its prior free-play state,
  - keyboard-only walkthrough.
- **Visual/regression:** screenshots at 360/768/1024/fullscreen for one lesson per
  layout family, plus a baseline screenshot of each sim *without* guided mode to prove
  no regressions.
- **Manual matrix:** touch drag on iOS Safari, `prefers-reduced-motion`, high-contrast,
  screen reader (NVDA/VoiceOver) smoke test.

If adding a test runner is out of scope for Phase 1, keep the engine's pure logic in
small functions that can be tested from the browser console with a simple assertion
harness (`tests/run.html`), matching the project's dependency-free ethos.

---

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Sims expose inconsistent internals | Adapter boilerplate per sim | Provide `Guided.sliderAdapter` recipe + standard pattern; document adapter checklist |
| Overlay misaligns after resize/fullscreen | Lesson points at wrong spot | Single positioning function; re-position on `resize` + `fullscreenchange`; test matrix |
| Gating frustrates/confuses students | Poor UX, abandonment | Always offer Skip/Exit; never trap focus; hint button; `allow` only when pedagogically necessary |
| Mutating sim state breaks physics invariants | Wrong results | Adapter `set` goes through the same code paths as normal controls (set slider + call existing update function) |
| Scope creep into LMS features | Schedule slip | Non-goals are explicit; in-memory only; no grading |
| Manifest drifts from sim definitions | Home page lies | Generate/verify manifest from annotations in Phase 5 |
| `library.js` grows unbounded | Harder maintenance | New `guided.js` module with a clear dependency direction (guided → SimLib, never the reverse) |

---

## 10. Decisions

The previously open questions are resolved for this iteration:

1. **Naming: "Guided Experiment".** Kept as the user-facing term. Code namespace is
   `SimLib.Guided`; CSS scope is `.guided-*`.
2. **Authoring location: inline.** Experiment definitions live inline in each
   `simulations/*.html` alongside the adapter and `Guided.mount(...)` call. No build step.
   Can migrate to separate files later if review/duplication becomes a problem.
3. **Gating: permissive.** Skip, Back, and Exit are always available. `allow` only dims
   and discourages, and is used sparingly; it never traps the student.
4. **Persistence: none for now.** Progress and answers are in-memory for the session;
   reload starts fresh. A visible Restart is still provided.
5. **Teacher mode: deferred.** Out of scope. The `choices[].correct` data remains in the
   schema so a future recap/answer-key feature can use it.
6. **Deep links / shareable state: deferred.** No `#guided=<id>` URLs or state encoding
   for now (e.g. no `youtube.com/watch`-style parameter linking).

Advanced capabilities — **verified completion, persistent progress, cross-visit resume,
and teacher tooling** — are intentionally reserved for a future update. See
[Future Work](#13-future-work).

---

## 11. Naming

"Guided Experiment" is the agreed term.

- **User-facing term:** "Guided Experiment". Card CTA: **Start**.
- **Code namespace:** `SimLib.Guided` (`Guided.adapter`, `Guided.define`, `Guided.run`,
  `Guided.mount`, `Guided.Hud`, …).
- **CSS scope:** `.guided-*`, reusing `--sim-*` design tokens from `main.css`.

---

## 12. Definition of Done (first release)

- `guided.js` + `guided.css` ship and are loaded only by sims that opt in.
- Pendulum and Gas Laws each have at least one complete, tested lesson.
- Launcher appears on supported sim pages; home page shows a Guided count.
- Lessons are keyboard- and screen-reader-navigable, responsive, and fullscreen-safe.
- Exiting a lesson restores free exploration with no leftover overlay or gating.
- No persistence, deep links, or teacher mode are required (explicitly deferred).
- Authoring guide + schema reference exist, and the plan's decisions are reflected in code.

---

## 13. Future Work

Explicitly out of scope for this iteration, but the architecture leaves room for them:

- **Verified completion** — trustworthy, tamper-resistant step completion (e.g. requiring
  observed simulation state rather than a tapped Next button).
- **Persistent progress** — `localStorage`/account-backed progress, cross-visit resume,
  and "Resume" CTAs on the launcher.
- **Deep links / shareable state** — `simulations/<sim>.html#guided=<id>` and encoded
  step/answer state so teachers can share a specific point in a lesson.
- **Teacher mode** — answer keys, printable/summary recaps, and assignment links, using
  the existing `choices[].correct` data.
- **Analytics** — optional, privacy-respecting completion stats.
- **Separate authoring files** — migrate inline definitions to `guided/<sim>.js` if the
  inline approach becomes unwieldy.
- **Generated manifest** — build/verify `guided/manifest.js` from source annotations to
  prevent drift.
