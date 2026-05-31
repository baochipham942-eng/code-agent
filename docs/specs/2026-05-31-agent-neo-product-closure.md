# 2026-05-31 Agent Neo Product Closure Spec

> Status: accepted
> Goal: make Neo's existing agent runtime capabilities converge into one trusted default path for long tasks.

## Goals

This spec splits the Agent Neo product closure work into five phases:

1. Read-only Agent Team audit: parallel evidence gathering only, no code edits from subagents.
2. Default long-task path: normal tasks stay in Chat; complex long tasks use `/workflow` or an equivalent product entry.
3. Safety autonomy: automatic permission classification, reviewable decision trace, write isolation, and external-engine guardrails.
4. Managed long-task runtime: resume, cancel, pause, notifications, result handoff, and retry proposals without depending on live UI.
5. Quality and release loop: artifact issues, replay/eval quality reports, admin observability, and release gates.

## Non-goals

- Do not revive `AcceptanceRunner / scenarioAcceptance`.
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

## Public Contracts

The shared contract lives in `src/shared/contract/productClosure.ts` and reuses existing contracts:

| Contract | Purpose | Boundary |
|---|---|---|
| `ProductClosureAuditReport` | Phase 1 Agent Team audit product | Evidence and priority only; not an implementation status |
| `DecisionTrace` | Permission decision explanation | Reuse existing security trace; do not create a second permission event stream |
| `ArtifactIssue` | Generated artifact quality issue and evidence references | Replace old scenario-acceptance failure expression without reviving old tables |
| `EvalReplayQualityReport` | Product-level replay/eval quality report | Bind to `UnifiedTraceIdentity`; do not maintain separate trace ids |
| `ScriptRunEvent` / `WorkflowLaunchEvent` | Workflow run and launch approval | Remain the long-task progress and approval contracts |

## Implemented Baseline

This first implementation closes the minimum product path without introducing a parallel long-task data plane:

- Phase 1: `ProductClosureAuditReport`, the read-only Agent Team audit document, and the product-closure acceptance script are checked in.
- Phase 2: `ScriptRunEvent` now has `run:cancelled`; workflow cancellation is available through IPC; active workflow runs project into `RunWorkbenchModel` so TaskPanel and Run Status can share one status vocabulary.
- Phase 3: classifier auto decisions now persist a reviewable `DecisionTrace`; dangerous package-manager/bash commands have focused regressions; the decision history command surfaces trace outcome and step count.
- Phase 4: workflow runs carry `sessionId` through `ScriptRunSpec` and cancellation authorization, so long-task control is tied back to the session contract rather than free-floating process ids.
- Phase 5: artifact issues and eval/replay quality reports have persisted SQLite repositories; `ExperimentAdapter` emits a quality report for replay-backed cases and keeps artifact issues tied to `UnifiedTraceIdentity`.

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
| Eval / replay / release gate | `npm run acceptance:real-agent-replay-eval`, `npm run acceptance:telemetry-feedback-cloud -- --json`, `npm run acceptance:posthog-dashboards:dry-run` |
| Paid provider | Default to `npm run acceptance:paid-real-model-replay-eval -- --dry-run --json`; real paid runs require explicit manual-paid approval |

## Rollout Order

1. Land Phase 1 audit and public contracts.
2. Converge Phase 2 default path before expanding runtime power.
3. In Phase 3, finish decision trace and write isolation before considering external engine write permission.
4. In Phase 4, reuse workflow journal, Task Ledger, and replay instead of creating another background-task system.
5. In Phase 5, use artifact issue / quality report as the new quality model.

## Open Risks

- Some docs still mention Delivery Review / Review Queue in the old sense and need to be aligned to artifact issue.
- Workflow write fanout only has partial guardrails and cannot be treated as default safe parallel writing.
- Worker-thread sandboxing cannot defend against adversarial scripts; strong isolation needs a separate design.
- Eval/replay quality reports must bind to `UnifiedTraceIdentity` to avoid another split data plane.
