# Agent Trajectory Manual Review Worksheet

Generated at: 2026-06-24T12:38:34.978Z

## Scope

- Source data dir: `/Users/linchen/Library/Application Support/code-agent`
- Sample window: `{"since":1782304020000}`
- Audited sessions: 20
- Pending agent candidates: 20
- Includes excluded controls: no

## Instructions

Open each session in Replay before filling the final role. Leave undecided rows blank.

Accepted final roles are `core_eval`, `diagnostic`, and `excluded`. The apply script reads only `Session`, `Final review.datasetRole`, `Final review.taskKind`, and `Notes`.

Dry-run before live apply:

```bash
npm run trajectory:apply-review -- --manifest docs/audits/agent-trajectory-agent-candidate-review-worksheet-latest.md --reviewer human-reviewer
```

## Review Items

| # | P3 scope | Session | Current role | Tier | Task | Source | Failures | Final review.datasetRole | Notes |
| -: | -------- | ------- | ------------ | ---- | ---- | ------ | -------- | ------------------------ | ----- |
| 1 | agent_candidate | test-1782304675747 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 2 | agent_candidate | test-1782304675064 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 3 | agent_candidate | test-1782304674346 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 4 | agent_candidate | test-1782304673593 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 5 | agent_candidate | test-1782304672913 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 6 | agent_candidate | test-1782304672207 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 7 | agent_candidate | test-1782304671494 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 8 | agent_candidate | test-1782304670815 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 9 | agent_candidate | test-1782304670043 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 10 | agent_candidate | test-1782304669143 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 11 | agent_candidate | test-1782304045382 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 12 | agent_candidate | test-1782304044613 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 13 | agent_candidate | test-1782304043601 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 14 | agent_candidate | test-1782304042797 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 15 | agent_candidate | test-1782304042026 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 16 | agent_candidate | test-1782304041204 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 17 | agent_candidate | test-1782304040429 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 18 | agent_candidate | test-1782304039450 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 19 | agent_candidate | test-1782304038668 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
| 20 | agent_candidate | test-1782304037598 | core_eval | G2 | coding | audit_backfill | none | core_eval | Verified dossier: G2, Read tool call/result paired, final answer present, no failures. |
