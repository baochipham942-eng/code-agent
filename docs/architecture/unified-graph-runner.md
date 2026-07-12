# Unified Graph Runner (S8 + S8.5)

## Status

S8 completes the Graph contract, GraphRunner, TaskDAG scheduler adapter, Agent
Team migration, and Auto Agent migration. S8.5 adds the remaining executor
adapters, migrates the live Dynamic Workflow entry point to a one-node parent
Graph, and centralizes GraphEvent compatibility projection.

The Durable Run Kernel remains authoritative for logical run identity, attempt,
owner lease, fenced checkpoint transaction, recovery, and terminal lifecycle.
GraphRunner owns node dependency state, ready scheduling, concurrency, retry,
cancel propagation, required/optional aggregation, graph terminal selection,
GraphEvent generation, and the graph checkpoint projection for migrated paths.

## Runtime layers

```text
Application facade
  AgentOrchestrator / TaskManager
        |
Durable Run Kernel
  run identity / attempt / lease / durable checkpoint / recovery
        |
GraphRunner
  dependency / ready / concurrency / retry / cancel / aggregation
        |
GraphExecutorPort
  SubagentExecutorAdapter (protocol-native)
        |
Execution implementation
  SubagentExecutor / SpawnGuard / ConversationRuntime
```

`ConversationRuntime` is unchanged and remains the single-Agent model/tool loop.
`ParallelAgentCoordinator` and `AutoAgentCoordinator` remain compatibility and
projection facades; neither owns a second ready-queue algorithm.

## Contracts

`src/host/orchestration/` contains only serializable graph data contracts and
Host ports:

- `GraphRunSpec`: graph/run/session/attempt identity, nodes, edges, scheduler
  policy, retry policy, budget, metadata, and optional trace context.
- `GraphNode`: executor reference, input, dependencies, permission/capability
  projection, side-effect policy, idempotency identity, timeout, retry,
  required/optional policy, priority, and metadata.
- `GraphNodeStatus`: queued, ready, running, waiting, completed, failed,
  cancelled, skipped, and requires_review.
- `GraphRunStatus`: created, running, waiting, completed, failed, cancelled, and
  requires_review.
- `GraphExecutorPort` and `GraphSchedulerPort`: execution and scheduling
  boundaries without provider, model, tool-protocol, sandbox, UI, or database
  transaction concerns.
- `GraphEvent`: the internal event source for migrated graph paths.
- `GraphCheckpoint`: a serializable projection embedded in the existing engine
  checkpoint; it is not a new Durable store.

## Scheduler

`DAGGraphSchedulerAdapter` uses `TaskDAG` for dependency validation, missing
dependency rejection, cycle detection, ready transitions, priority, optional
failure, and serialization. Every Graph run creates an adapter instance. The
process-level `getDAGScheduler()` remains only a configuration/event compatibility
surface and is not a run identity or mutable run-state owner.

Agent-specific prompt, tools, model, protocol context, and process cancellation
remain in executor adapters. GraphRunner never invokes DAGScheduler's built-in
agent or shell execution branches.

## Migrated paths

### Agent Team

Both `executeParallel()` and `executeWithDAG()` delegate to the same GraphRunner.
The old coordinator remaining/ready/failedOrBlocked loop and the second
DAGScheduler execution body were removed. SpawnGuard slot ownership, child abort
controllers, mailbox, findings, approvals, shared-context projection, and UI
snapshots remain in the facade/executor boundary.

The Graph checkpoint is stored as an optional field inside
`AgentTeamCheckpointState` and committed through the existing S4 Durable
controller. No Durable schema, table, repository, or transaction changed.
Recovery restores the Graph projection together with completed child results,
mailbox, findings, approval state, and owner epoch. Interrupted read-only nodes
can return to ready; an interrupted node with unknown side effects becomes
`requires_review`.

### Auto Agent

Direct/sequential/parallel strategies translate into Graph dependencies.
Sequential output passing is performed by `SubagentExecutorAdapter` from
dependency results. Parallel primary agents gate helper fan-out. The old
`coordination-checkpoints` JSON is read-only compatibility input; new runs do
not write, delete, or dual-write it.

`getAutoAgentCoordinator()` now returns a run-local facade instead of a process
singleton. Auto execution uses `SubagentExecutionContext` directly and does not
reconstruct legacy `ToolContext`.

## S8.5 executor boundary

Dynamic Workflow uses two non-overlapping graph layers:

```text
Parent GraphRunner
  DynamicWorkflow GraphNode
    process sandbox nested graph
      agent node / parallel item / pipeline item-stage node
```

The sandbox child continues to own `parallel()` and `pipeline()` composition:

- `parallel()` invokes thunks and maps each rejected item to `null`;
- `pipeline()` lets every item traverse its stages independently, without a
  stage barrier, and maps a failed item to `null`;
- Host receives versioned `nested-graph:v1` identity on RPC frames. Identity is
  derived from logical workflow run id, script hash, group call index, item,
  stage, and agent call index; attempt, pid, random values, credentials, and env
  do not enter logical node ids.

The Parent GraphRunner treats the workflow as one executor node and never claims
to schedule sandbox closures. Nested metadata supplies progress and recovery
evidence without moving closures into Host. The parent checkpoint stores the
script/workflow/nested/journal identity and latest nested checkpoint ref;
completed calls continue to reuse the existing journal result cache.

`NativeConversationExecutor` is lifecycle-only and delegates the sole model/tool
loop to `ConversationRuntime`. `ExternalEngineExecutor` maps a node to the
existing S5 lifecycle/resume builders and refuses unsafe MiMo/Kimi recovery.
`McpTaskExecutor` admits only Durable Task tools and maps provider waiting/result
handles onto node checkpoints; synchronous MCP tools remain on ToolExecutor.

`GraphEventCompatibilityAdapter` is the centralized migration fan-out to
AgentEvent, SwarmEvent, ScriptRunEvent, DAG visualization, and session replay
evidence. The migrated Dynamic Workflow entry uses it as its public lifecycle
source. Agent Team and Auto Agent retain their S8 facade projections until their
call sites are switched to the same sink in the final S8.5 integration slice.
The adapter fences duplicate Graph terminal projection per run attempt;
projection failures are diagnostics and never replace the authoritative result.

## Debt delta at the phase-4 boundary

The 25 files named in the S8 baseline contained 11,545 lines. The same set now
contains 11,163 lines: `AutoAgentCoordinator` fell from 651 to 375 lines and
`ParallelAgentCoordinator` from 1,362 to 1,256 lines. The new orchestration
contract, runner, ports, and adapters contain 1,092 lines, so the comparable
baseline plus new kernel is 12,255 lines. This first slice adds an explicit
kernel while deleting 927 lines of duplicated/legacy implementation overall.

For migrated live paths:

- three scheduling bodies (Auto strategy loops, Parallel remaining/ready loop,
  and Parallel's second DAGScheduler body) became one GraphRunner path;
- Auto's process singleton was removed; process-level runtime holders fell from
  four to three (Parallel registry facade, DAGScheduler configuration/event
  template, and the still-unmigrated Workflow `activeRuns` map);
- retry and graph terminal selection moved to GraphRunner; `retryTask()` and
  `executeWithDAG()` are compatibility methods;
- coordinator-local abort controllers remain executor cancellation mechanisms,
  while GraphRunner decides graph cancellation and propagation;
- public compatibility status types remain in source, so the raw status-type
  count does not yet fall. They are projections for migrated paths rather than
  independent scheduling authorities.

The remaining duplicate terminal/cancel/checkpoint owners are Dynamic Workflow,
External Engine lifecycle, and MCP Durable Task. They were regression-tested in
this slice but were not migrated.

## Rollback

The completed slice consists of four local commits after S7.5. Roll back by
moving the S8 branch to `4430f4ecf30ba9722c42b02f7309bcb92a3c0082`, or revert
the S8 commits in reverse order. Durable schema and historical user data require
no rollback because neither was changed.
