# Agent Architecture Debt Iteration Plan

> Date: 2026-05-31
> Scope: backend architecture debt in Agent Neo agent runtime, workflow runtime, model/provider layer, and app-host routes.

## Agent Team Findings

| Batch | Area | Finding | Priority |
|---|---|---|---|
| A | Workflow entry semantics | `workflow` and `workflow_orchestrate` are both valid, but discovery, preload, execution phase, and subagent disabled lists must keep them distinct. | P0 |
| B | Agent runtime boundaries | `madge` is clean, but soft type/callback cycles remain between runtime modules. Port interfaces should replace direct peer knowledge. | P0 |
| C | Dynamic workflow safety | `worker_threads + AsyncFunction` is only a semi-trusted sandbox; write-capable agents share one worktree. | P0 |
| D | Model/web backend boundaries | `dev.ts` cycle and provider concurrency normalization are low-risk next cuts; `modelRouter`, `providers/shared`, and `agent.ts` need staged extraction. | P1 |

## Current Progress

- Iteration 1 is implemented and covered by targeted tests.
- Iteration 2 provider fairness and workflow resume context checks are implemented and covered by targeted tests.
- Iteration 3 runtime ports are implemented and covered by targeted tests.
- Iteration 4 model/app-host boundaries are implemented and covered by targeted tests.
- Maintenance follow-up split provider JSON/HTTP helpers, extracted agent run event collection, and removed production `any` noise from CLI schema output, IPC types, and channel fallback message construction.
- Iteration 5 prompt/session/release gates are implemented: stale prompt token scan, low-cost real prompt smoke, subagent guidance regressions, session owner scoping, eval worktree isolation, and experiment schema migration coverage.

## Iteration 1: Runtime Safety And Workflow Semantics

Goal: make the current live workflow/runtime surface less ambiguous and safer without changing product behavior.

Deliverables:

- Split ToolSearch semantics so bare `workflow` resolves to dynamic workflow and `WorkflowOrchestrate` stays legacy declarative workflow.
- Preload dynamic workflow for `/workflow` and script/programmatic workflow language; keep cowork/multi-agent legacy behavior unchanged.
- Classify both workflow tools as execute phase.
- Prevent subagents from spawning either workflow generation.
- Replace `ToolExecutionEngine -> ConversationRuntime` direct type dependency with a small runtime control port.
- Serialize write-capable dynamic workflow agents through a per-run write gate.
- Reject common codegen/global escape shapes in `scriptValidator`.

Verification:

- `npx vitest run tests/unit/services/toolSearchService.test.ts tests/unit/protocol/toolDefinitions.test.ts tests/unit/agent/deferredToolPreload.test.ts tests/unit/tools/multiagentProtocolSchema.test.ts tests/unit/agent/spawnGuard.test.ts tests/unit/tools/executionPhase.test.ts tests/unit/agent/scriptRuntime/agentBridge.test.ts tests/unit/agent/scriptRuntime/scriptValidator.test.ts tests/unit/agent/toolExecutionEngine.hooks.test.ts`
- `npm run typecheck`

Maintenance follow-up verification:

- `npx vitest run tests/unit/model/providers-shared.test.ts tests/unit/model/baseOpenAIProvider.test.ts tests/unit/model/sseStream.snapshot.test.ts tests/unit/web/agentRouter.test.ts tests/channels/channelMessageReply.test.ts tests/unit/ipc/channel.ipc.test.ts tests/unit/cli/agentDispatch.test.ts`
- `npm run typecheck`
- `npx madge --ts-config tsconfig.json --extensions ts,tsx --circular src/host src/web/routes`
- `npm run debt:report -- --skip-eslint --limit 20`

## Iteration 2: Workflow Resume And Provider Fairness

Goal: make resumable workflow and provider-level concurrency more explicit.

Deliverables:

- Add prior run metadata to the workflow journal load path.
- Warn or miss cache when `resumeFromRunId` goal/args context does not match.
- Include goal/args hash in dynamic workflow call hash, while keeping script changes able to reuse unchanged calls.
- Normalize provider ids in `concurrencyLimiter` overrides and lookups.
- Add dedicated `ConcurrencyGate` tests for provider-full queue skipping, abort removal, and cap behavior.

Verification:

- `npx vitest run tests/unit/agent/scriptRuntime/*.test.ts tests/unit/services/WorkflowJournalRepository.test.ts tests/unit/model/concurrencyLimiter.test.ts`
- `npm run typecheck`

## Iteration 3: Runtime Port Cleanup

Goal: reduce soft cycles and make agent runtime modules depend on roles instead of concrete peers.

Deliverables:

- Replace `ContextAssembly -> RunFinalizer` with a task-progress port.
- Replace `RunFinalizer -> ContextAssembly` with a message-writer port.
- Add `SubagentExecutorPort` for `ParallelAgentCoordinator` and `DAGScheduler`.
- Keep `swarmServices` as the existing adapter boundary; do not rewrite IPC yet.

Verification:

- `npx vitest run tests/unit/agent/contextAssembly.test.ts tests/unit/agent/conversationRuntime.test.ts tests/unit/agent/toolExecutionEngine.hooks.test.ts`
- `npx vitest run tests/unit/agent/parallelAgentCoordinator.test.ts tests/unit/agent/parallelAgentCoordinatorCheckpoint.test.ts tests/unit/scheduler/TaskDAG.test.ts tests/unit/scheduler/taskDagAlgorithms.test.ts`
- `npx madge --ts-config tsconfig.json --extensions ts,tsx --circular src/host`

## Iteration 4: Model And App-Host Boundaries

Goal: move core backend hot paths toward smaller policy modules.

Deliverables:

- Break `dev.ts <-> devTelemetrySeedRoutes.ts` by moving shared helpers into a neutral service.
- Pass provider identity through provider fetch helpers where the provider is known.
- Extract pure artifact/fallback policy helpers from `modelRouter`.
- Extract an `agentRunController` from `src/web/routes/agent.ts` for SSE writes, terminal-event dedupe, disconnect cancellation, and run status updates.

Verification:

- `npx madge --ts-config tsconfig.json --extensions ts,tsx --circular src/host src/web/routes`
- `npx vitest run tests/unit/model/modelRouterPolicy.test.ts tests/unit/model/modelRouter.test.ts tests/unit/model/baseOpenAIProvider.test.ts tests/unit/model/sseStream.snapshot.test.ts tests/unit/web/devRouter.test.ts tests/unit/web/agentRouter.test.ts`
- `npm run typecheck`

## Iteration 5: Prompt, Session, And Release Gates

Goal: prevent recent runtime cleanups from regressing through stale prompt wording, wrong user ownership, or test harness side effects.

Deliverables:

- Add static stale-token scanning for current prompt/tool contracts.
- Add low-cost real-model prompt smoke cases for Read, Write, Edit, Grep, ToolSearch, Task, and no-auto-commit git behavior.
- Align `spawn_agent`, core agent guidance, and nudges with current ToolSearch / Task / file tool names.
- Keep dynamic `workflow` and legacy `workflow_orchestrate` role semantics distinct in compatibility tests.
- Scope session reads, writes, cache access, and session-manager operations to the current authenticated user.
- Keep web responses from leaking provider `apiKey` in serialized session model config.
- Guard eval file tools so fixture writes stay inside the intended worktree.
- Ensure experiments schema creates the table before applying `git_commit` migration.

Verification:

- `npm run eval:prompt-gate`
- `npx vitest run tests/unit/prompts/promptRegression.test.ts tests/unit/agent/multiagentTools/workflowOrchestrate.legacy.test.ts`
- `npx vitest run tests/unit/services/SessionRepository.agentEngine.test.ts tests/unit/services/infra/sessionManager.cloudSync.test.ts tests/unit/services/databaseSchema.experiments.test.ts`
- `npx vitest run tests/unit/tools/modules/file/append.test.ts tests/unit/tools/modules/file/multiEdit.test.ts tests/unit/tools/modules/file/write.test.ts`

## Completion Gate

The architecture debt effort is complete only when:

- The P0 runtime/workflow safety changes are implemented and covered by tests.
- `debt:report` has no unwhitelisted effective-over-limit files.
- `madge` reports no circular dependencies for `src/host` and relevant `src/web/routes`.
- Workflow resume, provider concurrency, and runtime port boundaries have targeted tests.
- Prompt/tool contract gates and session owner scope tests pass.
- Remaining high-risk extractions are either implemented or explicitly tracked as later product work with verification commands.
