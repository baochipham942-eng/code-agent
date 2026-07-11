# Agent Team Durable Recovery

## Product boundary

Agent Team adopts the existing Durable Run kernel with at-least-once node execution. It does not claim
exactly-once behavior for model, tool, network, worktree, or external provider effects. A completed node is
reused only when the Team checkpoint contains its result reference. An uncertain side-effecting dispatch is
never automatically repeated without provider lookup/deduplication evidence.

The production `spawn_agent` parallel path derives one stable Team run id from the Native parent run id and
the logical tool call id. Before launch approval or child execution it commits the Native parent's
`child_run` operation and child projection, creates an `agent_team` Durable Run, and writes the initial Team
checkpoint. Missing Durable persistence fails closed.

## Checkpoint schema v1

`AgentTeamCheckpointState` is the only authoritative Team recovery snapshot. It is written through
`RunKernelAdapter.checkpoint()`, so node state, pending operations, mailbox cursor, internal run event, and
engine cursor share the kernel's fenced SQLite transaction.

The snapshot contains:

- `teamId`, `treeId`, immutable `SwarmRunScope`, and Native `parentRunId`;
- the task graph, dependencies, node status, role, model, tools, permission profile, and side-effect bit;
- monotonic mailbox `nextSeq`, committed cursor, stable message ids, pending messages, and consumed ids;
- findings, decisions, errors, completed result refs, and running child refs;
- pending approval refs, worktree refs, artifact refs, cancellation flag, and schema version.

Message bodies remain inside the encrypted/local Durable checkpoint payload. Run events and OTel attributes
carry only message-free metadata such as tree id, task status, and mailbox cursor.

## Recovery matrix

| Durable evidence | Decision | Runtime action |
| --- | --- | --- |
| completed node + result ref | `reuse_completed` | restore result into coordinator; do not execute node |
| read-only pending/running node without terminal evidence | `retry_safe` | retry with the same node and operation identity |
| side-effect dispatch + provider operation id with lookup/dedup proof | `retry_safe` | query provider or retry with the same idempotency identity |
| side-effect dispatch without terminal/dedup evidence | `requires_review` | stop; require an explicit human decision |
| existing waiting launch approval | `waiting_for_approval` | retain the same approval id; do not issue another request |
| failed/blocked node | `failed` | surface stored failure |
| parent/Team cancelled | `cancelled` | cancel pending/running nodes before any retry |
| child ref absent from the checkpoint graph | `requires_review` | report an orphan; never continue silently |
| missing/unknown checkpoint schema | `requires_review` | fail closed |

The recovery handler exports `canRecoverAgentTeam`, `buildAgentTeamRecoveryDecision`, and
`rehydrateAgentTeam`. This slice deliberately does not register them in the global startup dispatcher;
startup ordering and cross-engine dispatch are reserved for the integration slice.

## Ownership and late events

Every Team checkpoint and terminal commit carries the claimed attempt and owner epoch. A recovered attempt
therefore fences the stale coordinator before its late node terminal can enter the new checkpoint. Child
trace contexts retain the Native trace id while adding Team `runId`, `parentRunId`, `treeId`, and `agentId`.

The parent projection becomes terminal before the Team terminal transaction. If the process dies between
those commits, the Team remains recoverable with completed node result evidence; recovery can finish the
terminal commit without executing completed side effects again.

## Legacy persistence migration

`TeamPersistence` JSON and `parallel-coordination-checkpoints` have no production call sites in the current
parallel `spawn_agent` path. They remain readable compatibility sources for historical user data and tests,
but they are not consulted by Durable recovery and are not dual authorities. This slice does not delete
legacy files.

A later cleanup may remove legacy JSON only after an import tool has copied still-needed team definitions,
findings, and completed outputs into an explicit user-selected destination, retention has been documented,
and telemetry confirms no supported build reads the files. `swarm_run_ledger` remains an append-only
observability/replay ledger; it is not a recovery checkpoint and cannot override Durable state.

## Remaining integration boundary

- Register the exported handler after `RunRegistry.recoverDurable()` in the unified startup dispatcher.
- Reattach a resolver/UI continuation to hydrated waiting launch approvals without changing their ids.
- Add process-kill acceptance coverage once the global dispatcher can restart an actual coordinator.
- Keep public `SessionEvent`/SSE fields, external engines, MCP, and DAGScheduler unchanged.
