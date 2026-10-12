# Authoring guided experiments

This guide describes the **implemented API**, not every feature proposed in the [design plan](guided-experiments-plan.md). Use `simulations/pendulum.html` as the complete working example. Lessons are trusted, in-repository JavaScript definitions; there is no build step or external lesson loader.

## 1. Opt a simulation in

Load the guided stylesheet alongside the simulation styles, and load the engine **after** `library.js`:

```html
<link rel="stylesheet" href="../guided.css?v=5">
<script src="../library.js?v=5"></script>
<script src="../guided.js?v=5"></script>
```

Keep asset versions consistent with the page's current cache-busting convention. Create the adapter and lessons after `SimLib.attach` has produced `app` and initialized `app.sim`. The shared simulation loop calls `app.guidedTick(dt)` automatically; do not add another animation loop. Custom loops must forward elapsed seconds themselves.

## 2. Expose a semantic adapter

The adapter is the only place that should know simulation fields and DOM IDs. Definitions use names such as `length` and `release`, not selectors.

```js
const sim = app.sim;
const adapter = SimLib.Guided.adapter(sim, {
  id: 'my-sim',
  controls: {
    length: {
      get: () => sim.length,
      set: value => {
        sim.length = value;
        sim.lengthSlider.value = value;
        sim.lengthValue.textContent = value.toFixed(2) + ' m';
        // Also invalidate measurements affected by this change.
      },
      el: () => sim.lengthSlider,
      range: [0.3, 3],
      format: value => value.toFixed(2) + ' m',
    },
  },
  elements: { release: () => sim.pauseBtn },
  state: { paused: () => sim.paused ? 1 : 0 },
  actions: {
    pause: () => { sim.paused = true; sim.pauseBtn.textContent = 'Resume'; },
    resume: () => { sim.paused = false; sim.pauseBtn.textContent = 'Pause'; },
  },
  isPaused: () => sim.paused,
});
```

- `controls`: numeric `get`/`set` functions, with optional DOM element/getter, `range`, and `format`. Setters must update both physics and UI. Ranges are metadata, **not automatic clamping**.
- `elements`: DOM elements/getters for buttons or other interactions that can be highlighted or gated.
- `state`: read-only numeric getters for measurements and flags. Use `0`/`1` for booleans.
- `actions`: semantic functions. Provide `pause` and `resume` if using frozen steps.
- `targets`: getters returning logical canvas coordinates, either `{ x, y, r }` or `{ x, y, w, h }`, for canvas highlights.
- `isPaused`: defaults to `!!sim.paused`.
- `setLocked(locked)`: optional canvas-interaction lock. If used, verify it is released on both exit and completion; DOM gating does not replace canvas input handling.

For action-based conditions, notify the engine from the real user action handler with `SimLib.Guided.action('release')`. It is safe when no lesson is active. An adapter action function does not automatically send this notification. State-based conditions are often simpler.

## 3. Define and mount a lesson

```js
const lesson = SimLib.Guided.define({
  id: 'my-sim-length',
  title: 'Investigate string length',
  summary: 'Change one variable and observe the result.',
  subject: 'Physics',
  level: 'Intro',
  minutes: 3,
  tags: ['experimental design'],
  setup: { controls: { length: 1 }, action: 'pause' },
  steps: [
    {
      id: 'intro', type: 'message', title: 'Change one variable',
      body: 'We will test **length**, keeping other variables fixed.',
    },
    {
      id: 'adjust', type: 'task', title: 'Set length to 2 m',
      body: 'Use the length slider or its arrow keys.',
      highlight: ['length'], allow: ['length'], freeze: true,
      hint: 'Focus the slider and use the arrow keys.',
      when: { control: 'length', near: 2, tolerance: 0.02 },
    },
    {
      id: 'finish', type: 'conclusion', title: 'Ready to explore',
      body: 'You changed one variable. Now investigate its effect.',
    },
  ],
});

const guided = SimLib.Guided.mount({ app, adapter, experiments: [lesson] });
```

`define` requires an experiment ID and a nonempty steps array. Every step needs a unique ID and a supported type. Give experiments unique IDs too. Validation is deliberately limited: check all adapter names and condition/choice fields yourself.

`mount` adds the launcher and overlay. Optional `launcherMount` is a selector or element; `overlayRoot` is an element (keep it within the fullscreen container). Defaults are the page-header container for the launcher and the canvas's `.sim-main` ancestor for the overlay. An empty experiment list returns `null`. The returned object exposes `launcher`, `overlay`, `start(lesson)`, `runner`, and `activeExperiment`.

## 4. Step reference

| Type | Presentation | Default advancement |
| --- | --- | --- |
| `message` | Instruction dialog | `on-next` |
| `task` | Task card | `on-condition` |
| `observe` | Observation card | `on-condition` |
| `predict` | Choices dialog | `on-answer` |
| `checkpoint` | Choices dialog | `on-answer` |
| `conclusion` | Closing dialog | `on-next` |

Common fields:

- `title`, `body`: student-facing text.
- `highlight: ['name']`: adapter control, element, or canvas-target names. Highlights also provide anchored callouts on nonmodal steps.
- `allow`: `null`/omitted leaves registered controls available; an array limits interaction to those names. `[]` gates all registered interactive elements. Unregistered controls are not gated.
- `freeze: true`: pauses on entry and resumes on departure only if the simulation was previously running.
- `hint`: revealed through the HUD hint button.
- `when`: completion condition for `on-condition` steps.
- `advance`: override with `on-next`, `on-answer`, or `on-condition`.
- `choices`, `feedback`: legacy prediction/checkpoint content (see below).
- `question`: a shared CFU bank question for a practice-only `checkpoint` (see section 9). Do not combine with legacy `choices`.

Skip is currently available on every step; `optional` does not restrict it. Back re-enters a step but does not undo simulation changes. Restart reapplies setup and clears answers. Exit removes the lesson UI/gating, but **does not restore a full pre-lesson simulation snapshot**. Do not promise rollback.

## 5. Conditions

```js
{ control: 'length', near: 2, tolerance: 0.02 }
{ control: 'length', min: 1.9, max: 2.1 }
{ control: 'length', changedBy: 0.5 }
{ state: 'paused', equals: 0 }
{ state: 'period', settles: true, tolerance: 0.12, minElapsed: 6 }
{ action: 'release' }
{ all: [{ state: 'paused', equals: 0 }, { control: 'length', min: 2 }] }
{ any: [{ action: 'release' }, { state: 'paused', equals: 0 }] }
{ not: { state: 'paused', equals: 1 } }
```

Controls support `near`/`tolerance`, `equals`, `min`, `max`, `changed`, and `changedBy`. Changes are measured from **step entry**; `changedBy` is an absolute difference. State supports `equals`, `min`, `max`, and `settles`. A bare control/state name without a comparison does not complete a step. An array of conditions means `all`.

Put `minElapsed` and settling `tolerance` on the **top-level** `when` object, including when using combinators. Settling uses a rolling 1.2-second window, requires at least six samples spanning 0.8 seconds, and checks the value's range. Default tolerance is the larger of 0.02 and 2% of the window midpoint. Stability is not proof that a real measurement was taken: expose measurement readiness explicitly when necessary.

For an unusual condition, use `when: { fn: ctx => ... }`. Context includes `adapter`, `baseline`, `settle`, `lastAction`, `elapsed`, and `answers`. Keep callbacks cheap and side-effect-free. Conditions advance immediately when met; use sensible tolerances and a minimum observation time.

## 6. Predictions and feedback

```js
{
  id: 'prediction', type: 'predict', title: 'What do you expect?',
  body: 'What happens when the string gets longer?',
  choices: [
    { id: 'longer', label: 'The period increases', correct: true },
    { id: 'same', label: 'The period stays the same' },
  ],
  feedback: {
    correct: 'Good prediction. Let us test it.',
    any: 'Keep your prediction in mind as you observe.',
  },
}
```

Use unique choice IDs and plain-text labels. Default `on-answer` shows feedback and enables Next after **any** answer; it does not require correctness. Answers are stored by step ID and displayed in the completion recap. For a correctness-gated checkpoint, `advance: 'on-condition'` advances after a correct choice (with a short delay); Skip still remains available. Legacy prediction answers remain in memory. Standalone CFU checks use a separate locally persisted result (section 9); lesson practice never contributes to that score.

## 7. Text and pedagogy

Titles, bodies, hints, summaries, and feedback support a small Markdown subset: `**bold**`, `*italic*`, inline backticks, `[links](https://example.com)`, bullet lists, blank-line paragraphs, and line breaks. HTML is treated as text. Use the engine's DOM rendering rather than injecting HTML from `Guided.richText` yourself.

Prefer one learning objective and one action per step. State units, hold confounding variables fixed, and distinguish theoretical values from measured values. Use prediction → manipulation → observation → explanation. Keep instructions usable without relying only on color or pointing at a canvas object.

## 8. Verify before publishing

1. Run `node --test tests/*.test.mjs` and add tests for new behavior.
2. Serve the repository (for example `python -m http.server 8000`) and open the simulation and `tests/dom-smoke.html`.
3. Complete the lesson with mouse, touch, and keyboard; check focus, hints, gated controls, and Escape.
4. Test Back, Skip, Restart, Exit, and completion/Done, including while dialogs are open. Confirm DOM and canvas interaction are restored.
5. Check narrow mobile, tablet, desktop, fullscreen, resize, and theme changes. Ensure cards/callouts do not hide required controls.
6. Confirm free exploration is unchanged before starting and after leaving; inspect the console and frame performance.

Current automated tests use isolated engine contexts and a lightweight DOM shim. Passing them does not replace real-browser accessibility, layout, or performance checks.

## 9. Shared Check Understanding (CFU) questions

Load `cfu.css?v=1`, then `library.js`, `cfu.js?v=1`, the simulation's bank file, and `guided.js?v=6`. CFU is opt-in; legacy lessons do not require it. The Pendulum bank is `simulations/pendulum-cfu.js`.

```js
const bank = SimLib.CFU.bank({
  id: 'my-sim-period', version: 1,
  questions: [{
    id: 'variables', use: 'both', type: 'multi',
    prompt: 'Which variables set the ideal small-angle period?',
    choices: [
      { id: 'length', label: 'Length' },
      { id: 'gravity', label: 'Gravity' },
      { id: 'mass', label: 'Mass' },
    ],
    correct: ['length', 'gravity'],
    explanation: 'T = 2π√(L/g); mass is absent from this approximation.',
  }],
});
// Within the normal Guided.define steps array:
const checkpoint = {
  id: 'practice-variables', type: 'checkpoint', title: 'Check the relationship',
  question: bank.questions.find(q => q.id === 'variables'),
};
```

Bank IDs and question/choice IDs must be stable and unique. `version` is a positive integer. Each question has `use: 'lesson' | 'assessment' | 'both'`, `type: 'single' | 'multi'`, a prompt, at least two choices, a nonempty `correct` array of choice IDs, and an explanation. Single-choice keys have exactly one answer. Bank creation rejects missing/duplicate IDs, invalid tags/types, and malformed keys. Questions are frozen after validation. CFU text is plain text rendered through DOM nodes, not HTML or Markdown.

Both modes use **explicit Submit answer**, followed by immediate correctness, the correct answer, explanation, and **Continue**. Multi-choice grading is exact-set matching: missing or extra selections are incorrect; there is no partial credit. Empty answers cannot be submitted. Submit locks all choices, even for incorrect answers. In a lesson, Back/re-entry preserves that lock until **lesson restart**; HUD Next is hidden and runner advancement blocked before submission. Deliberate lesson Skip remains available. These checkpoints are practice only, with no standalone score or persistence. Legacy `predict`/`choices` behavior is unchanged.

Mount a standalone check separately:

```js
let check;
const guided = SimLib.Guided.mount({
  app, adapter, experiments: [lesson],
  beforeStart: () => { if (check) check.close(); },
});
check = SimLib.CFU.mount({
  bank,
  host: document.getElementById('my-cfu-host'),
  beforeOpen: () => { if (guided.runner) guided.runner.exit(); },
});
```

`mount` returns `session`, `panel`, `launcher`, `open()`, `close()`, and `destroy()`. Optional `launcherHost` defaults to `host`. Mount within the simulation's fullscreen container, **not the reference sidebar** (which fullscreen hides). Pendulum mounts in its scrollable controls panel. The standalone panel is non-modal: it does not pause, reset, gate, or otherwise modify the simulation. The hooks above ensure a lesson and standalone panel cannot be open together; closing a check preserves its progress.

Standalone questions are the `assessment`/`both` entries, in authored bank order, without randomization. Each is scored once. Final Continue displays score and a full review (prompt, selected answers, correct answers, correctness, and explanation). Restart starts a fresh attempt while retaining the latest completed result; a prior result's score remains visible during the new attempt.

### Persistence and privacy

Only standalone progress is persisted. The key is `commonlab:cfu:<bank.id>`. A JSON envelope contains `schema: 1`, `bankVersion`, `active` (question index, drafts, submitted answers/lock), and `latest` (answers and completion timestamp). Scores are recalculated from validated answers, not trusted from storage. Unfinished checks resume when the launcher is opened, including locked submitted answers awaiting Continue. The latest completed review is reopened when there is no unfinished attempt.

**Bump the bank version whenever content, keys, question/choice IDs, or order change.** Schema or bank-version mismatches invalidate old progress/results. Corrupt JSON or invalid records are ignored safely; valid completed and active records are validated independently. Missing/denied storage and quota errors do not stop the check; an unavailable-storage message indicates that progress is only reliable for this visit. There is no server, account, submission, or cross-device synchronization. Local records are not tamper-proof grading evidence.

Verify keyboard radio/checkbox selection, explicit submit, feedback announcements, focus on checkpoint entry and Continue, Back/re-entry locks, Skip, both restart types, and mutual exclusion. Test reload before/after submit, final review, bank-version changes, corrupt storage, storage denial/quota, and fullscreen scrolling. `tests/cfu.test.mjs` covers the core contracts in Node; real-browser layout/accessibility checks remain necessary.
