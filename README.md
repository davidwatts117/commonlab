# CommonLab

Browser-based science simulations for safe, repeatable exploration. Open `index.html` through a static web server; no build step or login is required.

```sh
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Guided experiments / lessons

The shared engine (`guided.js`) and overlay styles (`guided.css`) are implemented. The Pendulum simulation includes the first pilot lesson, **“What controls a pendulum’s period?”**, with predictions, guided tasks, observation, hints, restart/exit, and a completion recap.

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

For browser smoke checks, serve the repository and open `tests/dom-smoke.html`. Automated coverage currently includes the guided engine, launcher, restart/completion, and overlay/dialog behavior using a lightweight DOM shim.
