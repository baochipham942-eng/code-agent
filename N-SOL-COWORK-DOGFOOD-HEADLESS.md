# N-SOL-COWORK-DOGFOOD-HEADLESS verification snapshot

This is the repository snapshot for the headless real-collaboration dogfood run.
The append-only raw evidence remains at
`~/work/evidence/N-SOL-COWORK-DOGFOOD-HEADLESS.md`; non-repository artifacts
remain under `~/work/out/N-SOL-COWORK-DOGFOOD-HEADLESS/`.

## Outcome

- Four natural-Chinese office jobs ran through one isolated Neo webServer with
  OpenAI `gpt-6.1-sol` over the Responses protocol.
- Requested deliverables produced: **0/4**.
- Evidence captured: four deliverable checks, four DB/SSE tool traces, eight
  screenshots, and four two-viewport geometry records.
- Current four-job spend: **$1.9452**. Ticket total including earlier attempts:
  **$3.2463 / $35**.
- No repository product code was changed.

| Job | Requested deliverable | Result | Current-run cost |
|---|---|---:|---:|
| A | 10-page Chinese PPTX from a three-sheet workbook | No PPTX | $0.5803 |
| B | Meeting minutes and owner/action list | No minutes file | $0.3245 |
| C | Web-researched Chinese report with citations | No report file | $0.4657 |
| D | Cleaned data, pivot, chart, and conclusions | No output file | $0.5747 |

## Ranked findings

1. **NEO — output tools deadlock on active skill boundaries.** All four jobs
   reached analysis/research, but `Write`, `ExcelAutomate`, `Browser`, or `Bash`
   was converted to an unattended approval and timed out after about 60 seconds.
   The session still reported `bypassPermissions`. Mechanism:
   `src/host/tools/toolExecutor.ts:1502-1509` creates a boundary violation and
   `src/host/tools/toolPermissionClassification.ts:397-414` changes it to
   `ask`. Relevant contracts are `.agents/skills/ppt/SKILL.md:9-21` and
   `src/host/services/skills/builtinSkillsData.ts:261,558,1379`. This should be
   addressed by correcting routing/tool contracts or a headless approval
   handoff, not by weakening the permission boundary.
2. **NEO — failed file jobs persist as completed.** All four terminal records
   had `status: completed` while their summaries explicitly said the file was
   not generated. `src/host/task/TaskManager.ts:327-361` emits completion after
   the agent turn returns; `src/host/services/commandCenter/sessionCommandCenter.ts:501-506`
   persists it without checking tool failure or deliverable existence.
3. **NEO — read input is duplicated as produced output.** Job A displayed the
   input workbook four times under “产出”. The chain is
   `src/host/tools/modules/network/readXlsx.ts:301-307` →
   `src/shared/contract/artifactRoleRegistry.ts:31-43,62-71` →
   `src/host/task/TaskManager.ts:354-356` →
   `src/host/services/commandCenter/sessionCommandCenter.ts:812-833`.
4. **NEO — delegated and foreground paid requests overlap.** Top-level jobs
   were serialized, but trace timestamps show maximum provider concurrency 2
   in every job. `src/host/services/commandCenter/sessionCommandCenter.ts:210-245`
   launches the child immediately and
   `src/host/tools/modules/commandCenter/sessionCommandCenter.ts:117-150`
   returns before the parent turn is finished.
5. **MODEL — brittle A-side parser.** One model-authored aggregation command
   attempted to parse the `月份` header as a float. The model recovered; it was
   not the cause of the missing PPTX.
6. **MODEL — incomplete C-side research coverage.** WebSearch/WebFetch worked,
   but the terminal summary admitted that several current price and billing
   facts remained unverified.

## Runtime and compliance facts

- Usage came from `usage_ledger`, priced by
  `src/shared/constants/pricing.ts:123-128`.
- Runtime SSE resolved provider/model to `openai/gpt-6.1-sol`.
- `src/host/model/modelCapabilityMatrix.ts:76` selects `responses`; the OpenAI
  base in `src/shared/constants/providers.ts:18` plus
  `src/host/model/providers/responsesProvider.ts:19-21` resolves to
  `https://api.openai.com/v1/responses`.
- Only the owner-specified dogfood key was injected as `OPENAI_API_KEY`; other
  provider/search keys were removed from the child environment. No key value
  was printed.
- No request intersected 08:00–10:30 Beijing time. No HTTP 429 was observed.
- Strict provider-level seriality failed: maximum in-flight count was **2**.
- Geometry found no horizontal page overflow, right-edge escape, or measured
  tool-row/deliverable-card overlap at 1440×900 or 390×844.

## Evidence index

- Input manifest: `~/work/out/N-SOL-COWORK-DOGFOOD-HEADLESS/input-manifest.json`
- Per-job checks/traces/costs: `job-r3-{a,b,c,d}/`
- Screenshots and geometry: `shots/r3-{A,B,C,D}-*`
- Terminal task records: `r3-terminal-tasks.json`
- Permission decisions: `r3-permission-decisions.json`
- Provider concurrency: `r3-concurrency.json`
- Protocol proof: `protocol-proof.json`

Reverse mutation is not applicable because no product code changed. No code
gates were run; the preparatory web and renderer builds passed. Evidence class:
`real-runtime + static-contract`.
