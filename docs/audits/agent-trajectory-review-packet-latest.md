# Agent Trajectory Review Packet

Generated at: 2026-06-24T13:02:07.691Z

## Scope

- Source data dir: `/Users/linchen/Library/Application Support/code-agent`
- Copied DB dry-run: yes
- Sample window: `{"since":1782304020000}`
- Review manifest: `eval-datasets/agent-trajectory/fresh-sample-review.json`
- Audited sessions: 20
- Exported core_eval rows: 20
- Manual reviewed: 20
- Manual reviewed agent candidates: 20
- Pending review: 0
- Pending agent candidate review: 0
- P3 agent candidate rows: 20
- Excluded control rows: 0
- Gate status: passed
- Gate failures: none

## Review Instructions

Use Sidebar `待审 -> Review Queue Trajectory -> 待复核` or search each session id, open the Replay dialog, then confirm or change the dataset role. A confirmed row should persist with `collection.source = manual_review`.

For offline batch review, copy the final decision into `fresh-sample-review.json` under `review.datasetRole`. The apply script ignores `suggestedAction`, so this packet is guidance only.

## Review Items

| # | Priority | P3 scope | Session | Suggested action | Current role | Tier | Task | Source | Failures | Final review.datasetRole | Notes |
| -: | -------- | -------- | ------- | ---------------- | ------------ | ---- | ---- | ------ | -------- | ------------------------ | ----- |
| 1 | medium | agent_candidate | test-1782304675747 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 2 | medium | agent_candidate | test-1782304675064 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 3 | medium | agent_candidate | test-1782304674346 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 4 | medium | agent_candidate | test-1782304673593 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 5 | medium | agent_candidate | test-1782304672913 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 6 | medium | agent_candidate | test-1782304672207 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 7 | medium | agent_candidate | test-1782304671494 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 8 | medium | agent_candidate | test-1782304670815 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 9 | medium | agent_candidate | test-1782304670043 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 10 | medium | agent_candidate | test-1782304669143 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 11 | medium | agent_candidate | test-1782304045382 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 12 | medium | agent_candidate | test-1782304044613 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 13 | medium | agent_candidate | test-1782304043601 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 14 | medium | agent_candidate | test-1782304042797 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 15 | medium | agent_candidate | test-1782304042026 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 16 | medium | agent_candidate | test-1782304041204 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 17 | medium | agent_candidate | test-1782304040429 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 18 | medium | agent_candidate | test-1782304039450 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 19 | medium | agent_candidate | test-1782304038668 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
| 20 | medium | agent_candidate | test-1782304037598 | verify_core_eval | core_eval | G2 | coding | manual_review | none |  |  |
