# Durable Runtime Integration

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
| `dynamic_workflow` | Dynamic review handler | runtime continuation remains `requires_review` |
| explicit MCP `tool_call` | S6 MCP handler | queries only an integrity-bound `mcp-task:v1` handle on a currently trusted/queryable server |
| unregistered pending operation | dispatcher | explicit `unsupported`; never silently ignored |

Engine and operation handlers have separate dispatch keys. One handler failure becomes a structured `failed` result and does not stop other plans. Repeated dispatch returns `duplicate` and never creates another Team coordinator, external process, or MCP query/result commit. Terminal runs bypass every handler.

## Startup and shutdown

Web/Tauri webServer and Host bootstrap use the same order:

1. initialize database and Durable kernel dependencies;
2. initialize MCP/runtime dependencies;
3. register all recovery handlers synchronously;
4. call `recoverDurable()` once;
5. dispatch returned plans;
6. schedule one lease-boundary scan through the same runtime;
7. cancel the delayed scan and await in-flight recovery work during shutdown.

Database initialization failure remains fail-closed. MCP trust is an explicit local allowlist supplied through `CODE_AGENT_MCP_DURABLE_TRUSTED_SERVER_IDENTITIES`; an empty or stale allowlist produces review rather than a query. MCP results are stored as mode-0600 local files referenced by opaque SHA-256 ids, without changing Durable Run tables or ToolCache policy.
