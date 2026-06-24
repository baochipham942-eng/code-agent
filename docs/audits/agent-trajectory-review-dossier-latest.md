# Agent Trajectory Review Dossier

Generated at: 2026-06-24T12:38:34.975Z

## Scope

- Source data dir: `/Users/linchen/Library/Application Support/code-agent`
- Runtime data dir: `/Users/linchen/Library/Application Support/code-agent`
- Live DB read: yes
- Sample window: `{"since":1782304020000}`
- Audited sessions: 20
- Included review rows: 20
- Pending agent candidates: 20
- Pending excluded controls: 0
- Manual-reviewed rows currently in window: 0
- Formal manual_review export rows currently in window: 0
- G2 rate: 100.00%
- Top failure: none

This dossier is read-only. It does not write collection metadata, does not apply review decisions, and does not replace opening Replay before saving a final role.

## Summary

| # | P3 scope | Session | Current role | Tier | Task | Source | Failures | Tool chain | Final answer preview | Notes |
| -: | -------- | ------- | ------------ | ---- | ---- | ------ | -------- | ---------- | -------------------- | ----- |
| 1 | agent_candidate | test-1782304675747 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 2 | agent_candidate | test-1782304675064 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 3 | agent_candidate | test-1782304674346 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 4 | agent_candidate | test-1782304673593 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 5 | agent_candidate | test-1782304672913 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 6 | agent_candidate | test-1782304672207 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 7 | agent_candidate | test-1782304671494 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 8 | agent_candidate | test-1782304670815 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 9 | agent_candidate | test-1782304670043 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 10 | agent_candidate | test-1782304669143 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 11 | agent_candidate | test-1782304045382 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 12 | agent_candidate | test-1782304044613 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 13 | agent_candidate | test-1782304043601 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 14 | agent_candidate | test-1782304042797 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 15 | agent_candidate | test-1782304042026 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 16 | agent_candidate | test-1782304041204 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 17 | agent_candidate | test-1782304040429 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 18 | agent_candidate | test-1782304039450 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 19 | agent_candidate | test-1782304038668 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |
| 20 | agent_candidate | test-1782304037598 | core_eval | G2 | coding | audit_backfill | none | Read:Read | E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result. | none |

## Session Evidence

## 1. test-1782304675747

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:55.957Z
- Data source: telemetry
- Trace id: session:test-1782304675747
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=238, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #10.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:
## 2. test-1782304675064

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:55.280Z
- Data source: telemetry
- Trace id: session:test-1782304675064
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=234, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #9.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 3. test-1782304674346

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:54.590Z
- Data source: telemetry
- Trace id: session:test-1782304674346
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=246, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #8.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 4. test-1782304673593

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:53.815Z
- Data source: telemetry
- Trace id: session:test-1782304673593
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=274, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #7.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 5. test-1782304672913

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:53.125Z
- Data source: telemetry
- Trace id: session:test-1782304672913
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=236, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #6.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 6. test-1782304672207

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:52.438Z
- Data source: telemetry
- Trace id: session:test-1782304672207
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=246, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #5.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 7. test-1782304671494

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:51.708Z
- Data source: telemetry
- Trace id: session:test-1782304671494
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=232, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #4.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 8. test-1782304670815

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:51.026Z
- Data source: telemetry
- Trace id: session:test-1782304670815
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=237, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #3.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 9. test-1782304670043

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:50.287Z
- Data source: telemetry
- Trace id: session:test-1782304670043
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=278, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #2.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 10. test-1782304669143

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:37:49.433Z
- Data source: telemetry
- Trace id: session:test-1782304669143
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=337, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-69iOEC/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #1.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 11. test-1782304045382

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:25.632Z
- Data source: telemetry
- Trace id: session:test-1782304045382
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=243, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #10.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 12. test-1782304044613

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:24.836Z
- Data source: telemetry
- Trace id: session:test-1782304044613
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=292, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #9.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 13. test-1782304043601

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:23.900Z
- Data source: telemetry
- Trace id: session:test-1782304043601
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=446, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #8.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 14. test-1782304042797

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:23.047Z
- Data source: telemetry
- Trace id: session:test-1782304042797
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=266, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #7.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 15. test-1782304042026

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:22.262Z
- Data source: telemetry
- Trace id: session:test-1782304042026
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=278, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #6.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 16. test-1782304041204

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:21.441Z
- Data source: telemetry
- Trace id: session:test-1782304041204
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=314, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #5.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 17. test-1782304040429

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:20.689Z
- Data source: telemetry
- Trace id: session:test-1782304040429
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=279, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #4.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 18. test-1782304039450

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:19.786Z
- Data source: telemetry
- Trace id: session:test-1782304039450
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=317, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #3.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 19. test-1782304038668

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:18.916Z
- Data source: telemetry
- Trace id: session:test-1782304038668
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=276, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #2.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:

## 20. test-1782304037598

- P3 scope: agent_candidate
- Current classification: core_eval / G2 / coding
- Collection source: audit_backfill, intent: new_core_eval_candidate, version: agent-trajectory-v1
- Started at: 2026-06-24T12:27:17.974Z
- Data source: telemetry
- Trace id: session:test-1782304037598
- Metrics: turns=2, model_calls=2, tool_calls=1, tool_results=1, tool_definitions=1, final_answer=yes, pending_tool_results=0
- Failures: none
- Replay summary: turns=2, data_source=telemetry
- Trajectory summary: duration_ms=340, events=17
- Models: acceptance/e2e-local-agent-model x2
- Tool definitions: Read
- Tool chain: Read:Read
- Failed tools: none
- First user prompt: Use the Read tool to inspect /var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/agent-trajectory-collection-run-mzknhF/workspace/collection-sample-target.txt, then report the marker exactly. Collection sample #1.
- Final answer preview: E2E real agent replay eval smoke completed. E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE observed through a real Read tool result.

Review fields:

- Final review.datasetRole:
- Final review.taskKind:
- Notes:
