# N-SOL-GAME-AB — pre-registered decision rule

Written and committed BEFORE the first unit of the paired run (see the git commit
timestamp of this file; no run, dry-run model call, or canary unit precedes it).
This rule is frozen: it must not be edited after any unit has run. If the data
forces a caveat, the caveat goes in the evidence file, not here.

## Arms

- **glm** (baseline): provider `zhipu_coding`, model `glm-5.3`, key
  `ZHIPU_CODING_API_KEY` (GLM Coding Plan, subscription, free), endpoint
  `https://open.bigmodel.cn/api/coding/paas/v4` (OpenAI-compatible).
- **sol** (challenger): provider `openai`, model `gpt-6.1-sol`, key
  `OPENAI_DOGFOOD_API_KEY` injected as `OPENAI_API_KEY` (responses protocol per
  `src/host/model/modelCapabilityMatrix.ts`).

Same worktree (one checkout of current origin/main), same cases file (9 cases,
3 subtypes × held-in/held-out), 2 reps per arm per case = 36 units, ABAB
time-interleaved per (case, rep) with alternating arm order, strictly serial.

## Operational definitions (fixed before the run)

- **Unit** = one `runner.ts` invocation: `--ids <caseId> --rep <N>` under one
  arm. A unit is **finished** iff its per-unit `runs.jsonl` exists with ≥1 line.
- **Pass rate (arm)** = (# finished units with `passedFull === true`) / (# finished
  units of that arm). Units that error or time out count in the denominator and
  as not-passed; they are additionally reported in their own buckets (error /
  timeout histograms) so the verdict can be read either way.
- **Occurrence of a failure code (arm)** = number of finished units of that arm
  whose `codes` array contains the code (distinct-unit count, matching the
  runner summary's `failureCodeHistogram[code].distinctRuns` semantics).
- If the run halts early (spend cap, 3 consecutive 429s, stop-error), the rule
  applies to the finished units of both arms and the evidence file lists exactly
  which units are missing per arm. With fewer than 9 finished units per arm the
  verdict is prefixed "low-n:" and treated as provisional in the recommendation,
  but the rule itself is applied unchanged.

## Verdict rule (verbatim from the task brief, frozen)

- **model bottleneck** = (Sol pass-rate − GLM pass-rate) ≥ 0.30 AND every
  failure code with ≥3 GLM occurrences appears ≤1 time in Sol.
- **harness/contract/validator problem** = some failure code with ≥3 GLM
  occurrences also appears ≥3 times in Sol (e.g. breakout contract collapse,
  `malformed_test_contract`, `missing_controls`).
- **otherwise mixed** — attribute code by code: codes that clear Sol
  (≥3 GLM occurrences → ≤1 Sol occurrence) point at the model; codes that
  persist in Sol (≥3 in both) point at the harness/contract/validator side and
  are traced to file:line root causes with reproducibility judgments
  (FEEDBACK CANDIDATES).

Both headline conditions can be true at once only if the data is contradictory
(pass-rate gap ≥0.30 while a ≥3/≥3 code exists); in that case the verdict is
"mixed" and the conflicting code is named. The recommended next step follows
the verdict: switch model (model bottleneck), fix the named harness parts
(harness problem), or both in the code-by-code split (mixed).

## Spend & safety guards (operational, fixed before the run)

- Sol spend hard cap **USD 25**. Per-unit cost = `inputTokens/1e6 × $2 +
  outputTokens/1e6 × $10` (upper bound: full input price, no cache-read
  discount, from `MODEL_PRICING_PER_1M['gpt-6.1-sol']`; the runner's
  `tokenUsage.estimatedCost` is always 0 because the telemetry collector never
  updates it). Checkpoint logged after every 6 finished units (any arm) and
  after every Sol unit; stop immediately above the cap.
- At most **1 Sol request in flight** at any time (strictly serial queue;
  orchestrator refuses to spawn a second Sol unit while one is in flight).
- **No Sol units 08:00–10:30 Beijing time**; if the queue reaches a Sol unit
  inside the window, sleep until 10:30 Beijing.
- **HTTP 429**: back off ≥3 minutes, then retry the unit; after 3 consecutive
  429s stop and record the time.
- Never print key values in logs (keys are loaded from `~/.code-agent/.env`
  at spawn time and passed through child env only).
