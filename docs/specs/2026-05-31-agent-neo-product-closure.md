# 2026-05-31 Agent Neo Product Closure Spec

> Status: accepted
> Goal: make Neo's existing agent runtime capabilities converge into one trusted default path for long tasks.
> Architecture: [runtime-consolidation-2026-05-31.md](../architecture/runtime-consolidation-2026-05-31.md), [artifact-verification.md](../architecture/artifact-verification.md), [tool-system.md](../architecture/tool-system.md)

## Goals

This spec splits the Agent Neo product closure work into five phases:

1. Read-only Agent Team audit: parallel evidence gathering only, no code edits from subagents.
2. Default long-task path: normal tasks stay in Chat; complex long tasks use `/workflow` or an equivalent product entry.
3. Safety autonomy: automatic permission classification, reviewable decision trace, write isolation, and external-engine guardrails.
4. Managed long-task runtime: resume, cancel, pause, notifications, result handoff, and retry proposals without depending on live UI.
5. Quality and release loop: artifact issues, replay/eval quality reports, admin observability, and release gates.

## Non-goals

- Do not revive `AcceptanceRunner / scenarioAcceptance` as the product-level quality data plane.
- Do not create a second workflow, Task Ledger, or replay event stream.
- Do not open external engine write permission in the first round.
- Do not treat worker-thread sandboxing as a strong security boundary.
- Do not let Agent Team auto-fix, migrate, or refactor during the audit phase.

## Phase Contracts

| Phase | Product contract | Required delivery |
|---|---|---|
| 1. Agent Team Audit | Five read-only roles audit runtime/workflow, product UX, safety/permission, eval/observability, and Anthropic benchmark | `ProductClosureAuditReport` evidence with P0/P1/P2 and file/source paths |
| 2. Default Long Task Path | `/workflow` is the default complex-task path; Agent Team, spawn, and `workflow_orchestrate` have clear product levels | Entry copy, TaskPanel/Run Status/Replay state using one trace identity and one status vocabulary |
| 3. Safety Autonomy | Automatic permission decisions must have a classification and reviewable decision trace; concurrent writes must be isolated or serialized | `DecisionTrace`, classifier samples, dangerous-command regression tests, workflow write-isolation tests |
| 4. Managed Long Task Runtime | Long tasks can run in background, resume, cancel, retry, and return results to the session | workflow resume/cancel/background notification smoke and handoff/retry proposal |
| 5. Quality Release Loop | Generated artifact quality is represented as artifact issue / evidence graph; eval/replay emits quality reports | `ArtifactIssue`, `EvalReplayQualityReport`, admin/release gate surfaces |

## Implementation Type Map

| Type | Current contract | Main files |
|---|---|---|
| Long-task product vocabulary | Chat remains the default for ordinary tasks; `/workflow` is the default complex long-task path; Agent Team is expert; `spawn_agent` and `workflow_orchestrate` are compatibility surfaces. | `src/shared/contract/productClosure.ts`, `src/renderer/hooks/useRunWorkbenchModel.ts` |
| Safety autonomy | Permission classifier decisions persist a `DecisionTrace`; write/execute tool calls enter shared file/workspace write isolation. | `src/main/security/writeIsolation.ts`, `src/main/tools/toolExecutor.ts`, `src/main/security/decisionHistory.ts` |
| Managed runtime controls | workflow runs can cancel, pause, resume, move to background, notify on completion, and restore foreground state through app-host routes. | `src/main/ipc/workflow.ipc.ts`, `src/web/routes/background.ts`, `scripts/acceptance/pause-resume-smoke.ts` |
| Handoff and retry | workflow / Agent Team failures create structured recovery proposals with evidence refs instead of relying on live UI state. | `src/main/handoff/longTaskRecoveryProposal.ts`, `src/main/handoff/handoffProposalService.ts` |
| Artifact quality loop | generated artifact issues and eval replay quality reports persist to SQLite and can be reviewed through admin queue APIs. | `src/shared/contract/productClosure.ts`, `src/main/services/core/repositories/ArtifactIssueRepository.ts`, `src/web/routes/adminReviewQueue.ts` |

## Public Contracts

The shared contract lives in `src/shared/contract/productClosure.ts` and reuses existing contracts:

| Contract | Purpose | Boundary |
|---|---|---|
| `ProductClosureAuditReport` | Phase 1 Agent Team audit product | Evidence and priority only; not an implementation status |
| `LongTaskSurfaceContract` / `LongTaskUiStatus` | Phase 2 product hierarchy and status vocabulary | `/workflow` default, Agent Team expert, compatibility tools explicit; UI must normalize into the shared vocabulary |
| `DecisionTrace` | Permission decision explanation | Reuse existing security trace; do not create a second permission event stream |
| `ArtifactIssue` | Generated artifact quality issue and evidence references | Replace old scenario-acceptance failure expression without reviving old tables |
| `EvalReplayQualityReport` | Product-level replay/eval quality report | Bind to `UnifiedTraceIdentity`; do not maintain separate trace ids |
| `ScriptRunEvent` / `WorkflowLaunchEvent` | Workflow run and launch approval | Remain the long-task progress and approval contracts |

## Implemented Baseline

This first implementation closes the minimum product path without introducing a parallel long-task data plane:

- Phase 1: `ProductClosureAuditReport`, the read-only Agent Team audit document, and the product-closure acceptance script are checked in.
- Phase 2: `ScriptRunEvent` now has `run:cancelled`; workflow cancellation is available through IPC; active workflow runs project into `RunWorkbenchModel`; `LongTaskSurfaceContract` marks `/workflow` as the default complex-task path, Agent Team as expert, and `spawn_agent` / `workflow_orchestrate` as compatibility paths.
- Phase 3: classifier auto decisions now persist a reviewable `DecisionTrace`; dangerous package-manager/bash commands have focused regressions; ToolExecutor serializes concurrent write/execute calls with file/workspace write-isolation metadata.
- Phase 4: workflow runs carry `sessionId` through `ScriptRunSpec` and cancellation authorization; workflow and Agent Team failures create handoff/retry proposals that reference replay, journal, checkpoint, and failed-task evidence.
- Phase 5: artifact issues and eval/replay quality reports have persisted SQLite repositories; `ExperimentAdapter` emits a quality report for replay-backed cases and keeps artifact issues tied to `UnifiedTraceIdentity`.
- Post-baseline runtime hardening: `acceptance:pause-resume` now exercises pause, resume, move-to-background, background completion notification, and foreground restore through the app-host API.
- Post-baseline admin review wiring: artifact issues can be listed as admin review queue items, decided as `allow_release` or `request_changes`, and audited through the same artifact issue repository.

## Managed Runtime Control Plane

| Control | Contract | Verification |
|---|---|---|
| Cancel | `ScriptRunEvent` includes `run:cancelled`; workflow IPC can authorize cancellation by `sessionId`. | `tests/unit/ipc/workflow.ipc.test.ts`, `tests/unit/agent/scriptRuntime/runService.test.ts` |
| Pause / resume | app-host pause and resume map onto the active runtime owner and update session state. | `npm run acceptance:pause-resume` |
| Move to background | `/api/background/move-to-background` detaches a session from the foreground while keeping the task addressable. | `scripts/acceptance/pause-resume-smoke.ts` |
| Foreground restore | `/api/background/move-to-foreground` returns the stored task and lets the client resume visible status. | `scripts/acceptance/pause-resume-smoke.ts` |
| Completion notification | background completion produces a user-visible notification through `notificationService`, without requiring the original UI stream to remain open. | `scripts/acceptance/pause-resume-smoke.ts` |

## Agent Team Audit Protocol

The five audit roles are read-only and must output the same evidence shape:

| Role | Focus |
|---|---|
| `runtime_workflow` | `/workflow`, script runtime, resume/cancel/pause, shared worktree risk |
| `product_ux` | Chat, Workbench, TaskPanel, Run Status Rail, Review/Replay state vocabulary |
| `safety_permission` | Permission classifier, ToolExecutor, DecisionTrace, sandbox, external engine guard |
| `eval_observability` | replay/eval, telemetry, admin console, artifact issue gap |
| `anthropic_benchmark` | Anthropic managed agents, auto mode, harness, eval, context/tool design |

Each finding must include `priority`, `currentState`, `gap`, `recommendation`, and at least one evidence path or official source link.

## Acceptance Matrix

| Surface | Required verification |
|---|---|
| Product closure contracts | `npm run acceptance:product-closure`, `npm run typecheck` |
| Runtime / workflow | `npm run acceptance:agent-runtime-app-host`, `npm run acceptance:pause-resume`, `npm run acceptance:tool-cancel`, `npm run acceptance:session-persistence` |
| Agent Team / default path | `npm run acceptance:agent-team`, plus focused workflow E2E when UI changes |
| Eval / replay / release gate | `npm run acceptance:real-agent-replay-eval`, `npm run acceptance:admin-review-queue`, `npm run acceptance:telemetry-feedback-cloud -- --json`, `npm run acceptance:posthog-dashboards:dry-run` |
| Paid provider | Default to `npm run acceptance:paid-real-model-replay-eval -- --dry-run --json`; real paid runs require explicit manual-paid approval |

## Rollout Order

1. Land Phase 1 audit and public contracts.
2. Converge Phase 2 default path before expanding runtime power.
3. In Phase 3, finish decision trace and write isolation before considering external engine write permission.
4. In Phase 4, reuse workflow journal, Task Ledger, and replay instead of creating another background-task system.
5. In Phase 5, use artifact issue / quality report as the new quality model.

## Open Risks

- Checker-level `AcceptanceRunner` still exists, so any future artifact verifier wiring must convert its results into `ArtifactIssue` / evidence refs before entering release gates.
- Write isolation is now a shared ToolExecutor guard, but it serializes access inside one host process; per-agent worktree and strong external isolation remain separate hardening tracks.
- Worker-thread sandboxing cannot defend against adversarial scripts; strong isolation needs a separate design.
- Eval/replay quality reports must bind to `UnifiedTraceIdentity` to avoid another split data plane.
