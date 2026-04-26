# Browser / Computer Workbench Smoke

## Goal

Validate the Phase 2 closing path for browser/computer workbench behavior without external network access or real desktop actions.

The smoke covers:

- system Chrome + CDP as the primary browser acceptance provider
- managed browser launch with `provider=system-chrome-cdp` in headless mode by default
- `browser_action.navigate` to an isolated `data:` URL
- `browser_action.get_dom_snapshot` returning the smoke heading and button
- `browser_action.get_workbench_state` exposing a running managed session
- `computer_use.get_state` and `computer_use.observe` returning Computer Surface state without requesting app action approval

## Command

Full suite:

```bash
npm run acceptance:browser-computer-all
```

Optional:

```bash
npm run acceptance:browser-computer-all -- --visible
npm run acceptance:browser-computer-all -- --skip-build
npm run acceptance:browser-computer-all -- --provider system-chrome-cdp
npm run acceptance:browser-computer-all -- --skip-background-ax
npm run acceptance:browser-computer-all -- --skip-background-cgevent
```

System Chrome/CDP provider smoke:

```bash
npx tsx scripts/acceptance/browser-computer-system-chrome-smoke.ts
```

Optional:

```bash
npx tsx scripts/acceptance/browser-computer-system-chrome-smoke.ts --visible
npx tsx scripts/acceptance/browser-computer-system-chrome-smoke.ts --json
```

Phase 2 smoke:

```bash
npm run acceptance:browser-computer
```

Optional:

```bash
npm run acceptance:browser-computer -- --visible
npm run acceptance:browser-computer -- --provider system-chrome-cdp
npm run acceptance:browser-computer -- --json
```

Phase 3 workflow smoke:

```bash
npm run acceptance:browser-computer-workflow
```

Optional:

```bash
npm run acceptance:browser-computer-workflow -- --visible
npm run acceptance:browser-computer-workflow -- --provider system-chrome-cdp
npm run acceptance:browser-computer-workflow -- --json
```

Phase 4 UI smoke:

```bash
npm run acceptance:browser-computer-ui
```

Optional:

```bash
npm run acceptance:browser-computer-ui -- --json
```

App-host AbilityMenu smoke:

```bash
npm run acceptance:browser-computer-app-host
```

Optional:

```bash
npm run acceptance:browser-computer-app-host -- --visible
npm run acceptance:browser-computer-app-host -- --skip-build
npm run acceptance:browser-computer-app-host -- --provider system-chrome-cdp
npm run acceptance:browser-computer-app-host -- --json
```

Background CGEvent smoke:

```bash
npm run acceptance:browser-computer-background-cgevent
```

Optional:

```bash
npm run acceptance:browser-computer-background-cgevent -- --json
npm run acceptance:browser-computer-background-cgevent -- --keep-target
```

## Pass Criteria

The full suite passes only when the System Chrome/CDP smoke, Phase 2 smoke, Phase 3 workflow smoke, Background AX smoke on macOS, Background CGEvent smoke on macOS, Phase 4 UI smoke, and app-host AbilityMenu smoke all pass in sequence.
On non-macOS, Background AX and Background CGEvent remain opt-in through `--include-background-ax` and `--include-background-cgevent`.

For the System Chrome/CDP provider smoke:

- System Chrome launches as the provider, not Playwright's bundled Chromium executable.
- Chrome exposes a CDP endpoint on `127.0.0.1`.
- A real isolated `data:` page opens through that CDP session.
- DOM readback confirms `System Chrome CDP Smoke` and `#system-chrome-cdp-button`.

- Browser session is running during the smoke.
- Browser provider is `system-chrome-cdp` unless explicitly overridden.
- Browser mode is `headless` unless `--visible` is passed.
- Active tab is the isolated smoke `data:` URL.
- DOM snapshot contains `Phase2 Smoke`.
- DOM snapshot contains `#phase2-smoke-button`.
- Computer Surface state is returned.
- Computer Surface observe snapshot is returned.

For the Phase 3 workflow smoke:

- Browser session is running during the workflow.
- Initial DOM snapshot contains `#phase3-workflow-button`.
- `browser_action.click` clicks only the isolated workflow button.
- Page readback changes to `Clicked`.
- Click trace records `targetKind=browser`, `action=click`, the clicked selector, browser mode, and success.
- `computer_use.get_state` remains read-only and does not create an action trace.

For the Background AX action smoke:

- `clang` builds a temporary native Cocoa target named `CodeAgentAXSmokeTarget`.
- The target app exposes a text field and `Run AX Smoke` button through macOS Accessibility.
- `computer_use.get_ax_elements` returns `axPath` locators for both target elements.
- `computer_use.type` sets the text field through `targetApp + axPath` with `computerSurfaceMode=background_ax`.
- `computer_use.click` presses the button through `targetApp + axPath` with `computerSurfaceMode=background_ax`.
- A state file readback confirms `clicked;button=Run AX Smoke;input=typed-by-background-ax`.
- macOS full suite runs this smoke by default. Use `--skip-background-ax` to skip it on macOS; use `--include-background-ax` to opt in on non-macOS.

For the Background CGEvent action smoke:

- `clang` builds a temporary native Cocoa target named `CodeAgentCGEventSmokeTarget`.
- The target app handles mouseDown in a custom view and writes a state file, without relying on AX element names.
- `computer_use.get_windows` returns a target `pid`, `windowId`, and window bounds for the temporary app.
- `computer_use.click` sends a background CGEvent through `targetApp + pid + windowId + windowLocalPoint` with `computerSurfaceMode=background_cgevent`.
- A state file readback confirms `clicked;count=1`.
- The target app is not frontmost immediately before the click.
- macOS full suite runs this smoke by default. Use `--skip-background-cgevent` to skip it on macOS; use `--include-background-cgevent` to opt in on non-macOS.

For the Phase 4 UI smoke:

- System Chrome is launched headless and connected through CDP.
- Real `ToolCallDisplay` markup renders in Chrome.
- Action preview includes action summary, target, browser mode, and trace id.
- Grouped tool step rendering preserves trace metadata.
- Typed input text is absent from visible text and raw HTML.
- Redacted argument text is visible as character-count based placeholders.

For the app-host AbilityMenu smoke:

- `dist/web/webServer.cjs` serves the real built renderer from `dist/renderer`.
- System Chrome is launched headless and connected through CDP.
- The real ChatInput `AbilityMenu` opens inside the app-host UI.
- The Managed repair request sends `provider=system-chrome-cdp` to `ensureManagedBrowserSession`.
- Managed mode shows the blocked state and repair actions before launch.
- The Managed repair action starts a real managed browser session and returns to `Ready / Running`.
- Browser failure cards render executable recovery actions for safe setup work: start Managed browser,补齐 Managed tab, or refresh DOM / Accessibility snapshot evidence.
- Clicking a Browser/Computer failure-card Recovery Action shows an explicit `preparing` / `success` / `failed` status, then renders the prepared evidence summary without auto-retrying the failed action.
- Snapshot recovery success shows DOM heading count, interactive element count, and whether Accessibility snapshot evidence is available.
- Managed mode explains the surface as `Managed browser`, shows `System Chrome via CDP` / `Playwright bundled Chromium` as provider copy, and frames repair buttons as next-step actions rather than raw provider commands.
- Desktop mode renders unprobed readiness separately from denied state and exposes repair actions without clicking foreground desktop or opening macOS settings.
- Computer failure cards only expose safe recovery actions: open Desktop status, observe the current window, or list AX candidates for a named target app. Foreground fallback remains a manual step.
- Desktop action metadata uses `backgroundSurface`, `foregroundFallback`, `requiresForeground`, `approvalScope`, `targetApp`, and redacted params instead of exposing typed text.

Additional renderer/unit tests cover replay, export, observability summaries, provider copy, background Accessibility candidate rendering, and Browser/Computer metadata redaction outside the app-host smoke.

## Safety Boundary

This smoke does not click, type, scroll, drag, or operate the foreground desktop. It only reads Computer Surface state and frontmost context.

The Phase 3 workflow smoke performs one click inside the managed browser on an isolated `data:` URL. It still does not click, type, scroll, drag, or operate the foreground desktop.

The optional Background AX action smoke performs one type and one click against a temporary native target app that it creates and cleans up. It does not operate Finder, Chrome, or the current foreground work app; Finder activation is used only to ensure the target app is not frontmost before the background actions.

The optional Background CGEvent action smoke performs one click against a temporary native target app that it creates and cleans up. It does not operate Finder, Chrome, or the current foreground work app; Finder activation is used only to ensure the target app is not frontmost before the background click. Real closed-source app debugging must start with an explicit `get_windows` selection and a user-approved `pid + windowId + windowLocalPoint` action.

The Phase 4 UI smoke does not execute `browser_action` or `computer_use`. It renders isolated HTML in system Chrome headless and checks the UI privacy/readability contract through DOM text and raw HTML inspection.

The app-host AbilityMenu smoke starts the web app host and one managed browser session. It does not click, type, scroll, drag, or operate the foreground desktop. Recovery actions are limited to starting or completing the managed browser session, refreshing browser DOM / Accessibility evidence, opening Desktop status, observing window state, or listing AX candidates.

When Computer Surface reports `foreground_fallback`, product copy must treat it as an action on the current foreground app/window. It is not a background or isolated surface.

When Computer Surface reports `background_ax`, product copy must treat it as a macOS Accessibility surface for a specified app/window. It can enumerate accessible elements with `get_ax_elements`, then press or set elements addressed by `targetApp` plus the returned `axPath` or `role` / `name` / `selector`; coordinate mouse actions still use the foreground fallback.

When Computer Surface reports `background_cgevent`, product copy must treat it as a selected macOS window surface. It can enumerate visible windows with `get_windows`, then click only the specified `pid + windowId` at a window-local point. It is meant for black-box / closed-source app debugging where AX elements are unavailable or poor.

## Failure Classification

Acceptance failures should distinguish the browser provider path from the automation library path:

- `missing_playwright_executable`: BrowserService fell back to Playwright-managed Chromium and that executable is missing. Either keep the acceptance path on `provider=system-chrome-cdp`, or install the Playwright browser with `npx playwright install chromium`.
- `system_chrome_unavailable`: Google Chrome itself is missing, cannot start, exits before CDP is ready, or cannot expose `127.0.0.1:<port>`. Install Chrome or set `CODE_AGENT_SYSTEM_CHROME_PATH` / `CHROME_PATH`.
