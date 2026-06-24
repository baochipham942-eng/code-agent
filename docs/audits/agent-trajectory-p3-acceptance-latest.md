# Agent Trajectory P3 Acceptance Snapshot

Generated at: 2026-06-24T12:40:10.413Z

## Scope

- Source data dir: `/Users/linchen/Library/Application Support/code-agent`
- Runtime data dir: `/Users/linchen/Library/Application Support/code-agent`
- Live DB read: yes
- Sample window: `{"since":1782304020000}`
- Next review session: `none`
- Pending agent candidates: 0

This snapshot is read-only. It is an acceptance audit for the P3 data loop and does not write collection metadata, review decisions, or JSONL rows.

## Requirement Matrix

| Requirement | Status | Evidence | Next action |
| ----------- | ------ | -------- | ----------- |
| 20-50 real agent sessions sampled | passed | 20 audited sessions, 20 non-excluded agent candidates. Current P3 window needs 0 more agent candidates. | Keep the current window and finish manual review. |
| Review Queue manual review complete | passed | 20 manual_review rows, 20 reviewed agent candidates, 0 total pending rows, 0 pending agent candidates. | Review queue is closed for this window. |
| core_eval JSONL export ready | passed | 20 formal manual_review export rows, 20 lines in core-eval JSONL. | JSONL export matches the formal reviewed rows. |
| diagnostic/excluded segmentation available | passed | core_eval=20, diagnostic=0, excluded=0. | Use segmentation to separate eval promotion from capture-quality debugging. |
| fresh-sample gate threshold calibration | passed | G2=100.00%, top_failure=none, diagnostic=0.00%, excluded=0.00%. | Keep current thresholds for this window. |
| P3 closeout decision | passed | collection_source manual_review=20, audit_backfill=0. | P3 can be closed after final strict live-closeout rerun. |

## Artifacts

| Artifact | Status | Lines | Bytes |
| -------- | ------ | ----: | ----: |
| eval-datasets/agent-trajectory/core-eval.jsonl | present | 20 | 656741 |
| docs/audits/agent-trajectory-review-dossier-latest.md | present |  | 28158 |
| docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md | present |  | 4935 |

## Pending Agent Candidates

- none

## Gate Failures

- none
