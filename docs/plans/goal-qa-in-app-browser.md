# Goal: In-App Browser Preview QA Default

## Objective

Make design/artifact preview QA use the product managed browser path by default, serving artifacts through `webServer` `/api/workspace/file` and reusing the same deterministic probe and evaluator as the self-started Chrome fallback.

## Boundaries

- Do not touch `isDesignDraftWorkingDir` repair-guard exemption.
- Do not split or bypass the `useAgentIPC` design guard.
- Do not change ADR-026's main-process no-mutation invariant.
- Do not introduce Neo scratch-directory paths.
- Do not change evaluator thresholds or fork `evaluateArtifactPreviewHealthDiagnostics`.
- Do not push, merge, or alter the occupied main worktree.

## Key Design Decisions

- `runArtifactPreviewHealth` remains the public default health runner.
- In-app route is attempted first; self-started Chrome remains fallback.
- Both routes call the same shared probe and the same evaluator.
- Page defects are findings; infrastructure failures are fallback reasons.
- In-app QA runs in an isolated managed browser context so artifact cookies, storage, and session state do not pollute the user's current browser session.
- In-app QA must avoid visible focus theft; if a visible managed browser is unavoidable, it must restore the user's active state and close only QA-owned resources.
- `/api/workspace/file` URLs and logs must redact `token` query values.
- Relative resources are routed through `webServer` and normalized for parity evidence.
- Parity tests must include relative image, CSS, JS, nested directories, and one broken image.
- Engine differences between in-app browser and fallback Chromium must be recorded honestly if they appear; probe/evaluator thresholds stay unchanged.

## Gates

### Gate 0 - Isolated Worktree

- Worktree: `/Users/linchen/Downloads/ai/code-agent-inapp-qa`
- Branch: `feat/qa-in-app-browser`
- Base: `origin/main@6bb8e4b0b54e5e01307c1b65bea3f9268ed5f26e`
- `node_modules` symlinked from `/Users/linchen/Downloads/ai/code-agent/node_modules`
- Initial status: clean
- Initial footprint: `git status --short --untracked-files=all | wc -l` = 0, `git diff --name-only | wc -l` = 0, `git ls-files --others --exclude-standard | wc -l` = 0

Status: passed.

### Gate 1 - Shared Probe And Fallback Preservation

Acceptance:
- Extract the DOM measurement probe from the self-started runner into a shared module.
- Keep self-started Chrome behavior available as explicit fallback runner.
- Unit coverage proves both paths feed `evaluateArtifactPreviewHealthDiagnostics`.

Evidence:
- Added `src/main/agent/runtime/browser/artifactPreviewHealthProbe.ts`.
- Added `src/main/agent/runtime/browser/artifactPreviewHealthEvaluator.ts`.
- `runSelfStartedArtifactPreviewHealth` now uses the shared probe and evaluator.
- `npx vitest run tests/unit/agent/runtime/browser/artifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewHealthProbe.test.ts`: 2 files / 5 tests passed.

Status: passed.

### Gate 2 - In-App Runner

Acceptance:
- Serve artifact and relative resources via `/api/workspace/file`.
- Use product `browserService` / managed browser path, not a separately spawned health Chrome.
- Use isolated context/session for QA and avoid user-tab state pollution.
- Log/checks explicitly show selected route.
- Logs/checks redact auth token.

Evidence:
- Added `BrowserService.withIsolatedPage`, which creates a QA-only isolated browser context and does not enter the managed tabs map.
- Added `src/main/agent/runtime/browser/inAppArtifactPreviewHealth.ts`.
- Added shared webServer constants in `src/shared/constants/webServer.ts`; `webServer.ts` now reads default host/port from the shared constants.
- Added preview health zh/en message helper in `src/shared/i18n/previewHealth.ts`.
- `npx vitest run tests/unit/agent/runtime/browser/artifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewHealthProbe.test.ts tests/unit/agent/runtime/browser/inAppArtifactPreviewHealth.test.ts`: 3 files / 8 tests passed.
- `npm run typecheck`: passed.

Status: passed.

### Gate 3 - Parity And Fallback Tests

Acceptance:
- Parity fixture includes relative image, CSS, JS, nested subdir resources, and one broken image.
- In-app default and self-started fallback full findings match after normalized evidence.
- Simulated webServer/browserService unavailable case falls back automatically with explicit route log/check.

Evidence:
- Added `tests/unit/agent/runtime/browser/artifactPreviewHealthParity.test.ts`.
- Parity fixture includes external relative CSS, external relative JS, top-level image, nested image, and a nested invalid PNG broken image.
- Exact `ArtifactPreviewHealthFinding[]` parity passed between `runArtifactPreviewHealth` default in-app route and `runSelfStartedArtifactPreviewHealth` fallback route.
- Fallback test passed with unavailable webServer and explicit `route=self-started-chrome` plus fallback reason.
- `npx vitest run tests/unit/agent/runtime/browser/artifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewHealthProbe.test.ts tests/unit/agent/runtime/browser/inAppArtifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewHealthParity.test.ts`: 4 files / 10 tests passed.
- Engine note: parity did not expose a browser-engine measurement difference in this fixture. One fixture bug initially produced matching `page_error` on both routes because the JS accessed `document.body` before it existed; the fixture was corrected to avoid measuring a fixture authoring bug as engine drift.

Status: passed.

### Gate 4 - Design Repair Loop

Acceptance:
- `designPreviewRepair` default assessment uses the in-app runner.
- Repair loop still completes render -> detect -> repair -> recheck with final finding count 0.

Evidence:
- Added `tests/unit/agent/runtime/browser/designPreviewRepairInApp.test.ts`.
- The test runs `runDesignPreviewRepairLoop` without injecting a custom `healthRunner`; `healthOptions` only supplies the test webServer URL/token.
- Initial pass route: `in-app-browser`.
- Final pass route: `in-app-browser`.
- Final finding count: 0.
- `npx vitest run tests/unit/agent/runtime/browser/artifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewHealthProbe.test.ts tests/unit/agent/runtime/browser/inAppArtifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewHealthParity.test.ts tests/unit/agent/runtime/browser/designPreviewRepair.test.ts tests/unit/agent/runtime/browser/designPreviewRepairInApp.test.ts`: 6 files / 17 tests passed.

Status: passed.

### Gate 5 - Final Verification

Acceptance:
- `npm run typecheck` passes.
- Affected unit tests pass.
- True path dogfood proves `/api/workspace/file` + in-app managed browser route.
- Fallback dogfood proves self-started Chrome route with explicit fallback log/check.
- No redline files/invariants changed.

Evidence:
- `npm run typecheck`: passed.
- `npx vitest run tests/unit/agent/runtime/browser/artifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewHealthProbe.test.ts tests/unit/agent/runtime/browser/inAppArtifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewHealthParity.test.ts tests/unit/agent/runtime/browser/designPreviewRepair.test.ts tests/unit/agent/runtime/browser/designPreviewRepairInApp.test.ts`: 6 files / 17 tests passed.
- `npm run build:web`: passed; rebuilt `dist/web/webServer.cjs` for dogfood.
- True path dogfood: `npx tsx scripts/acceptance/artifact-preview-health-inapp-dogfood.ts` passed with `route=in-app-browser`, `provider=system-chrome-cdp`, `mode=headless`, `tabCount=0`, and `/api/workspace/file` evidence.
- Dogfood finding evidence stayed normalized: `broken_image` evidence `artifact-relative:nested/images/broken.png`; token output was redacted as `%5Bredacted%5D`.
- Fallback verification is covered by `artifactPreviewHealthParity.test.ts`: unavailable webServer forced `route=self-started-chrome` with an explicit fallback reason/check.
- Redline checks passed: no diff in `artifactRepairGuard.ts`, `useAgentIPC.ts`, or ADR-026; no Neo scratch-directory path in the diff.

Status: passed.
