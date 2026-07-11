# Multiagent protocol-native execution

## Scope

Task, `spawn_agent` / `AgentSpawn`, and `workflow_orchestrate` now project the
authoritative protocol tool context into one explicit subagent execution request.
Their production path no longer converts through the legacy tool context or a
legacy result adapter.

The public tool schemas, names, result metadata, SessionEvent, SSE, and IPC
contracts are unchanged. Dynamic `workflow` keeps its existing S2 runtime and
legacy tool adapter; only its call into the shared subagent executor uses the new
request shape.

## Execution ports

`SubagentExecutionRequest` contains the prompt, agent configuration, and an
immutable `SubagentExecutionContext`. The context carries:

- Native `runId`, `sessionId`, immutable `workspace`, and `cwd`;
- model configuration and a narrow resolver port;
- permission, hook, event/progress, and abort ports;
- the explicit `RunTraceContext` captured at protocol dispatch;
- attachments and parent conversation projections;
- spawn depth, tree, timeout, remaining-budget, and parent identity;
- immutable `SwarmRunScope`, `parentNativeRunId`, and logical tool call id.

`SubagentExecutorPort.execute(request)` is the shared S8-consumable boundary.
Parallel coordination and the DAG scheduler depend on this port and context,
without retaining either legacy `ToolContext` or the complete
`ProtocolToolContext`.

## Cancellation and permission ownership

Each foreground child receives its own controller linked one-way to its parent.
Child failure or timeout does not abort the parent or siblings. The
`run_in_background` protocol wrapper creates a child-owned controller before
dispatch, so ending the foreground turn does not cancel the detached in-process
child. This remains process-local and does not claim crash resume.

Permission requests use the injected permission port. Existing inheritance and
mode narrowing still run before dispatch; operations that are not auto-approved
delegate to the real parent callback and preserve its allow/deny result.

## Durable Agent Team invariants

The S4 Durable Agent Team adapter, checkpoint schema, and recovery handler remain
authoritative and unchanged. The protocol migration preserves:

- stable Team run id derived from Native parent run id plus logical tool call id;
- stable launch approval identity and immutable Team/tree scope;
- parent child operation/projection and initial checkpoint before execution;
- node dispatch checkpoint before the executor starts;
- completed result-reference reuse without re-execution;
- `requires_review` for uncertain side effects without deduplication evidence;
- owner epoch fencing and fail-closed behavior when Durable persistence is absent.

## Compatibility boundary

`SubagentExecutor` temporarily exposes a three-argument overload for tests and
unmigrated callers. `subagentExecutorLegacyAdapter.ts` only projects fields and
owns no permission, cancellation, model, retry, checkpoint, or recovery policy.
AutoAgentCoordinator is the remaining production compatibility caller. It can
move to the request port independently when S8 converges the orchestration
kernel.

The legacy adapter for Dynamic `workflow` remains intentionally outside this
slice. MCP, external engines, global startup wiring, and Durable Run contracts
are unchanged.
