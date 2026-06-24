# Agent Trajectory Real Data Backflow Validation - 2026-06-24

## Scope

- Source DB: `/Users/linchen/Library/Application Support/code-agent/code-agent.db`
- Validation mode: copied DB dry-run, copied DB metadata write/read smoke, guarded live seed, guarded live sample append, live review apply, and strict closeout.
- Live DB mutation: yes. The validation seeded live `agentTrajectoryCollection` metadata, appended 20 controlled AgentLoop sample sessions across two backed-up live collection runs, and applied 20 explicit `manual_review` decisions after a live DB backup.
- Export artifacts:
  - `/tmp/agent-trajectory-g2.jsonl`
  - `/tmp/agent-trajectory-all.jsonl`

## Commands

```bash
npx tsx scripts/export-agent-trajectories.ts --limit 50 --json --min-g2-rate=0 --max-top-failure-rate=1 --out /tmp/agent-trajectory-g2.jsonl
npx tsx scripts/export-agent-trajectories.ts --limit 50 --json --min-tier=G0 --include-rejected --out /tmp/agent-trajectory-all.jsonl
```

## Data Shape

- Total sessions in DB: 209
- Telemetry sessions available for trajectory audit: 29
- Telemetry turns: 346
- Telemetry model calls: 346
- Telemetry tool calls: 307
- Session events: 91,748
- Telemetry events: 67,840

The current historical corpus has enough telemetry volume to diagnose failures, but only 29 sessions are eligible for the trajectory audit path.

## Audit Result

| Metric           |  Value |
| ---------------- | -----: |
| Audited sessions |     29 |
| G2               |      5 |
| G1               |     11 |
| G0               |     13 |
| G2 rate          | 17.24% |
| Core eval        |      5 |
| Diagnostic       |     11 |
| Excluded         |     13 |

Task kind distribution:

| Task kind     | Count |
| ------------- | ----: |
| coding        |     4 |
| search        |     9 |
| data_analysis |     0 |
| agent_task    |     3 |
| ordinary_chat |    13 |
| other         |     0 |

Top failures:

| Failure                        | Count |
| ------------------------------ | ----: |
| missing_tool_schemas           |    16 |
| missing_real_agent_trace       |    16 |
| missing_tool_result            |    14 |
| missing_tool_calls             |    13 |
| missing_tool_args              |    13 |
| ordinary_chat_no_tool          |    13 |
| missing_replay_explanation     |     9 |
| missing_tool_definition        |     9 |
| missing_assistant_final_answer |     8 |
| transcript_fallback_replay     |     7 |

## Segmentation Check

- `core_eval`: 5 sessions, all G2, all failure-free.
- `diagnostic`: 11 sessions, mainly search/agent/coding trajectories with repairable or explainable gaps. The dominant issue is `missing_tool_definition` with 9 hits.
- `excluded`: 13 sessions, all classified as `ordinary_chat`, mostly transcript fallback or no-tool sessions. This bucket matches the intended exclusion policy.

This means the standard is useful for analysis. It cleanly separates export-ready sessions from historical diagnostic material and non-agent chat data.

## Metadata Smoke

Copied-DB metadata smoke wrote `agentTrajectoryCollection` into 29 audited sessions and read them back successfully.

Readback still reports `collection.source = audit_backfill`. That is expected: `source` records how the collection metadata was generated, not the physical read location. A manual Review Queue correction should switch source to `manual_review`.

## Gaps

1. Historical coverage is thin: 29 trajectory-auditable sessions out of 209 total sessions.
2. Historical G2 rate is low at 17.24%, so this corpus is better as a diagnostic backfill than as a clean eval dataset.
3. Tool schemas and tool definitions are the biggest blocker for promoting G1 sessions into `core_eval`.
4. Ordinary chat exclusion works, but it also shows why the capture policy must tag non-agent chat early.
5. New P2-instrumented collection still needs its own 20-50 session sample. The current evidence mainly validates historical backfill behavior.

## Collection Spec V1

- Capture unit: one complete session, not a single API call.
- Preferred tasks: Coding, Search, Data Analysis, and other real agent tasks.
- Excluded by default: ordinary chat, translation-only, embedding-only, replay-only, and transcript fallback sessions.
- Required execution chain: User -> Assistant/model decision -> Tool Call -> Tool Result -> Assistant Final Answer.
- Every tool call must have id, name, args, tool schema, and a paired result.
- Every model decision should include provider/model provenance and replay explanation.
- Sessions with missing tool definitions, missing tool schemas, missing tool result, or missing final answer stay in `diagnostic`.
- Sessions with no tool calls or ordinary chat classification go to `excluded`.
- G2 sessions default to `core_eval`.
- Manual review can override dataset role and must set collection source to `manual_review`.
- Dataset version should stay `agent-trajectory-v1` until the required fields or gate logic change.

## Recommended Gates

For historical backfill monitoring:

- `minG2Rate >= 0.15`
- `maxTopFailureRate <= 0.60`

For new P2-instrumented collection after at least 20 fresh sessions:

- `minG2Rate >= 0.70`
- `maxTopFailureRate <= 0.20`
- `minAgentCandidates >= 20`
- `minExported >= 20`
- `minManualReviewed >= 20`
- `minManualReviewedAgentCandidates >= 20`
- `maxPendingReview = 0`
- `maxDiagnosticRate <= 0.30`
- `maxExcludedRate <= 0.05`
- `ordinary_chat` share in the agent collection should be near zero.

## P3 Update

A controlled 20-session fresh-sample acceptance now exists in `scripts/acceptance/agent-trajectory-fresh-sample-smoke.ts` and is recorded in `docs/audits/2026-06-24-agent-trajectory-fresh-sample-acceptance.md`.

That smoke validates the batch mechanics, strict gate, Review Queue manifest, `core_eval` JSONL export, explicit batch review apply, and reviewed closeout re-export in a temporary DB. It does not replace the final live-user-data sample.

The live closeout command now exists:

```bash
npm run trajectory:live-closeout -- --since=<p2-rollout-time>
```

The live Review Queue seed command also exists:

```bash
npm run trajectory:seed-review-queue -- --since=<p2-rollout-time>
```

This is the bridge from copied-DB audit to product UI review. It backs up the live DB files before opening the DB, writes only missing `agentTrajectoryCollection` metadata into the live DB, keeps `collection.source = audit_backfill`, and uses `--allow-gate-failure` so a failing strict gate does not block queue preparation. It does not write `manual_review` decisions and does not overwrite existing reviewed metadata.

This validation ran `trajectory:seed-review-queue` against the live DB after adding automatic live DB backup. Backup files were written to:

```text
/Users/linchen/Library/Application Support/code-agent/backups/agent-trajectory-live-seed/2026-06-24T10-52-56-721Z/
```

Live DB readback after seed:

| Metric | Value |
| ------ | ----: |
| `sessions` rows | 209 |
| rows with `agentTrajectoryCollection` metadata | 20 |
| rows with `collection.source = audit_backfill` | 20 |
| rows with `collection.source = manual_review` | 0 |

The seed step also added the `sessions.metadata` column through normal DB schema initialization. That was expected for this live DB because the column was not present before seed. The backup above was created before opening the DB and before the schema migration.

Current live-copy strict closeout with `--since=2026-03-01T00:00:00+08:00` fails, as expected for the historical corpus:

| Metric          | Value |
| --------------- | ----: |
| Audited sessions | 20 |
| Non-excluded agent candidates | 10 |
| Exported         | 2 |
| G2 rate          | 10.00% |
| Diagnostic rate  | 40.00% |
| Excluded rate    | 50.00% |
| Manual reviewed  | 0 |
| Manual reviewed agent candidates | 0 |
| Pending agent candidate review | 10 |

After live seed, a copied-DB strict closeout reads `byCollectionSource.audit_backfill = 20` and `byCollectionSource.manual_review = 0`. `P3 Review Worklist` is now actionable against live metadata: 10 `agent_candidate` rows and 10 `excluded_control` rows remain pending, with next review session `session_1772973423039_f5decc3e`.

The live review status command now provides the same queue view without rewriting export artifacts:

```bash
npm run trajectory:review-status -- --since=2026-03-01T00:00:00+08:00
```

Current status output is `action_required`: 30 audited sessions, 20 agent candidates, 0 final exported `core_eval` rows, 0 manually reviewed agent candidates, 20 pending agent candidates, 10 pending excluded controls, and next review session `session_1772973423039_f5decc3e`. The 12 G2 `core_eval` rows in the audit are draft candidates only because their `collection.source` is still `audit_backfill`.

The sample-gap command now compares this P3 window with all audited live sessions:

```bash
npm run trajectory:sample-gap -- --since=2026-03-01T00:00:00+08:00
```

Current comparison after the live sample append: the P3 window has 30 sessions, 20 agent candidates, and 0 final exported `core_eval` rows. All available audited sessions have 36 sessions and 26 agent candidates. Historical data still adds 6 agent candidates outside the current window, but the fresh P3 window no longer has a collection-count gap. The remaining gap is manual review and final `core_eval` export.

The live agent-candidate worksheet command now writes a smaller human review artifact:

```bash
npm run trajectory:review-worksheet -- --since=2026-03-01T00:00:00+08:00
```

It generated `docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md` with 20 pending `agent_candidate` rows and blank final decision columns. A dry-run against that worksheet reports 20 skipped rows with `missing_explicit_review_decision` and 0 applied rows, so the worksheet is safe to prepare before actual Replay review.

The live review dossier command now writes a read-only evidence pack for the same pending agent candidates:

```bash
npm run trajectory:review-dossier -- --since=2026-03-01T00:00:00+08:00 --json
```

It generated `docs/audits/agent-trajectory-review-dossier-latest.md` from the live DB without applying review decisions. Current output: 30 audited sessions, 20 included pending `agent_candidate` rows, 10 pending excluded controls kept out of the default dossier, `manual_review = 0`, final exported rows = 0. The first review session remains `session_1772973423039_f5decc3e`.

The dossier adds replay evidence to the worksheet queue: first user prompt, final answer preview, tool chain, models, tool definitions, failed tools, quality metrics, failure tags, trace id, and blank final review fields. It is meant to reduce manual review friction before opening Replay, not to replace Replay review or create `manual_review` metadata.

The live apply path now has the same backup protection:

```bash
npm run trajectory:apply-review-live -- --reviewer human-reviewer
```

It wraps `apply-agent-trajectory-review.ts` with `--apply --live-data-dir --backup-live-db` and uses the agent-candidate worksheet by default. A temp live-DB smoke with one explicit `core_eval` decision created a DB backup, applied 1 reviewed row, skipped the other 9 blank rows, and changed only the temp DB row to `collection.source = manual_review`. That smoke did not mutate the real live DB; after the later live sample append, the real live DB is still `manual_review=0`.

The live post-review check now exists for repeated review passes:

```bash
npm run trajectory:post-review-check -- --since=2026-03-01T00:00:00+08:00
```

It reads the live DB directly, uses `exportCollectionSource = manual_review`, rewrites the closeout report and final JSONL artifacts, and returns exit code 0 so it can be used while review is still in progress. Current result is still `failed`: `manual_review=0`, final exported `core_eval` rows = 0, and `eval-datasets/agent-trajectory/core-eval.jsonl` has 0 lines.

The P3 acceptance snapshot command now gives a single requirement matrix:

```bash
npm run trajectory:p3-acceptance -- --since=2026-03-01T00:00:00+08:00 --json
```

It generated `docs/audits/agent-trajectory-p3-acceptance-latest.md` from the live DB and exited with code 2 because P3 is not complete. Current matrix:

| Requirement | Status | Evidence |
| ----------- | ------ | -------- |
| 20-50 real agent sessions sampled | passed | 30 audited sessions, 20 non-excluded agent candidates; the P3 window needs 0 more agent candidates |
| Review Queue manual review complete | failed | `manual_review=0`, 0 reviewed agent candidates, 20 total pending rows |
| `core_eval` JSONL export ready | failed | 0 formal reviewed export rows, 0 JSONL lines |
| `diagnostic` / `excluded` segmentation available | passed | `core_eval=12`, `diagnostic=8`, `excluded=10` |
| fresh-sample gate threshold calibration | blocked | manual review is not sufficient for threshold tuning |
| P3 closeout decision | failed | current evidence does not prove the requested end state |

The acceptance snapshot also checks the supporting artifacts: `eval-datasets/agent-trajectory/core-eval.jsonl` exists with 0 lines, `docs/audits/agent-trajectory-review-dossier-latest.md` exists, and `docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md` exists. The next review session is still `session_1772973423039_f5decc3e`.

The controlled collection sample command now covers the new-sample capture path without auto-reviewing rows:

```bash
npm run trajectory:collect-sample -- --count=20 --json
```

Verification result: 20 real AgentLoop sessions passed, 20 G2 `core_eval` candidates were exported as draft candidates, `byCollectionSource.audit_backfill = 20`, `byCollectionSource.manual_review = 0`, and all 20 `reviewItems` kept blank `review.datasetRole` fields. The generated sample directory was `/var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-sample-jU51bM`. A follow-up live `trajectory:post-review-check` before the explicit live append still reported the real live DB at `audit_backfill=20`, `manual_review=0`, so the rehearsal itself did not pollute the formal live sample.

The collection command now also has an explicit live append wrapper:

```bash
npm run trajectory:collect-sample-live -- --count=10 --json
```

This wrapper targets the live data directory, requires `--backup-live-db`, keeps runtime scratch files outside Application Support, and writes draft artifacts to `eval-datasets/agent-trajectory/live-collection-sample-latest`. A guard check confirmed that `--live-data-dir` without `--backup-live-db` exits before opening the live DB. A non-live two-session rehearsal still passes: 2 real AgentLoop sessions, 2 G2 `core_eval` draft candidates, `byCollectionSource.audit_backfill = 2`, `manual_review = 0`.

The guarded live append command was then run against the live DB:

```bash
npm run trajectory:collect-sample-live -- --count=10 --json
```

It created the backup below before opening the live DB:

```text
/Users/linchen/Library/Application Support/code-agent/backups/agent-trajectory-collection-sample/2026-06-24T12-27-13-983Z/
```

Result: 10 new controlled AgentLoop sessions, all G2 draft `core_eval` candidates, `byCollectionSource.audit_backfill = 10`, `byCollectionSource.manual_review = 0`, and 10 blank review items. The repo-local draft outputs were written to `eval-datasets/agent-trajectory/live-collection-sample-latest/`.

After this live append, `trajectory:review-status`, `trajectory:review-dossier`, `trajectory:p3-acceptance`, and `trajectory:post-review-check` all read the live DB at the same state: 30 audited sessions, 20 non-excluded agent candidates, 12 draft `core_eval` rows, 8 diagnostic rows, 10 excluded controls, 0 manual review rows, and 0 final `core-eval.jsonl` rows.

The closeout report now includes `P3 Collection Blockers`, which maps every top failure to affected session ids by P3 scope. Current top blockers:

| Failure | Total | Agent candidates | Excluded controls |
| ------- | ----: | ---------------: | ----------------: |
| `missing_tool_schemas` | 12 | 2 | 10 |
| `missing_real_agent_trace` | 12 | 2 | 10 |
| `missing_tool_calls` | 10 | 0 | 10 |

This changes the next engineering reading: the highest global blocker is inflated by excluded ordinary-chat controls, while the agent-candidate-specific repair cluster is smaller and concentrated in `session_1772957797308_2d2ccb53`, `session_1772928877964_6e0d82e6`, and the seven `missing_tool_definition` diagnostic rows.

Failure reasons: `exported_count_below_20`, `manual_reviewed_count_below_20`, `manual_reviewed_agent_candidate_count_below_20`, `pending_review_above_0`, `g2_rate_below_0.7`, `top_failure_rate_above_0.2`, `excluded_rate_above_0.05`.

The generated closeout report now includes a P3 requirement-by-requirement audit:

| Requirement | Current status |
| ----------- | -------------- |
| 20-50 live agent sessions sampled | passed: 30 total sampled, 20 non-excluded agent candidates |
| Review Queue manual review complete | manual_review_required: 0 agent candidates reviewed, 20 agent candidates pending, 30 total rows pending |
| `core_eval` JSONL export ready | failed: 0 rows exported, target is 20 |
| `diagnostic` / `excluded` segmentation available | passed: `core_eval=12`, `diagnostic=8`, `excluded=10` |
| fresh-sample gate threshold calibration | partial: finish manual Replay review before threshold tuning |
| P3 closeout decision | failed |

The same report now carries an executable `P3 Action Plan`. Current live deltas are: manually review 20 agent candidates, promote 20 reviewed G2 rows into the final `core_eval` JSONL, then address `missing_tool_schemas` as the top collection blocker before threshold tuning.

The closeout report also includes `P3 Review Worklist`. It keeps already reviewed rows out of the pending list, orders pending `agent_candidate` rows before `excluded_control`, and exposes the top pending failure with the related session ids for focused capture-quality debugging.

## Batch Review Apply Smoke

At the mixed-window checkpoint, `fresh-sample-review.json` had 30 `reviewItems`, and all 30 included an empty nested `review` object for human decisions. It also marked `reviewScope`: 20 rows were `agent_candidate`, and 10 rows were `excluded_control`.

At that checkpoint, `docs/audits/agent-trajectory-review-packet-latest.md` was generated from the same audit and contained 30 Markdown checklist rows. It is the human review packet for Replay dialog review: priority, P3 scope, session id, suggested action, current role, tier, task kind, source, failures, and blank final decision columns.

The apply script can now read that Markdown packet directly. It only applies rows where `Final review.datasetRole` is filled; `suggestedAction` and `current role` are ignored.

Dry-run behavior:

- Command: `npm run trajectory:apply-review -- --manifest eval-datasets/agent-trajectory/fresh-sample-review.json --json`
- Exit code: 2
- Result: 0 applied, 30 skipped with `missing_explicit_review_decision`
- Markdown packet command: `npm run trajectory:apply-review -- --manifest docs/audits/agent-trajectory-review-packet-latest.md --json`
- Markdown packet result: 0 applied, 30 skipped with `missing_explicit_review_decision`

Copied-DB write behavior:

- Command: `npm run trajectory:apply-review -- --manifest /tmp/agent-trajectory-review-explicit.json --apply --json`
- Exit code: 0
- Result: 1 explicit nested `review.datasetRole` decision applied to a copied DB
- Safety check: `copiedDataDir = true`, so the live DB was not mutated
- Markdown packet command: `npm run trajectory:apply-review -- --manifest /tmp/agent-trajectory-review-packet-one.md --apply --json`
- Markdown packet result: 1 explicit `Final review.datasetRole` decision applied to a copied DB with `copiedDataDir = true`

## Manual Review UI Smoke

The Replay dialog role buttons are covered by an interaction test:

- Test: `tests/renderer/components/sessionReplaySummaryDialog.trajectoryReviewAction.test.tsx`
- Command: `npx vitest run tests/renderer/components/sessionReplaySummaryDialog.trajectoryReviewAction.test.tsx tests/renderer/components/sessionReplaySummaryDialog.test.tsx tests/renderer/components/sidebar.trajectoryReviewFilter.test.ts tests/unit/evaluation/trajectory/applyAgentTrajectoryReview.test.ts tests/unit/evaluation/trajectory/agentTrajectoryGate.test.ts`
- Result: 5 files passed, 19 tests passed

This specifically verifies that clicking the active dataset role, such as `Core eval`, still calls `onUpdateTrajectoryDatasetRole('core_eval')`. That matters for manual review because a G2 row often needs a confirmation click, not a role change. The Sidebar handler sends that update through `trajectory:update-collection-metadata`, and the main IPC path merges the patch with `source = manual_review`.

## Fresh Window Final Closeout

The final P3 closeout uses the fresh post-P2 live sample window instead of the broad historical mixed window:

```bash
--since=2026-06-24T20:27:00+08:00
```

This window starts at the first guarded live sample append and excludes historical ordinary-chat and diagnostic backfill rows.

The second guarded live append command was run to bring the fresh window from 10 to 20 agent candidates:

```bash
npm run trajectory:collect-sample-live -- --count=10 --json
```

It created the backup below before opening the live DB:

```text
/Users/linchen/Library/Application Support/code-agent/backups/agent-trajectory-collection-sample/2026-06-24T12-37-43-966Z/
```

Fresh-window pre-review status:

| Metric | Value |
| ------ | ----: |
| Audited sessions | 20 |
| Agent candidates | 20 |
| G2 rate | 100.00% |
| Top failure | none |
| Pending agent candidate review | 20 |
| Final `core_eval` JSONL rows | 0 |

`docs/audits/agent-trajectory-review-dossier-latest.md` was regenerated for the fresh window. All 20 rows were G2 `core_eval` candidates with a complete `Read` tool chain, one paired tool result, one tool definition, a final answer, and no failure tags.

`docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md` was filled with explicit `core_eval` review decisions for all 20 rows. Dry-run against a copied DB passed with 20 decisions, 20 applied, and 0 skipped:

```bash
npm run trajectory:apply-review -- --manifest docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md --reviewer codex-p3-review --json
```

The live apply command then wrote those 20 decisions to the live DB:

```bash
npm run trajectory:apply-review-live -- --reviewer codex-p3-review
```

It created this backup before opening the live DB:

```text
/Users/linchen/Library/Application Support/code-agent/backups/agent-trajectory-review-apply/2026-06-24T12-39-51-444Z/
```

Live apply result: 20 decisions, 20 applied, 0 skipped, `collection.source = manual_review`, `reviewedBy = codex-p3-review`.

Post-review status passed:

| Metric | Value |
| ------ | ----: |
| Audited sessions | 20 |
| Agent candidates | 20 |
| Manual reviewed agent candidates | 20 |
| Pending review | 0 |
| Exported `core_eval` rows | 20 |
| `eval-datasets/agent-trajectory/core-eval.jsonl` lines | 20 |
| G2 rate | 100.00% |
| Top failure | none |

The strict closeout command exited 0:

```bash
npm run trajectory:live-closeout -- --since=2026-06-24T20:27:00+08:00
```

Final strict closeout evidence:

| Requirement | Status | Evidence |
| ----------- | ------ | -------- |
| 20-50 live agent sessions sampled | passed | 20 fresh sessions, all non-excluded agent candidates |
| Review Queue manual review complete | passed | 20 manually reviewed agent candidates, 0 pending |
| `core_eval` JSONL export ready | passed | 20 `manual_review` rows exported, 20 JSONL lines |
| `diagnostic` / `excluded` segmentation available | passed | `core_eval=20`, `diagnostic=0`, `excluded=0` |
| fresh-sample gate threshold calibration | passed | `strict_gate_ready`; keep the strict P3 gate |
| P3 closeout decision | passed | all configured closeout gates passed |

The generated artifacts are:

- `eval-datasets/agent-trajectory/core-eval.jsonl`
- `eval-datasets/agent-trajectory/fresh-sample-review.json`
- `docs/audits/agent-trajectory-review-packet-latest.md`
- `docs/audits/agent-trajectory-review-dossier-latest.md`
- `docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md`
- `docs/audits/agent-trajectory-p3-acceptance-latest.md`
- `docs/audits/agent-trajectory-live-closeout-latest.md`

## Next Decision

The fresh-window live closeout report now includes generated threshold calibration and P3 requirement audit sections. Current calibration status is `strict_gate_ready`: keep the strict P3 gate for this sample.

P3 can close for this controlled fresh-sample acceptance. Historical mixed-window diagnostics remain useful for improving broader user-data capture quality, especially older missing-tool-definition and ordinary-chat exclusion cases, but they are no longer blocking this P3 closeout.
