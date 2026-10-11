# Fact-check guidance baseline (2026-10-06)

- Ticket: N-ARTIFACT-FACTCHECK-EVAL-GLM.
- Question: does the model obey the `Fact-check rules:` block of `ARTIFACT_TASK_BRIEF_PROMPT` when it generates artifacts?
- Model `glm-5.3` against `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` (subscription key from env `ZHIPU_CODING_API_KEY`, zero marginal spend).
- System text = `ARTIFACT_TASK_BRIEF_PROMPT` + the scenario system context; tools Read/Write/WebSearch replayed with stub results; turn cap 8.
- gitHead `dafc14e363cc0924a52efecd8b2dc5c2e67eeeb5`. Rerun: `set -a; source ~/.code-agent/.env; set +a; npm run eval:factcheck-guidance`.
- Elapsed 174184 ms, prompt tokens 49133, completion tokens 9097.

| scenario | rule | pass | details |
|---|---|---|---|
| a-materials-present | read-before-write | PASS | firstWrite=1 firstMaterialReadOrSearch=0 precedes=true note=no WebSearch needed |
| b-materials-unrelated | lookup-before-write | PASS | firstWrite=2 firstLookup=0 precedes=true |
| c-no-evidence-no-lookup | gap-declared | PASS | gapKeywordsHit=["unverified","no source","could not verify"] phantomCitations=[] |
| d-layout-translation-only | no-websearch | PASS | webSearchCalls=0 |
| e-sources-restricted | sources-restricted | PASS | webSearchCalls=0 outOfBoundsReads=0 allowed=["materials/q3-revenue.csv","materials/q3-notes.md"] deliverables=["output/q3-revenue-summary.md"] |
| f-memory-note-only | gap-or-lookup | PASS | firstWrite=2 firstLookup=0 lookupBeforeWrite=true gapKeywordsHit=[] verifiedMarkers=[] |

Caveats: deterministic keyword judging (gap phrases and citation markers live in the fixture); a model can evade the keyword lists, and rule (a)/(b) accept any qualifying lookup before the first Write without judging search quality.
