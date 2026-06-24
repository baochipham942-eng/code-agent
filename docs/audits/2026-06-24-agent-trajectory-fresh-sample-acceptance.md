# Agent Trajectory Fresh Sample Acceptance - 2026-06-24

## Scope

- Mode: controlled fresh-sample acceptance in a temporary data directory.
- Live DB mutation: none.
- External model calls: none. The run uses the deterministic local E2E agent model.
- Runtime path: real `TestRunner`, `StandaloneAgentAdapter`, `AgentLoop`, `Read` tool, telemetry collector, trajectory exporter, quality gate, JSONL writer, review manifest writer, batch review apply, and reviewed closeout re-export.

This validates the batch collection, explicit review-apply, and reviewed closeout mechanics for P3. It does not replace the final live-user-data sample, which still needs 20-50 fresh P2-instrumented sessions from normal product usage.

## Command

```bash
npm run acceptance:agent-trajectory-fresh-sample -- --count 20 --json --keep-tmp
```

The script defaults to 20 cases. Each case creates a real AgentLoop session in a temp DB, asks the agent to read a local fixture with the `Read` tool, verifies the tool call and final answer, then exports the sampled sessions through `exportAgentTrajectories`.

## Result

Last verified run: 2026-06-24 10:32 UTC.

| Metric        | Value |
| ------------- | ----: |
| Exit code     |     0 |
| Cases         |    20 |
| Passed cases  |    20 |
| Audited       |    20 |
| Exported      |    20 |
| G2            |    20 |
| G1            |     0 |
| G0            |     0 |
| G2 rate       |  100% |
| Core eval     |    20 |
| Diagnostic    |     0 |
| Excluded      |     0 |
| Review items  |    20 |
| Review applied |   20 |
| Manual reviewed after apply | 20 |
| Pending review after apply | 0 |

Gate result:

- `minSessions >= 20`: passed.
- `G2 rate >= 0.70`: passed.
- `top failure rate <= 0.20`: passed.
- exported `core_eval` count equals sampled session count: passed.
- batch review apply writes 20 explicit controlled decisions: passed.
- reviewed re-export reports `manual_review=20` and pending review 0: passed.

## Review Manifest

The acceptance run writes a temp `fresh-sample-review.json` with one `reviewItems` entry per sampled session. Each item includes an empty `review` object for human review: `datasetRole`, `taskKind`, `reviewedBy`, and `notes` start as `null`, and `instruction` names the gate suggestion plus allowed dataset roles.

It also writes `fresh-sample-review-reviewed.json` with explicit controlled decisions, applies that manifest through `applyAgentTrajectoryReviewManifest`, and re-exports the same temp DB to prove `collection.source = manual_review` is what the closeout gate sees. The default run deletes the temp directory at the end, so use `--keep-tmp` when the manifest or JSONL needs to be inspected manually.

Example inspection command:

```bash
npm run acceptance:agent-trajectory-fresh-sample -- --count 20 --json --keep-tmp
```

## Operational Meaning

This confirms that the P3 mechanics are in place:

- 20-session fresh batch generation works.
- Real AgentLoop telemetry can be replayed into agent trajectories.
- Strict gate passes on complete P2-style sessions.
- `core_eval` JSONL export is limited to export-ready trajectories.
- Review Queue manifest generation is actionable and session-id based.
- Batch review apply can persist explicit decisions without copying the temp DB.
- Reviewed closeout re-export sees 20 `manual_review` rows and zero pending review rows.
- Acceptance logging is reduced by default through `NODE_ENV=production`, without enabling `CODE_AGENT_CLI_MODE`.

## Remaining Live Boundary

The live app DB still needs a fresh post-P2 user-data sample before the overall P3 goal can be considered complete. The next live acceptance command should use the P2 rollout timestamp:

```bash
npm run trajectory:live-closeout -- --since=<p2-rollout-time>
```

Expected live closeout criteria:

- at least 20 fresh real product sessions audited
- `fresh-sample-review.json` contains actionable `reviewItems`
- every sampled session is saved through manual Replay dialog review
- `core-eval.jsonl` contains at least 20 `core_eval` rows
- strict closeout gate passes, or the top failure bucket becomes the next capture fix
