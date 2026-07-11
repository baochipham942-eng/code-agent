# External Agent Engine durable lifecycle

## Identity and ownership

Codex CLI, Claude Code, MiMo-Code, and Kimi Code launches now enter the same Durable Run fact source as Native runs. `sessionId` remains the conversation identity. `runId` is the logical execution identity and remains stable when recovery claims a later `attempt` with a higher owner epoch.

`RunRegistry.startExternalDurable()` creates the envelope through `RunKernelAdapter.createRun()` with `engine.kind = external_cli`. It prepares one stable `external_engine` launch operation whose idempotency key is independent of attempt and process identity. The active `RunHandle` owns cancellation and session-conflict checks. A stale handle, owner epoch, attempt, or event cursor cannot commit a checkpoint or terminal state for a newer attempt.

The web route creates the run before SSE headers, so `task_start`, normalized adapter events, cancellation, and terminal writeback share the same `runId`. The desktop app service uses a dedicated external-engine registry backed by the same Durable Run repository. Startup recovery dispatch is intentionally not registered in this slice.

## Checkpoint schema

External checkpoints use engine cursor schema version 1 and retain only bounded recovery evidence:

- external CLI kind and engine name
- resolved binary path and detected CLI version
- PID and POSIX process-group identity when available
- canonical cwd plus workspace fingerprint
- redacted command summary
- external session/thread id
- stdout/stderr byte cursors and log reference
- provider/model and permission profile
- last normalized event summary
- audited resume capability

Prompts, raw stdout/stderr, API keys, tokens, cookies, authorization values, passwords, and secrets are excluded. Log paths are references; recovery does not interpret process exit or log existence as successful task completion.

## Recovery capability audit

Audit date: 2026-07-11. The matrix describes the installed runtime and current adapter behavior, not a marketing capability.

| Engine | Audited runtime | Capability | Evidence and product behavior |
| --- | --- | --- | --- |
| Codex CLI | `codex-cli 0.144.1` | `resumable` | `codex exec resume [SESSION_ID] [PROMPT]` accepts a stable session UUID/thread name. JSON events expose the thread/session id, which is persisted in the versioned engine cursor. Recovery may resume only when that id exists. |
| Claude Code | `2.1.207` | `resumable` | `claude --resume <session-id>` is supported in print mode. The adapter no longer passes `--no-session-persistence`, because that flag explicitly makes sessions non-resumable. Recovery may resume only with the parsed session id. |
| MiMo-Code | `0.1.1` | `non_resumable` | Installed CLI help exposes no stable session id or resume command. Re-sending prior context would be a new execution, so recovery returns `requires_review`. |
| Kimi Code | CLI not installed in the audited host | `unknown` | The stream parser can persist a session id when emitted, but this host cannot prove a supported, stable resume command. Recovery returns `requires_review`; it does not restart or claim resume. |

`restartable_with_context` remains a valid decision vocabulary but is not assigned to these four adapters. A prompt replay must be represented as a new execution decision, never as continuation of the old external process.

## Recovery handler boundary

`canRecoverExternalEngine(plan)`, `buildExternalEngineRecoveryDecision(plan)`, and `resumeExternalEngine(plan, deps)` are exported from the Agent Engine module. The decision handler:

1. rejects non-external plans;
2. never restarts a terminal run;
3. resumes only a `resumable` engine with a persisted external session id;
4. returns `requires_review` for non-resumable, unknown, or incomplete evidence;
5. delegates the actual engine-specific resume launch through injected dependencies, preserving the logical `runId`, newly claimed attempt, owner lease, and stable launch idempotency key.

The global startup recovery dispatcher is deliberately unchanged. A later integration slice must register this handler and supply engine-specific resume command builders without weakening the read-only permission policy.

## Terminal and trace rules

Process exit is transport evidence only. A completed Durable Run requires parsed terminal evidence such as a final result/message. Exit code zero without that evidence is committed as failed. Cancellation wins over a late process result.

Every attempt retains the deterministic logical trace id derived from `runId` and receives a new attempt span. The external process creates an `external_engine` child span. Normalized stdout events, model usage, and bounded tool summaries are span events. Trace/export failures are swallowed at the diagnostic boundary and cannot change the engine result or owner state.
