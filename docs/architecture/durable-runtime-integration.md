# Durable Runtime Integration

S9.5 production implementation SHA: `a971fd8f5089a52263df202ef772f6b1218b0189`.

## Unified recovery boundary

`RunRegistry.recoverDurable()` remains the only startup lease claimant. It reconstructs owner, attempt, envelope, checkpoint state, and logical trace context, then returns `RunRehydrationPlan[]`. `DurableRecoveryDispatcher` owns no Durable state transition; it invokes registered runtime handlers after the claim.

Each non-terminal plan is processed in two phases:

1. engine recovery for `native`, `agent_team`, `external_cli`, or `dynamic_workflow`;
2. pending-operation recovery, currently explicit MCP `tool_call` task handles.

| Route | Handler | Startup behavior |
| --- | --- | --- |
| `native` | Native review handler | owner/attempt/trace are rehydrated; runtime continuation remains `requires_review` |
| `agent_team` | S4 Team handler | restores checkpoint, completed results, mailbox, approval id, owner epoch, and protocol-native `SubagentExecutorPort` |
| `external_cli/codex_cli` | S5 lifecycle + Codex resume builder | resumes only with stable session id and read-only launch context |
| `external_cli/claude_code` | S5 lifecycle + Claude resume builder | resumes only with stable session id and read-only launch context |
| `external_cli/mimo_code` | S5 decision | `requires_review` (`non_resumable`) |
| `external_cli/kimi_code` | S5 decision | `requires_review` (`unknown`) |
| `dynamic_workflow` | DynamicWorkflowExecutor recovery handler + application dependency resolver | rebuilds read-only model/tool/journal dependencies from current Host services, revalidates workspace/cwd, and resumes the same logical sandbox graph; any missing or drifted capability becomes `requires_review` |
| explicit MCP `tool_call` | S6 MCP handler | queries only an integrity-bound `mcp-task:v1` handle on a currently trusted/queryable server |
| unregistered pending operation | dispatcher | explicit `unsupported`; never silently ignored |

Engine and operation handlers have separate dispatch keys. One handler failure becomes a structured `failed` result and does not stop other plans. Repeated dispatch returns `duplicate` and never creates another Team coordinator, external process, or MCP query/result commit. Terminal runs bypass every handler.

## Startup and shutdown

Host bootstrap keeps the synchronous recovery order. Web/Tauri splits readiness from remote capability recovery so a fresh profile can expose `/api/health` without waiting for remote MCP servers:

1. initialize database and Durable kernel dependencies;
2. start plugin, skill, and MCP initialization as a background capability bootstrap;
3. let the webServer finish handler registration and HTTP listen while remote capabilities connect;
4. after capability bootstrap settles, construct the Dynamic Workflow Host resolver and register recovery handlers;
5. call `recoverDurable()` once and dispatch returned plans;
6. schedule one lease-boundary scan through the same runtime;
7. cancel the delayed scan and await in-flight recovery work during shutdown.

Until step 4 finishes, durable activation remains fail-closed (`ready=false`); HTTP health and the builtin renderer remain available, while agent routes cannot claim durable readiness early. The non-web Host path still awaits background infrastructure before recovery because it has no Tauri first-window health deadline.

Database initialization failure remains fail-closed. MCP trust is an explicit local allowlist supplied through `CODE_AGENT_MCP_DURABLE_TRUSTED_SERVER_IDENTITIES`; an empty or stale allowlist produces review rather than a query. MCP results are stored as mode-0600 local files referenced by opaque SHA-256 ids, without changing Durable Run tables or ToolCache policy.

Graph executor recovery ports are registered before execution. Graph checkpoints
remain embedded engine state: Dynamic Workflow carries its nested/journal cursor,
External Engine carries engine/session cursor, and MCP carries its integrity-bound
task operation. Interrupted running Graph nodes call the executor `recover` port
and completed nodes are not relaunched. Dynamic recovery persists only its
versioned Graph descriptor, model identity, read-only tool profile, canonical
workspace/cwd fingerprint, and nested/journal cursor. Functions, provider
secrets, credentials, environment values, and tool implementations never enter
the checkpoint. On startup the application resolves those capabilities from
current Host services after database and runtime initialization. Model/tool
absence, workspace drift, identity mismatch, stale owner/attempt, or any
write/unknown side effect fails closed to `requires_review`.

The recovery handler binds the newly claimed owner and attempt before creating
the executor. Every Graph checkpoint write reuses `RunRegistry.checkpointDurable`,
so the existing owner epoch fencing rejects a stale process. No Durable schema,
repository, migration, or second logical Durable Run was added.

## S9 rollout wiring and current gate

Web and Host now call `initializeDurableRun()` and resolve the same three-mode
policy from `CODE_AGENT_DURABLE_RUN_MODE`. Invalid configuration cannot produce
a write-on/read-off hybrid. `durable_preferred` reads propagate repository
errors and fall back to legacy only when `getLatestBySession()` proves that no
Durable row exists.

S9.5 makes `durable_preferred` the default after the process gate proves the
Native production Host, Auto Agent startup handler, and all migrated read
consumers. Native model/tool/approval descriptors contain stable identities and
cursors only. Auto Agent stays under `agent_team` and dispatches by its
versioned cursor. Provider contracts that cannot prove query or safe retry,
unknown writes, dependency drift, and missing approval identity remain review
boundaries. See
[S9 acceptance and rollback](durable-run-s9-acceptance-and-rollback.md).
