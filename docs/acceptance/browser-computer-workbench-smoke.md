# Browser / Computer Workbench Smoke

## Goal

Validate the Phase 2 closing path for browser/computer workbench behavior without external network access or real desktop actions.

The smoke covers:

- managed browser launch in headless mode by default
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
```

Phase 2 smoke:

```bash
npm run acceptance:browser-computer
```

Optional:

```bash
npm run acceptance:browser-computer -- --visible
npm run acceptance:browser-computer -- --json
```

Phase 3 workflow smoke:

```bash
npm run acceptance:browser-computer-workflow
```

Optional:

```bash
npm run acceptance:browser-computer-workflow -- --visible
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
npm run acceptance:browser-computer-app-host -- --json
```

## Pass Criteria

The full suite passes only when the Phase 2 smoke, Phase 3 workflow smoke, and Phase 4 UI smoke all pass in sequence.
The app-host AbilityMenu smoke is part of the full suite and runs after the component-level UI smoke.

- Browser session is running during the smoke.
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

For the optional Background AX action smoke:

- `clang` builds a temporary native Cocoa target named `CodeAgentAXSmokeTarget`.
- The target app exposes a text field and `Run AX Smoke` button through macOS Accessibility.
- `computer_use.get_ax_elements` returns `axPath` locators for both target elements.
- `computer_use.type` sets the text field through `targetApp + axPath` with `computerSurfaceMode=background_ax`.
- `computer_use.click` presses the button through `targetApp + axPath` with `computerSurfaceMode=background_ax`.
- A state file readback confirms `clicked;button=Run AX Smoke;input=typed-by-background-ax`.

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
- Managed mode shows the blocked state and repair actions before launch.
- The Managed repair action starts a real managed browser session and returns to `Ready / Running`.
- Desktop mode renders unprobed readiness separately from denied state and exposes repair actions without clicking foreground desktop or opening macOS settings.
- Desktop mode labels Computer Surface as background Accessibility when available, or foreground fallback when the action cannot be addressed by app/window accessibility.
- Background Accessibility discovery is read-only: `get_ax_elements` enumerates bounded role/name candidates with `axPath` locators before any background action is chosen.
- Background Accessibility action proof is opt-in: `npm run acceptance:browser-computer-background-ax` or `npm run acceptance:browser-computer-all -- --include-background-ax` launches a temporary native target app and verifies `axPath` type/click readback.
- Desktop action metadata uses `backgroundSurface`, `foregroundFallback`, `requiresForeground`, `approvalScope`, `targetApp`, and redacted params instead of exposing typed text.

## Safety Boundary

This smoke does not click, type, scroll, drag, or operate the foreground desktop. It only reads Computer Surface state and frontmost context.

The Phase 3 workflow smoke performs one click inside the managed browser on an isolated `data:` URL. It still does not click, type, scroll, drag, or operate the foreground desktop.

The optional Background AX action smoke performs one type and one click against a temporary native target app that it creates and cleans up. It does not operate Finder, Chrome, or the current foreground work app; Finder activation is used only to ensure the target app is not frontmost before the background actions.

The Phase 4 UI smoke does not execute `browser_action` or `computer_use`. It renders isolated HTML in system Chrome headless and checks the UI privacy/readability contract through DOM text and raw HTML inspection.

The app-host AbilityMenu smoke starts the web app host and one managed browser session. It does not click, type, scroll, drag, or operate the foreground desktop. Desktop repair actions are only checked as visible UI actions; they are not executed.

When Computer Surface reports `foreground_fallback`, product copy must treat it as an action on the current foreground app/window. It is not a background or isolated surface.

When Computer Surface reports `background_ax`, product copy must treat it as a macOS Accessibility surface for a specified app/window. It can enumerate accessible elements with `get_ax_elements`, then press or set elements addressed by `targetApp` plus the returned `axPath` or `role` / `name` / `selector`; coordinate mouse actions still use the foreground fallback.
