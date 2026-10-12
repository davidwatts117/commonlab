# CommonLab

Browser-based science simulations for safe, repeatable exploration. Open `index.html` through a static web server; no build step or login is required.

```sh
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Guided experiments / lessons

The shared engine (`guided.js`) and overlay styles (`guided.css`) are implemented. The Pendulum simulation includes the first pilot lesson, **“What controls a pendulum’s period?”**, with predictions, guided tasks, observation, three practice-only CFU checkpoints, hints, restart/exit, and a completion recap.

### Check Understanding

Pendulum also has a **Check Understanding** launcher in its controls panel. This non-modal self-check keeps the simulation usable and asks five fixed-order questions about length, mass, gravity, and the ideal small-angle period. Single- and multi-choice answers require explicit submission, lock until restart, and show immediate explanations. Finish for a score and full answer review.

- Shared engine/styles: `cfu.js`, `cfu.css`; authored bank: `simulations/pendulum-cfu.js`.
- Lesson practice and standalone scoring share bank content but keep their answers separate. Opening either mode closes the other.
- Versioned localStorage resumes unfinished standalone checks and retains the latest completed result. Corrupt/unavailable storage is handled safely; there is no backend or cross-device synchronization.
- See [CFU authoring and persistence](docs/guided-experiments-authoring.md#9-shared-check-understanding-cfu-questions) for schema, integration, versioning, and verification.

- [Authoring guide](docs/guided-experiments-authoring.md): current API, integration example, conditions, and verification checklist.
- [Implementation plan](docs/guided-experiments-plan.md): broader design and planned rollout. Some proposed features are not implemented; consult the authoring guide for current behavior.

### Remaining work

- **Expand lesson coverage:** integrate Gas Laws as the second pilot, then author and wire lessons for the other simulations identified in the plan.
- **Add homepage discovery:** create `guided/manifest.js` and use its metadata to show guided badges/counts and help students find lessons from the homepage. Manifest generation/verification tooling can follow later.
- **Complete real-browser validation:** verify end-to-end lesson flows, keyboard accessibility, mobile/tablet/desktop layouts, fullscreen and resize behavior, and free-exploration cleanup. Add visual-regression coverage and perform a performance audit. The DOM smoke page and automated tests are a starting point, not a substitute for these checks.

The authoring guide is now available. The broader rollout and validation above remain outstanding.

## Tests

Requires Node.js with the built-in test runner:

```sh
node --test tests/*.test.mjs
```

For browser smoke checks, serve the repository and open `tests/dom-smoke.html`. Automated coverage includes the guided engine, launcher, restart/completion, overlay/dialog behavior, and CFU bank validation, exact-match grading, submit locks/re-entry, persistence/version invalidation, storage failures, full review, and mutual exclusion using a lightweight DOM shim. Real-browser accessibility, mobile layout, and fullscreen checks remain manual verification work.
