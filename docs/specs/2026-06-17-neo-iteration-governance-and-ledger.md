# 2026-06-16~17 Neo Iteration Governance, Ledger, Budget and Design-System Spec

> Status: as-built on current repository state
> Time window: 2026-06-16 through 2026-06-17 CST
> Evidence range: `1a2bccd2c` through `7e5069e8f`
> Related architecture: [ARCHITECTURE.md](../ARCHITECTURE.md), [overview.md](../architecture/overview.md), [agent-core.md](../architecture/agent-core.md), [tool-system.md](../architecture/tool-system.md), [frontend.md](../architecture/frontend.md), [data-storage.md](../architecture/data-storage.md), [swarm-trace-persistence.md](../architecture/swarm-trace-persistence.md)

This batch moves Agent Neo further toward auditable product operation. The main movement is not another agent runtime. It is the hardening of evidence, ledger truth, cost visibility, tool-result recovery and UI consistency so recent feature work can be reviewed from durable facts instead of transient UI state.

## Product Contract

| Area | Contract |
|------|----------|
| Permission and tool execution ledger | Permission decisions and tool execution lifecycle events are append-only local facts. Permission writes are fail-safe and never block execution. Tool begin/complete events make crash recovery and incomplete tool detection reproducible. |
| Swarm ledger truth source | `swarm_run_ledger` is the append-only truth source for swarm rollup facts. `swarm_runs` / `swarm_run_agents` stay as read-optimized rollup caches. Half-closed ledger runs are not treated as final truth. |
| Swarm reconcile and backfill | Reconcile reads ledger rebuilt values against stored rollups. Batch scans are read-only by default; cache rebuild is behind an explicit `rebuildOnDrift` write gate. Old rollup-only runs are not migrated automatically; opt-in backfill is transactional and idempotent. |
| Static governance gates | `console-scan`, `a11y-scan`, `stale-dist-scan` and lint are wired into the CI gate family. Their baseline-ratchet style is intentionally narrow: prevent new drift first, then lower baselines as files are cleaned. |
| Design-system contract | UI consistency is now governed by `docs/designs/design-system.md` plus `scripts/check-design-system.mjs`. Hex colors, bare buttons and handrolled modal overlays are measured against ratchet baselines; Modal primitive migration continues in small batches. |
| Budget visibility | Runtime budget settings are user-visible. `BudgetService` emits warning/blocked alerts once per period transition, StatusBar cost display reflects budget state, and Settings exposes max budget, thresholds and reset period. This is warning and visibility, not a hard real-time spend guarantee. |
| Tool-result recovery UX | Failed tool results expose copy-error and retry-from-here actions from one presentation decision. Auto-loaded retry failures and recovered failures are filtered out so internal recovery states do not pollute session health. |
| Bash output clarity | Long Bash output keeps head and tail after completion, folds carriage-return progress frames, and surfaces non-zero exit codes even when a shell wrapper reported success. |
| Compaction stuck guard | Auto-compaction now detects repeated compaction that still leaves the context over threshold. After the configured consecutive limit it pauses auto-compaction and injects a scope-narrowing system message instead of spending more tokens in the same loop. |

## Architecture Map

| Layer | Files / Modules | Notes |
|------|------------------|-------|
| Permission ledger | `src/main/tools/toolExecutor.ts`, `src/main/services/core/databaseService.ts`, `permission_decisions` | Decision trace is still available in memory, but durable review now has an append-only table. |
| Tool execution ledger | `src/main/tools/toolExecutor.ts`, `tool_execution_events`, diagnostics IPC | Begin/complete pairs identify crash-time in-flight tools without trusting renderer state. |
| Swarm ledger | `src/main/services/core/repositories/SwarmLedgerRepository.ts`, `src/shared/contract/swarmLedger.ts`, `swarm_run_ledger` | Append-only event kinds are `run_started`, `agent_snapshot` and `run_closed`. |
| Swarm reconcile | `src/main/services/core/swarmReconcile.ts`, `swarmReconcileService.ts`, `database/backfillSwarmLedger.ts` | Reconcile is intentionally split into read-only scan, optional rebuild writer and opt-in backfill. |
| Static gates | `scripts/console-scan.mjs`, `scripts/a11y-scan.mjs`, `scripts/stale-dist-scan.mjs`, CI workflow | Baseline-ratchet gates prevent new drift while keeping legacy cleanup incremental. |
| Design system gate | `docs/designs/design-system.md`, `docs/designs/design-system-contract-plan.md`, `scripts/check-design-system.mjs`, `scripts/design-system-baseline.json` | W2 is machine enforcement; W3 lowers modal/button/hex baselines through reviewed small slices. |
| Budget | `src/main/services/core/budgetService.ts`, `BudgetSettings.tsx`, `BudgetAlertNotice.tsx`, `useBudgetStatus.ts`, `CostDisplay.tsx` | Runtime singleton is hydrated from persisted config at startup; UI alerts are deduplicated by alert level per reset period. |
| Tool recovery | `toolExecutionPresentation.ts`, `ToolCallDisplay/*`, `messageActionStore` | Retry-from-here reuses the existing fork path instead of inventing a separate tool retry protocol. |
| Bash presentation | `bashOutputPreview.ts`, `statusLabels.ts`, `tests/renderer/components/bashOutputPreview.test.ts`, `statusLabelsBashExit.test.ts` | The renderer owns output folding and exit-code labeling. Tool execution keeps raw output available through existing result metadata. |
| Compaction guard | `src/main/agent/runtime/contextAssembly/compression.ts`, `src/main/context/autoCompressor.ts`, `tests/unit/context/autoCompressor.test.ts` | The guard is orthogonal to total token budget wrap-up. It protects against repeated ineffective compactions. |

## Verification Evidence

| Scope | Evidence |
|------|----------|
| Permission/tool ledger | `tests/unit/tools/toolExecutor.ledger.test.ts`, `tests/unit/tools/toolExecutor.executionLedger.test.ts` |
| Swarm ledger and reconcile | `tests/unit/services/swarmLedgerRepository.test.ts`, `tests/unit/services/swarmReconcile.test.ts`, `tests/unit/services/swarmReconcileService.test.ts`, `tests/unit/services/swarmReconcileMutation.integration.test.ts`, `tests/unit/services/swarmLedgerBackfill.integration.test.ts` |
| Diagnostics IPC | `tests/unit/ipc/diagnostics.sessionLedger.test.ts`, `tests/unit/ipc/diagnostics.swarmReconcile*.test.ts`, `tests/unit/ipc/diagnostics.swarmLedgerBackfill.test.ts` |
| Static gates | `node scripts/console-scan.mjs`, `node scripts/a11y-scan.mjs`, `node scripts/stale-dist-scan.mjs`, CI gate wiring commits |
| Design-system gate | `tests/scripts/designSystemGate.test.ts`, `node scripts/check-design-system.mjs`, modal migration tests such as `captureAddDialog.test.tsx`, `channelModal.test.tsx`, `updateNotification.test.tsx` |
| Budget | `tests/unit/services/core/budgetConfigSync.test.ts`, `tests/unit/services/core/budgetStartupWiring.test.ts`, `tests/unit/services/core/budgetAlertEmit.test.ts`, `tests/renderer/components/budgetCostColor.test.ts`, `tests/renderer/components/budgetAuditFixes.test.ts` |
| Tool presentation | `tests/renderer/utils/toolExecutionPresentation.test.ts`, `tests/renderer/components/toolErrorActions.test.ts`, `tests/renderer/components/bashOutputPreview.test.ts`, `tests/renderer/components/statusLabelsBashExit.test.ts` |
| Compaction | `tests/unit/context/autoCompressor.test.ts` plus runtime guard in `contextAssembly/compression.ts` |

## Boundaries

- Ledger writes are fail-safe. A database write failure must not change permission, tool or swarm runtime behavior.
- `swarm_run_ledger` is authoritative only for closed runs. Runs without `run_closed` are in-progress and skipped by reconcile.
- Reconcile scan is read-only by default. Cache rebuild requires `rebuildOnDrift` and a writer. Backfill is opt-in and does not run at app startup.
- Budget UI is warning-oriented. It can be delayed by provider usage reporting, streaming timing or missing model pricing. It should not be described as an exact spend lock.
- Design-system gates are ratchets. Existing baseline debt remains visible; new drift is blocked, and cleanup lowers baselines explicitly.
- Tool retry actions are UI affordances over existing session fork behavior. They do not guarantee a deterministic replay of the failed tool call.
