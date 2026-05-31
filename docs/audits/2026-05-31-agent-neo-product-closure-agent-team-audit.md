# 2026-05-31 Agent Neo Product Closure Agent Team Audit

> Status: accepted
> Scope: read-only Agent Team audit plus product-closure implementation baseline.
> Related: [Product Closure Spec](../specs/2026-05-31-agent-neo-product-closure.md)

## Summary

Five read-only subagents completed the audit. The strongest conclusion is that Neo already has meaningful agent runtime assets, but it does not yet have one trusted default product path for long tasks. `/workflow`, Agent Team, TaskPanel, Run Status Rail, permission, replay/eval, and admin observability all exist in pieces; the missing work is to make them share one state vocabulary, one safety explanation model, one background-task lifecycle, and one artifact-quality loop.

The implementation baseline now has public contracts for audit evidence, artifact issues, and replay/eval quality reports. The quality direction is artifact issue / evidence graph, not the old `AcceptanceRunner / scenarioAcceptance` path.

## Agent Team Outputs

| Role | Agent | Top finding | Priority |
|---|---|---|---|
| `runtime_workflow` | Rawls `019e7ea4-668b-7c52-b684-665763b92ba0` | `/workflow` and script runtime are live, but cancel/pause/resume/background control is not closed and `run:cancelled` is missing | P0 |
| `product_ux` | Euler `019e7ea4-88c9-7851-b98b-bf52556d2e29` | Chat, TaskPanel, Run Status Rail, workflow, and Review/Replay still expose multiple state vocabularies | P0 |
| `safety_permission` | Mencius `019e7ea4-bea1-7452-a411-bc86acf63b00` | Permission mode and `ToolExecutor` are not fully wired, and legacy workflow/spawn paths still have shared-worktree write risk | P0 |
| `eval_observability` | Feynman `019e7ea4-e4ee-72b0-9a17-bba79bcc089f` | The live quality chain is telemetry replay + real-agent eval gate + admin feedback, but artifact issue / evidence graph is missing | P0 |
| `anthropic_benchmark` | Linnaeus `019e7ea5-2549-78c3-94f9-b6fa881255d2` | Against Anthropic's agent guidance, Neo's gap is the trusted long-running contract: auto mode, harness, eval, context/tool lifecycle | P0 |

## External Benchmark

Anthropic's public agent material gives four product constraints:

- Workflow and agent should be separated: workflows are predefined paths; agents dynamically decide process and tool use. Source: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Claude Code's product promise is project-level execution, cross-file changes, test iteration, and human control over risky actions. Source: [Claude Code product page](https://www.anthropic.com/product/claude-code)
- Agent eval needs trajectory, outcome, harness, suites, and failure analysis; production agents cannot rely on one-off manual judgement. Source: [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Long-context agent work needs deliberate context engineering, compression, and subagent isolation, with the lead agent synthesizing high-signal results. Source: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

Neo is directionally aligned, but the contracts are not closed: having workflow is not the same as a trusted default long-task path; having replay is not the same as artifact quality traceability; having permission UI is not the same as explainable automatic approval.

## P0 Findings

### Workflow control plane is incomplete

Current state: `/workflow` route, script runtime, workflow approval, inline monitor, journal, and resume cache exist. Evidence: `src/main/agent/runtime/scriptRuntime.ts`, `src/main/agent/runtime/runService.ts`, `src/shared/contract/scriptRun.ts`, `src/renderer/components/workflow/WorkflowInlineMonitor.tsx`.

Gap: `runService` has cancel/state primitives, but the product-facing cancel/pause/resume routes primarily target active agent loops. `ScriptRunEvent` has no `run:cancelled`, so abort can be folded into failed/error state.

Recommendation: Phase 2 should add `run:cancelled` and project workflow cancel/pause/resume into the same Run Status / TaskPanel model.

### Product state surfaces are split

Current state: Chat, Task/Workbench, Run Status Rail, workflow inline monitor, and Agent Team are each visible. Evidence: `src/renderer/components/TaskStatusBar.tsx`, `src/renderer/hooks/useRunWorkbenchModel.ts`, `src/renderer/components/workflow/WorkflowInlineMonitor.tsx`, `docs/architecture/workbench.md`.

Gap: TaskPanel and Run Status Rail do not clearly share a single state model; workflowStore is not fully projected into the Task state; Agent Team / Swarm / background agents naming is mixed; old Review/Replay docs still describe surfaces that no longer match runtime.

Recommendation: Phase 2 should make `RunWorkbenchModel` the single product state projection for workflow, Agent Team, TaskPanel, and Run Status Rail. Review/Replay should stay internal to Admin/Eval until artifact issue reopens a minimal review queue.

### Safety autonomy is not a live product promise yet

Current state: permission mode, classifier, decision trace, tool executor, and serial write gate all exist. Evidence: `src/main/permissions/PermissionModeManager.ts`, `src/main/permissions/permissionClassifier.ts`, `src/main/tools/ToolExecutor.ts`, `src/shared/contract/decisionTrace.ts`, `src/main/agent/runtime/serialWriteGate.ts`.

Gap: permission mode is not fully wired into the top-level execution chain; classifier samples are thin; some package-manager/bash actions are too broadly auto-approved; legacy parallel paths can still write to shared cwd; decision trace does not yet cover the full auto/policy/hook/history decision chain.

Recommendation: Phase 3 should connect permission mode to `ToolExecutor`, expand classifier regression cases, make every auto allow/deny/ask reviewable, and use file locks or per-agent worktrees before any write fanout becomes default.

### Artifact quality plane is missing

Current state: replay/eval has moved to local SQLite telemetry, structured replay, real-agent eval gate, and admin feedback/error triage. Evidence: `src/main/evaluation/telemetryQueryService.ts`, `src/main/testing/testRunner.ts`, `src/main/evaluation/experimentAdapter.ts`, `admin-console/app/feedback/page.tsx`.

Gap: there is no persisted artifact issue, no issue owner/status/resolve/dismiss/regression promotion, and no graph from issue to artifact/session/replay/eval case/feedback/Sentry. Old `AcceptanceRunner / scenarioAcceptance` source exists, but the live DB/UI contract is already disconnected.

Recommendation: Phase 5 should use `ArtifactIssue` and `EvalReplayQualityReport` as the generated-artifact quality model. Verifiers should output artifact issues; negative feedback, Sentry, and eval gate failures should be promotable to regression cases.

## Implementation Baseline

| Phase | Landed baseline |
|---|---|
| Phase 2 Default Long Task Path | Added `run:cancelled`, workflow cancel IPC, session-scoped cancel authorization, and workflow projection into `RunWorkbenchModel` for TaskPanel / Run Status |
| Phase 3 Safety Autonomy | Persisted classifier decision traces in decision history, surfaced trace outcome in command history, and hardened package-manager/bash regressions |
| Phase 4 Managed Long Task Runtime | Carried `sessionId` through workflow script runs and cancellation so background control remains tied to the originating session |
| Phase 5 Quality Release Loop | Added artifact issue / evidence persistence, eval/replay quality report persistence, and quality report emission from replay-backed eval cases |

Post-baseline update: pause/resume/background notification E2E and admin review queue wiring are now implemented as focused app-host smokes. Remaining post-baseline work stays in the spec acceptance matrix: per-agent worktree or file-lock isolation for write fanout and trend/release gate UI.

## Verification

- Subagents were read-only; no subagent edited files.
- Phase 1 contracts: `src/shared/contract/productClosure.ts`
- Phase 1 spec: `docs/specs/2026-05-31-agent-neo-product-closure.md`
- Phase 1 audit: `docs/audits/2026-05-31-agent-neo-product-closure-agent-team-audit.md`
- Phase 1 contract tests: `tests/unit/contract/productClosure.test.ts`
- Product closure gate: `npm run acceptance:product-closure`
- Product closure gate includes workflow cancellation, TaskPanel projection, classifier trace regression, schema migration coverage, artifact issue repository coverage, and eval/replay quality report coverage.

This baseline was verified with:

- `npm run acceptance:product-closure`
- `npm run typecheck`
- `git diff --check`
- `npm run acceptance:real-agent-replay-eval -- --json`
- `CODE_AGENT_SYSTEM_CHROME_PATH=/Users/linchen/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell npm run acceptance:agent-runtime-app-host -- --skip-build`
- `npm run acceptance:pause-resume`
- `npm run acceptance:tool-cancel`
- `npm run acceptance:session-persistence`
- `npm run acceptance:agent-team`
- `npm run acceptance:posthog-dashboards:dry-run`
- `CODE_AGENT_SYSTEM_CHROME_PATH=/Users/linchen/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell npm run acceptance:telemetry-feedback-cloud -- --json`
- `npm run acceptance:paid-real-model-replay-eval -- --dry-run --json`

Local note: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` launched in this environment but did not expose CDP; the existing `chrome-headless-shell` executable did expose CDP and was used for browser-backed app-host verification.
