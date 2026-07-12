# S9 Durable Run acceptance and rollback

S9.5 production implementation SHA: `a971fd8f5089a52263df202ef772f6b1218b0189`.

## S9.5 production-path audit (baseline `2548c7b1c`)

The pre-change audit found the following ownership and fact-source wiring. This
inventory is the boundary for the S9.5 cutover; it does not authorize a schema,
engine-kind, or public event-contract change.

| Product path | Runtime owner on the baseline | Durable registry on the baseline | Audit conclusion |
| --- | --- | --- | --- |
| Web Native run | `src/web/webServer.ts` module-level `runRegistry` | the same registry is passed to the Web `initializeDurableRun()` call | creation and startup claim share an owner |
| Desktop Native run | `TaskManager` / per-session `AgentOrchestrator` | desktop bootstrap creates a separate `externalRunRegistry` | Native execution never creates its run in the registry scanned at startup |
| Agent Team | `AgentTeamDurableRuntime`, globally configured by `RunRegistry.configureDurableKernel()` | whichever registry was configured last | Web shares the Native registry; desktop inherits the otherwise External-only registry |
| Auto Agent | `AutoAgentCoordinator` and a process-local `GraphRunner` | none | it uses no Durable envelope and has no startup discriminator |
| Dynamic Workflow | `scriptRuntime/runService` plus the Dynamic recovery host | handler receives the bootstrap registry | Web does not pass an application host; desktop passes a host backed by the External-only registry |
| External Engine | `ExternalEngineDurableLifecycle` | desktop `externalRunRegistry`; Web Native registry is not its facade registry | desktop creation and recovery share the dedicated registry |
| MCP Durable Task | `McpDurableTaskController` and the shared Durable kernel | operation handler is registered on the bootstrap registry | operation facts live in the six Durable tables plus the integrity-bound result file store |

The desktop bootstrap therefore scans an independent registry which has no
Desktop Native run records and is also used to configure the process-global
Agent Team runtime. S9.5 must correct that owner wiring directly. Copying live
maps between registries is forbidden.

Native checkpoints on this baseline persist the envelope identity, attempt and
owner lease, monotonic checkpoint/event cursor, opaque engine cursor, pending
operation identity/idempotency/status/effect classification, child projections,
and trace identity reconstructed from the envelope. They do not yet persist a
versioned Native recovery descriptor for provider/model, canonical workspace,
model result handle, tool result evidence, or approval identity.

The operation fact sources are:

- approval identity and answer state: the pending approval repositories/gates;
- model operation identity: the Durable pending-operation row, with provider
  query evidence only when a trusted provider result handle is present;
- tool operation identity and result evidence: the Durable pending-operation
  row plus the Tool execution ledger/provider operation id;
- terminal/run ownership: the Durable envelope, attempt, checkpoint, event and
  owner lease rows; compatibility session state is only a projection.

Auto Agent is required to remain under the existing `agent_team` engine kind.
Its production cursor discriminator is versioned independently from the
existing Agent Team cursor and references a stable session message identity;
prompt text, provider clients, functions, credentials, and complete environment
data are not recovery descriptors.

The real read consumers audited for cutover are Native status and lifecycle
control targeting, Agent Team/Auto Agent current and terminal projection,
Dynamic Workflow `getRunState`, External Engine lifecycle lookup, and session
restore/replay decisions. A Durable row is authoritative for every migrated
consumer in `durable_preferred`; legacy is allowed only after
`getLatestBySession()` returns no row. Historical sessions with no Durable row
remain readable from legacy state. Repository errors are observable failures
and never trigger legacy fallback.

## Release status

S9.5 is release-gate approved when the checked-in machine report has `pass:true`
and both production gates are true. Native model/tool/approval recovery now
dispatches through `NativeRecoveryHost`; Auto Agent uses the existing
`agent_team` engine kind with an `auto_agent` cursor discriminator. Web and
Tauri use one application registry owner and one Durable read service.

The default is `durable_preferred`. `CODE_AGENT_DURABLE_RUN_MODE=legacy`
remains the restart-time kill switch and preserves all Durable history.

## Acceptance command and evidence

Run:

```bash
npm run acceptance:durable-run-s9
```

The command writes a mode-0600 JSON report to:

```text
test-results/durable-run-s9-acceptance.json
```

The report includes baseline/tested SHA, platform, Node version, Durable schema
version, every kill point, recovery action, owner epochs, attempt, terminal
count, duplicate side-effect count, review reason, rollout mode, rollback
round-trip, and duration. It excludes environment dumps, prompts, API keys,
tokens, and user file contents.

Every scenario starts a separate process with a real SQLite file and persistent
data directory. The parent waits for a checkpoint marker, sends `SIGKILL`, waits
for lease expiry, then starts a fresh process through the shared application
rollout initializer. The new process claims the lease, dispatches recovery, and
proves that the previous owner cannot append a checkpoint.

The matrix contains 14 variants across nine core kill points. All release rows
use handlers registered by `initializeDurableRun()` and
`createDurableRecoveryRuntime()`; none supplies `recoveryHandlerOverrides`.
Deterministic fakes replace provider, CLI, MCP, and Graph executor ports only.

## Runtime modes

`CODE_AGENT_DURABLE_RUN_MODE` is resolved once by shared Web/Tauri application
wiring:

| Value | New Durable runs | Read preference | Intended use |
| --- | --- | --- | --- |
| `legacy` | off | legacy | runtime kill switch |
| `dual_write` | on | legacy projection | compatibility override |
| `durable_preferred` | on | Durable, legacy only when no Durable row exists | default after the S9.5 gate |

An invalid value disables Durable activation and read preference together and
emits a diagnostic. When Durable preference is enabled, repository errors are
returned to the caller; only a confirmed missing Durable row may use historical
legacy data. Repository or migration initialization failure is fail-closed for
Durable activation. Native status/control, Agent Team/Auto Agent, Dynamic
Workflow, External Engine, and session replay use the same centralized mapper.

## Runtime rollback

1. Set `CODE_AGENT_DURABLE_RUN_MODE=legacy` in the Web/Tauri process
   environment.
2. Restart the process.
3. Verify the acceptance report rollback phases show one retained Durable row
   and all six retained tables.
4. To restore the target mode later, set
   `CODE_AGENT_DURABLE_RUN_MODE=durable_preferred`, restart, and rerun the gate.

Runtime rollback does not delete or mutate Durable history. It requires no
schema change.

## Schema rollback

Schema rollback is a separate manual, stopped-system operation. Export and
review retention requirements first, verify every consumer is on `legacy`, then
drop the six tables in dependency order. No startup path performs this action,
and no release automation should call `rollbackDurableRunMigrationDraft()`.

## Remaining review boundaries

- uncertain write/tool dispatch without trusted dedupe or query evidence;
- missing, conflicting, or orphaned approval identity;
- running child without reconcilable terminal evidence;
- Dynamic workspace, model, tool, journal, or identity drift;
- MiMo/Kimi or another external engine without an audited resume contract;
- MCP handle loss, checksum/binding failure, server identity drift, or lost
  query capability;
- provider model result handles that cannot be queried and model retry contracts
  that cannot prove side-effect-free compute;
- Auto Agent source-message, graph-definition, cursor-version, or workspace drift.

Schema rollback remains a manual stopped-system operation. Runtime rollback
never invokes `rollbackDurableRunMigrationDraft()`.
