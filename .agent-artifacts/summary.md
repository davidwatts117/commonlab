# Issue #20: Contributor account creation discovery

Added visible **Create contributor account** and **Sign in** links to the homepage navigation. The creation link opens `/account.html?action=register` with password confirmation, new-password autocomplete, and the Create account button already enabled for registration. Existing account URLs still default to sign-in; unknown action values also safely fall back to sign-in. The existing Action selector and authenticated-session behavior remain intact.

Updated `docs/contributors.md` and added real-browser regression coverage for desktop/mobile discovery, registration defaults, switching modes, unknown actions, existing sessions, and registration/logout/sign-in through the homepage links. The new discovery test failed before the fix because the homepage link was missing.

## Validation

All requested checks passed:
- `cargo fmt --check`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo test --locked` — 32 tests passed
- `npm test` — 47 tests passed
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser` — 24 tests passed

Rust tools required adding `/home/agent/.cargo/bin` to PATH in this environment. Also exercised the running app in headed Chromium at desktop and phone sizes, checked for horizontal overflow, and inspected these actual screenshots (empty account fields; no credentials/private data):
- [Desktop homepage](homepage-account-desktop.png)
- [Mobile homepage](homepage-account-mobile.png)
- [Mobile registration reached from the homepage](registration-mobile.png)

## Scope and caveats

The title-only issue was interpreted as a discoverability problem, not a request to redesign authentication. Changes are limited to navigation, initial form mode, documentation, and tests; account APIs, permissions, password rules, and submission behavior are unchanged. Browsing simulations still requires no account. No blocking ambiguities were found.
