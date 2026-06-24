# Agent Trajectory Live Sample Closeout

Generated at: 2026-06-24T13:02:07.691Z

Status: passed

## Scope

- Source data dir: `/Users/linchen/Library/Application Support/code-agent`
- Copied DB dry-run: yes
- Sample window: `{"since":1782304020000}`
- Export collection source: manual_review
- Core eval JSONL: `eval-datasets/agent-trajectory/core-eval.jsonl`
- Review manifest: `eval-datasets/agent-trajectory/fresh-sample-review.json`
- Review packet: `docs/audits/agent-trajectory-review-packet-latest.md`
- Allow gate failure exit zero: no
- Live DB backup: not created

## Metrics

| Metric | Value |
| ------ | ----: |
| Audited sessions | 20 |
| Exported core_eval rows | 20 |
| G2 | 20 |
| G1 | 0 |
| G0 | 0 |
| G2 rate | 100.00% |
| Diagnostic rate | 0.00% |
| Excluded rate | 0.00% |
| Core eval | 20 |
| Diagnostic | 0 |
| Excluded | 0 |
| Manual reviewed | 20 |
| Manual reviewed agent candidates | 20 |
| Pending review | 0 |
| Pending agent candidate review | 0 |

## Gate

- Gate status: passed
- Gate failures: none
- Top failure: none
- Min sessions: 20
- Min agent candidates: 20
- Min exported: 20
- Min manual reviewed: 20
- Min manual reviewed agent candidates: 20
- Max pending review: 0
- Min G2 rate: 0.7
- Max top failure rate: 0.2
- Max diagnostic rate: 0.3
- Max excluded rate: 0.05

## Failure Top

none

## P3 Collection Blockers

none

## Threshold Calibration

- Status: strict_gate_ready
- Recommendation: Keep the strict P3 gate for this sample.

| Metric | Observed |
| ------ | -------: |
| Agent candidates | 20 |
| G2 rate | 100.00% |
| Top failure rate | 0.00% |
| Diagnostic rate | 0.00% |
| Excluded rate | 0.00% |
| Manual reviewed | 20 |
| Manual reviewed agent candidates | 20 |
| Pending review | 0 |
| Pending agent candidate review | 0 |

Notes:
- Observed sample satisfies the configured closeout thresholds.

## P3 Requirement Audit

| Requirement | Status | Evidence | Next action |
| ----------- | ------ | -------- | ----------- |
| 20-50 live agent sessions sampled | passed | 20 sessions audited from {"since":1782304020000}; 20 are non-excluded agent candidates. | Keep using the same --since window for this P3 closeout sample. |
| Review Queue manual review complete | passed | 20 manually reviewed agent candidates; 0 agent candidates pending. Total pending rows: 0. | No manual review gap remains for this sample. |
| core_eval JSONL export ready | passed | 20 core_eval rows exported; target is 20. | Use the exported JSONL as the first stable core_eval slice. |
| diagnostic/excluded segmentation available | passed | core_eval=20, diagnostic=0, excluded=0. | Use diagnostic/excluded rates to decide whether collection quality is improving. |
| fresh-sample gate threshold calibration | passed | strict_gate_ready: Keep the strict P3 gate for this sample. | Keep the strict P3 gate for this sample. |
| P3 closeout decision | passed | All configured closeout gates passed. | P3 can close after confirming the sample is fresh post-P2 live data. |

## P3 Action Plan

- Status: ready
- Next action: P3 closeout can be accepted after confirming this is fresh post-P2 live data.

No pending P3 actions.

## P3 Review Worklist

- Status: ready
- Next review session: none
- Pending agent candidates: 0
- Pending excluded controls: 0
- Top pending failure: none

No pending review rows.

## Closeout Rule

P3 can close only when this report passes on a fresh post-P2 live sample and the review manifest has been manually reviewed through the Replay dialog.
