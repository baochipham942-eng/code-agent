# Agent Trajectory Data Ops

This guide covers the post-P2 operating loop for collecting and reviewing agent trajectory data.

## Goal

Build a stable `core_eval` dataset from fresh, complete agent sessions while keeping historical or incomplete sessions available for diagnosis.

## Fresh Sample Run

Use a time window that starts after the P2 collection metadata changes are available in the running app.

```bash
npm run trajectory:fresh-sample -- --since=2026-06-24T00:00:00+08:00
```

For a controlled end-to-end smoke that generates 20 fresh real AgentLoop sessions in a temporary DB and runs the strict gate:

```bash
npm run acceptance:agent-trajectory-fresh-sample -- --json
```

This acceptance smoke writes its JSONL and review manifest inside a temporary data directory, applies explicit controlled review decisions through the same batch review apply path, then reruns the closeout checks against that reviewed temp DB. It deletes the temp directory by default. Use `--keep-tmp` when the files need manual inspection.

For a controlled collection batch that creates real AgentLoop sessions but leaves review decisions blank:

```bash
npm run trajectory:collect-sample -- --count=20 --json
```

This keeps its generated data directory by default and prints `dataDir`, `reviewManifestPath`, `draftCoreEvalPath`, and `sessionIds`. It persists `agentTrajectoryCollection` metadata as machine-generated collection output, not `manual_review`, so the rows still need Replay review before they can contribute to the final `core-eval.jsonl`. Use `--data-dir=<path>` and `--workspace-dir=<path>` only when intentionally collecting into a known data directory; the default temp directory is safer for rehearsal.

When the collection batch must append controlled AgentLoop sessions to the live data directory, use the explicit live command:

```bash
npm run trajectory:collect-sample-live -- --count=10 --json
```

This command writes to `~/Library/Application Support/code-agent`, requires `--backup-live-db`, and creates a DB backup before opening the live DB. It keeps `workspace`, `test-cases`, and `test-results` in a temporary scratch directory, and writes draft sample artifacts to `eval-datasets/agent-trajectory/live-collection-sample-latest` by default. The collected rows are still machine-generated `audit_backfill` rows; they reduce the agent-candidate sample gap but do not satisfy manual review or final JSONL export until Replay review persists explicit `manual_review` decisions.

The operational fresh-sample command writes the repo-local artifacts:

- `eval-datasets/agent-trajectory/core-eval.jsonl`
- `eval-datasets/agent-trajectory/fresh-sample-review.json`
- `docs/audits/agent-trajectory-review-packet-latest.md`

`fresh-sample-review.json` is the trajectory review queue for this loop. The legacy Eval Center Review Queue UI is not required. Use the session ids in `reviewItems` to open the session Replay dialog and adjust the dataset role there.

`agent-trajectory-review-packet-latest.md` is the human-readable checklist for the same rows. Use it during manual review; write final decisions back into the JSON manifest or save them through the Replay dialog.

The packet and JSON manifest include `reviewScope` / `P3 scope`:

- `agent_candidate`: `core_eval` or `diagnostic` rows that count toward the P3 agent-session sample and must be reviewed first.
- `excluded_control`: ordinary chat, transcript fallback, replay-only, or other excluded rows that stay useful for segmentation checks but do not count toward the 20-session agent sample.

In the app, admins can use the Sidebar status filter: `待审 -> Review Queue Trajectory -> 待复核`. That filter shows sampled sessions whose trajectory collection has not been saved as `manual_review` yet.

The default fresh-sample gate is intentionally stricter than historical backfill:

- at least 20 audited sessions
- `G2` rate at least `0.70`
- top failure rate at most `0.20`

If the sample is still small, run the same command with a lower smoke gate:

```bash
npm run trajectory:audit -- --since=2026-06-24T00:00:00+08:00 --limit 50 --json --min-sessions=1 --min-g2-rate=0 --max-top-failure-rate=1 --review-manifest-out eval-datasets/agent-trajectory/fresh-sample-review.json
```

## Live Closeout Gate

After the review pass is done, run the closeout gate:

```bash
npm run trajectory:live-closeout -- --since=<p2-rollout-time>
```

This command still copies the live DB by default. It writes:

- `eval-datasets/agent-trajectory/core-eval.jsonl`
- `eval-datasets/agent-trajectory/fresh-sample-review.json`
- `docs/audits/agent-trajectory-review-packet-latest.md`
- `docs/audits/agent-trajectory-live-closeout-latest.md`

The formal closeout path exports only `collection.source = manual_review` rows to `core-eval.jsonl`. Earlier audit and seed commands may identify draft `core_eval` candidates, but those candidates are not final export rows until Replay review has persisted a manual decision.

The closeout gate is stricter than the first fresh-sample audit:

- at least 20 audited sessions
- at least 20 non-excluded `core_eval + diagnostic` agent candidates
- at least 20 exported `core_eval` rows from `collection.source = manual_review`
- at least 20 sessions with `collection.source = manual_review`
- at least 20 non-excluded agent candidates with `collection.source = manual_review`
- zero pending review rows
- `G2` rate at least `0.70`
- top failure rate at most `0.20`
- diagnostic rate at most `0.30`
- excluded rate at most `0.05`

If this fails, use `docs/audits/agent-trajectory-live-closeout-latest.md` as the next action list. If the failure is `agent_candidate_count_below_20`, collect more real agent-task sessions. If the failure is `manual_reviewed_agent_candidate_count_below_20`, finish Replay review for the non-excluded agent candidates first. If the failure is a quality bucket such as `missing_tool_schemas`, fix collection before tuning thresholds.

The same report also includes `P3 Requirement Audit`. Read that table before closing the goal: the 20-session target counts non-excluded `core_eval + diagnostic` agent candidates, so ordinary chat or other `excluded` rows do not satisfy the agent-session sample requirement.

The report also includes `P3 Action Plan`, which turns the failed closeout into the next executable queue. Work it from the lowest priority number first:

- `collect_agent_candidates`: collect enough non-excluded real agent-task sessions.
- `review_agent_candidates`: finish manual Replay review for agent candidates before spending time on excluded control rows.
- `promote_core_eval_rows`: promote only reviewed G2 rows into stable JSONL export.
- `fix_top_collection_blocker`: fix the dominant capture failure, such as missing tool schemas, before tuning thresholds.

Use `P3 Review Worklist` in the same report when doing manual review. It filters out rows already saved as `manual_review`, puts `agent_candidate` rows before `excluded_control`, and names the next session id to open in Replay.

## Seed Review Queue Metadata

When the copied-DB closeout has produced the right worklist and you are ready to review live rows in the product UI, seed the missing collection metadata into the live DB:

```bash
npm run trajectory:seed-review-queue -- --since=<p2-rollout-time>
```

This command runs the same strict closeout thresholds, writes the same review manifest, review packet, JSONL, and closeout report, then exits zero even while the gate is still failing. The JSON output and report keep `ok: false` and the full gate failures, so this is an operational queue-prep step, not a P3 closeout pass.

Before opening the live DB, the command also backs up `code-agent.db`, `code-agent.db-wal`, and `code-agent.db-shm` when those files exist. The default backup path is under `~/Library/Application Support/code-agent/backups/agent-trajectory-live-seed/<timestamp>/`; override it with `--live-db-backup-dir=<path>` if the backup should go elsewhere.

The live write is intentionally narrow:

- uses `--live-data-dir` and `--persist-collection-metadata`
- uses `--backup-live-db`
- writes only missing `agentTrajectoryCollection` metadata
- records these rows as `collection.source = audit_backfill`
- does not overwrite existing metadata
- does not write `collection.source = manual_review`
- does not apply any suggested dataset role as a human decision

After this seed step, use Sidebar `待审 -> Review Queue Trajectory -> 待复核` to open the generated agent-candidate rows and save the actual manual review decisions.

Before and after each review pass, check the live queue status:

```bash
npm run trajectory:review-status -- --since=<p2-rollout-time>
```

This is a read-only command. It does not write JSONL, does not rewrite the review packet, and does not persist collection metadata. A nonzero exit means the P3 strict gate is still failing; read `Next review session`, `Pending agent candidates`, and `Failures` as the current work queue.

To decide whether the current P3 window needs new collection or only historical diagnostics, compare it with all audited live sessions:

```bash
npm run trajectory:sample-gap -- --since=<p2-rollout-time>
```

This is also read-only. It keeps the strict P3 gate thresholds, returns exit code 0 for daily inspection, and prints `All-window agent candidates`, `Additional historical agent candidates outside current window`, and `Fresh-window collection gap`. Treat historical backfill as diagnostic context unless the P3 window itself reaches the target count.

To create a smaller worksheet for just the pending agent candidates:

```bash
npm run trajectory:review-worksheet -- --since=<p2-rollout-time>
```

This writes `docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md`. It keeps final review fields blank and is safe to regenerate before review. Fill only after opening the session in Replay.

To create a read-only evidence dossier for the same pending agent candidates:

```bash
npm run trajectory:review-dossier -- --since=<p2-rollout-time>
```

This writes `docs/audits/agent-trajectory-review-dossier-latest.md`. It pulls the replay evidence needed for review, including first user prompt, final answer preview, tool chain, models, tool definitions, failure tags, and quality metrics. It does not write JSONL, does not persist collection metadata, and does not apply review decisions. Use `--include-excluded-controls` only when the excluded control rows also need evidence inspection.

Dry-run the filled worksheet before applying it:

```bash
npm run trajectory:apply-review -- --manifest docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md --reviewer human-reviewer
```

Apply only after the dry-run reports the expected decisions:

```bash
npm run trajectory:apply-review-live -- --reviewer human-reviewer
```

The live apply command uses `--backup-live-db` and writes a backup under `~/Library/Application Support/code-agent/backups/agent-trajectory-review-apply/<timestamp>/` before opening the live DB. Use `--live-db-backup-dir=<path>` when the backup should go somewhere else.

After each live review pass, run the post-review check:

```bash
npm run trajectory:post-review-check -- --since=<p2-rollout-time>
```

This reads the live DB directly, uses the formal `manual_review` export source, regenerates the closeout report, review manifest, review packet, and `core-eval.jsonl`, and returns exit code 0 even while the strict gate is still failing. Use it as the daily review progress check; use `trajectory:live-closeout` for the final strict pass/fail signal.

To produce the requirement-by-requirement P3 acceptance snapshot:

```bash
npm run trajectory:p3-acceptance -- --since=<p2-rollout-time>
```

This writes `docs/audits/agent-trajectory-p3-acceptance-latest.md` and exits nonzero until P3 is actually ready to close. It is read-only: it checks the live window, current manual-review counts, `core-eval.jsonl` line count, segmentation, gate readiness, worksheet, and dossier artifacts, but it does not write collection metadata, review decisions, or JSONL rows.

## Review Loop

1. Collect 20-50 real Coding, Search, Data Analysis, or other agent-task sessions.
2. Run the fresh sample audit.
3. Review all `agent_candidate` rows first using Sidebar `待审 -> Review Queue Trajectory -> 待复核`, the `P3 Review Worklist`, or the `reviewItems` session ids.
4. Save the review decision for every agent candidate so `collection.source` becomes `manual_review`.
5. Promote only failure-free or manually verified sessions to `core_eval`.
6. Keep incomplete but useful rows as `diagnostic`.
7. Keep ordinary chat, transcript fallback, translation-only, embedding-only, and replay-only rows as `excluded`.
8. Run `trajectory:post-review-check` after each review pass to verify live `manual_review` counts and final JSONL rows.
9. Run `trajectory:p3-acceptance` to verify the requirement matrix.
10. Run the live closeout gate and export the stable `core_eval` JSONL.

For an offline batch review, edit `fresh-sample-review.json` and add an explicit review decision to each reviewed item:

```json
{
  "sessionId": "session_...",
  "review": {
    "datasetRole": "core_eval",
    "reviewedBy": "human-reviewer",
    "notes": "Verified in Replay dialog"
  }
}
```

Then dry-run the manifest apply:

```bash
npm run trajectory:apply-review
```

Only after the dry-run output is clean, write the reviewed metadata to the live DB:

```bash
npm run trajectory:apply-review -- --apply --live-data-dir
```

The apply script intentionally ignores `suggestedAction`. It only writes rows with an explicit nested `review.datasetRole` or legacy top-level `reviewedDatasetRole`, so suggested machine labels cannot be mistaken for human review.

You can also fill the Markdown review packet directly. Put the final role in `Final review.datasetRole`, leave undecided rows blank, and dry-run it as the manifest:

```bash
npm run trajectory:apply-review -- --manifest docs/audits/agent-trajectory-review-packet-latest.md --reviewer human-reviewer
```

The Markdown parser only reads the `Final review.datasetRole` and `Notes` columns. `Suggested action`, `Current role`, and `Source` remain guidance and are never applied as review decisions.

## Review Decision Rules

`reviewItems` uses three suggested actions:

- `verify_core_eval`: skim the G2 row and keep it as `core_eval` unless the task is outside the eval scope.
- `review_diagnostic`: inspect the missing fields, then either keep as `diagnostic`, promote after manual verification, or exclude.
- `confirm_excluded`: confirm that the row is ordinary chat, transcript fallback, or otherwise outside agent-task scope.

Promote to `core_eval` only when:

- the unit is a complete session
- the task is a real agent task
- the chain has User, model decision, tool call, tool result, and final answer
- tool calls have id, name, args, tool schema, and paired result
- model decisions include provider/model provenance
- the session is not ordinary chat or transcript fallback

Keep as `diagnostic` when:

- the trajectory is useful for debugging capture gaps
- the session has agent behavior but misses tool definitions, schemas, results, or final answer
- the row can explain a regression but should not train or score core eval

Set to `excluded` when:

- there are no tool calls
- it is ordinary chat
- replay fell back to transcript-only data
- it is translation, embedding, replay-only, or otherwise outside agent-task scope

## Threshold Tuning

Historical backfill can use a loose monitor:

```bash
npm run trajectory:audit -- --limit 50 --json --min-g2-rate=0.15 --max-top-failure-rate=0.60
```

Fresh P2-instrumented collection should use the strict gate:

```bash
npm run trajectory:fresh-sample -- --since=<p2-rollout-time>
```

Final P3 closeout should use:

```bash
npm run trajectory:live-closeout -- --since=<p2-rollout-time>
```

If the strict gate fails after at least 20 sessions, treat the highest failure bucket as the next capture fix. Do not tune the gate down until the failure bucket is understood and the manual review count is complete.

The closeout report includes a `Threshold Calibration` section. Use its status as the tuning decision: `collect_more_sessions` means the non-excluded agent sample is still too small, `manual_review_required` means finish Replay review first, `collection_quality_required` means fix the top capture bucket first, and `strict_gate_ready` means the current thresholds can stay in force for that sample.

## Acceptance

The P3 data loop is ready when:

- `fresh-sample-review.json` lists sampled sessions by dataset role and has actionable `reviewItems`
- every sampled session has been saved through Replay dialog review and reports `collection.source = manual_review`
- `core-eval.jsonl` contains at least 20 `core_eval` trajectories from `collection.source = manual_review`
- the closeout gate passes on at least 20 fresh sessions
- the top failure bucket is below 20% of the sample

The controlled acceptance smoke should pass the same mechanics in a temporary DB before trusting a live-data closeout: 20 exported `core_eval` rows, 20 applied review decisions, 20 `manual_review` rows after re-export, zero pending review rows, and zero top-failure rate.
