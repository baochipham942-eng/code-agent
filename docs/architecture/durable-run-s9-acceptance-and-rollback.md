# S9 Durable Run acceptance and rollback

## Release status

S9 is not release-approved yet. The process-level matrix proves the storage,
lease, fencing, checkpoint, Dynamic Workflow, Agent Team reconciliation,
External Engine, MCP Durable Task, and Graph compatibility contracts. The
release gate intentionally remains red because the production Native recovery
handler is still review-only, Auto Agent recovery has no production startup
handler, and the new Durable read selector is not yet connected to the migrated
engine read consumers.

The safe default therefore remains `dual_write`. Do not change the default to
`durable_preferred` until `productionExecutorRecovery` and
`productionReadPreferenceWiring` are true in the generated report.

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

The matrix contains 14 variants across nine core kill points. Production
handlers are exercised for Dynamic Workflow, Agent Team child reconciliation,
External Engine, and MCP Durable Task. Native model/tool/approval and the
Agent Team/Auto Agent compatibility-only case still use the acceptance handler;
the report marks those rows with `productionRecoveryPath: false` and fails the
release gate.

## Runtime modes

`CODE_AGENT_DURABLE_RUN_MODE` is resolved once by shared Web/Tauri application
wiring:

| Value | New Durable runs | Read preference | Intended use |
| --- | --- | --- | --- |
| `legacy` | off | legacy | runtime kill switch |
| `dual_write` | on | legacy projection | current safe default |
| `durable_preferred` | on | Durable, legacy only when no Durable row exists | target after the S9 gate is green |

An invalid value disables Durable activation and read preference together and
emits a diagnostic. When Durable preference is enabled, repository errors are
returned to the caller; only a confirmed missing Durable row may use historical
legacy data. Repository or migration initialization failure is fail-closed for
Durable activation. The selector and repository query are implemented and
tested, but production engine/session read consumers are not connected yet;
`durable_preferred` must remain an explicit test-only target until that wiring
lands.

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
- unanswered approval identity;
- running child without reconcilable terminal evidence;
- Dynamic workspace, model, tool, journal, or identity drift;
- MiMo/Kimi or another external engine without an audited resume contract;
- MCP handle loss, checksum/binding failure, server identity drift, or lost
  query capability;
- Native model/tool/approval startup continuation until a production Native
  recovery host persists and consumes the required checkpoint descriptor.
