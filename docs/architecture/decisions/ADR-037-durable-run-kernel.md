# ADR-037 — Durable Run Kernel identity, ownership, and recovery semantics

- Status: accepted; S3.5 shared constructor and projection boundary frozen
- Date: 2026-07-11
- Related: `native-run-context.md`, `coordinator-checkpoint-symmetry.md`, ADR-022 execution ledgers, ADR-023 Swarm ledger

## Context

Neo already has process-local Native `RunContext`/`RunRegistry`, session-level status, tool begin/complete events, persisted approvals, workflow journals, and a Swarm ledger. These sources improve isolation and diagnostics, but none can reconstruct one logical run across a process restart. They use different run meanings, lack a shared attempt/owner fence, and cannot atomically connect events, pending operations, checkpoints, and terminal state.

## Decision

1. `runId` is the stable logical execution identity. `sessionId` remains the conversation identity.
2. Recovery creates a new `processInstanceId`, increments `attempt`, and takes ownership with a monotonically increasing owner epoch after the previous lease becomes stale.
3. Node execution is at least once. Neo does not advertise exactly-once execution.
4. Side-effecting operations use a stable idempotency key, an execution ledger, and human confirmation when an uncertain dispatch cannot be safely deduplicated.
5. Native, Agent Team, Dynamic Workflow, and external CLI engines adopt one `RunEnvelope` and one state machine.
6. Per-run events use a monotonic sequence that continues across attempts. Checkpoint commits atomically bind events, pending/child projections, checkpoint state, cursor advancement, and the run projection.
7. Terminal states are immutable. Terminal event and terminal projection commit atomically under the current owner epoch.
8. Existing SessionEvent, SSE, IPC, CLI, and database contracts remain compatible during dual-write migration. The new tables are additive and independently removable.
9. Engine integrations use `RunKernelAdapter.createRun()` and `prepareOperation()` instead of constructing
   envelopes or writing repositories directly. Native/tool-specific methods remain compatibility wrappers.
10. Parent/child construction and terminal projection use shared pure helpers; durability is established only
    by the existing fenced checkpoint transaction.

The normative details, failure gold, migration schema, and S1–S9 file ownership are in [Durable Run Kernel contract](../durable-run-kernel.md).

## Consequences

- Crash recovery can reason about uncertain work without silently duplicating side effects.
- Every engine must preserve logical run identity even when its native process/session identifiers change.
- Stores must support compare-and-swap ownership and transactional event/checkpoint writes; simple last-write-wins updates are invalid.
- A valid checkpoint can still repeat the current node, so tool authors and engine adapters must design for at-least-once execution.
- Crash resume support is engine-specific. Real process evidence now supports
  Dynamic Workflow, Agent Team child reconciliation, resumable Codex/Claude
  External Engine sessions, and trusted/queryable MCP Durable Tasks. Native
  model/tool/approval continuation and Auto Agent startup recovery remain
  unsupported in production, so the product-wide Durable rollout cannot yet be
  advertised or defaulted to `durable_preferred`.

## Rejected alternatives

### Reuse `sessionId` as run identity

A session may contain sequential runs, retries, and imported external executions. Session identity cannot fence stale execution owners or provide per-run terminal truth.

### Treat each recovery attempt as a new `runId`

This loses the logical operation ledger and makes idempotency keys, child relationships, and user-visible recovery history split across unrelated runs.

### Promote `session_events` or `swarm_run_ledger` directly

`session_events` lacks run sequence identity. `swarm_run_ledger` has per-run sequence but only models Team/Swarm rollups. Altering either in place would couple migration to existing consumers and weaken rollback.

### Claim exactly-once execution

SQLite cannot atomically commit external provider/tool side effects. At-least-once nodes plus idempotency and explicit uncertainty is the supportable contract.
