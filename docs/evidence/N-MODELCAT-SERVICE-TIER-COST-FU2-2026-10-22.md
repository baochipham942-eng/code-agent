# N-MODELCAT-SERVICE-TIER-COST-FU2 证据档（2026-10-22 · neo-worker · GLM 席）

单号 N-MODELCAT-SERVICE-TIER-COST-FU2，分支 `mq/modelcat-service-tier-cost-fu2`，基线 origin/main `1ab12397e`。
两个小提交：`0fca40822`（estimateCost 第 5 参 + budgetCacheAwareCost 用例）、`9a032ab4f`（pipeline 接线 + 新测试文件）。

## 改了什么

- `src/host/services/core/budgetService.ts:586-595` —— `estimateCost` 加可选第 5 参 `serviceTier?: string`。input+output 算式原样保留（`budgetService.ts:587-590`），倍率 `SERVICE_TIER_COST_MULTIPLIER[serviceTier ?? ''] ?? 1`（`budgetService.ts:593`）仅在 ≠1 时乘（`budgetService.ts:594`）——缺席/standard/表外档返回与改前逐位相同的浮点数。常量从 `src/shared/constants` barrel 导入（`budgetService.ts:13`），与 `pricing.ts` 同源；未走 `computeUsageCostUsd`（会引入 longContext 计价改变标准档数值）、未加 cache 计价（超范围）。
- `src/host/agent/subagentPipeline.ts:553` —— `calculateTotalCost` 把 `usage.serviceTier` 作第 5 参传给 `estimateCost`。`completeContext` 审计总额（`subagentPipeline.ts:302`）、`checkBudget` 停/警阈值（`:492-501`）、`getBudgetStatus().subagentCost`（`:527`）、`getRemainingBudget`（`:543`）经由 `calculateTotalCost` 全部生效；无其他 pipeline 逻辑改动。
- `tests/unit/services/core/budgetCacheAwareCost.test.ts:112-123` —— 新增 1 条 estimateCost 档位用例（flex=9、无档=18、表外档与无档逐位一致）。
- `tests/unit/agent/subagentPipeline.serviceTier.test.ts`（新文件，149 行）—— 真实 `BudgetService`/`getBudgetService`（不 mock；既有 `subagentPipeline.test.ts` mock 了 `getBudgetService`，看不见本缺陷），价从 `MODEL_PRICING_PER_1M` 取，覆盖任务书 3(a)-(d) 与验收 ④。

行数约束：budgetService.ts 670→675（+5，上限 ~10），subagentPipeline.ts 692→692（净 0），测试文件 149 行，均远低于 1000。

## 门（原始汇总行）

- `npm run -s typecheck` → 无输出（EXIT=0）
- `node scripts/tsc-tests-ratchet.mjs` → `[tsc-tests-ratchet] tests+scripts TypeScript errors current=0 baseline=0 delta=0` / `[tsc-tests-ratchet] ✓ 等于基线，通过（未新增）`
- `node scripts/host-chinese-error-ratchet.mjs` → `[host-chinese-error-ratchet] ✓ 等于基线，通过（未新增）`
- `node scripts/attention-budget-ratchet.mjs` → `[attention-budget-ratchet] ✓ 注入点计数、无守卫静态总量与语音固定开销均未超基线`
- `node scripts/eslint-ratchet.mjs` → `[eslint-ratchet] ✓ 未超基线，通过`
- `node scripts/knip-ratchet.mjs` → `[knip-ratchet] ✓ 未新增；有 7 个存量符号已清理，可运行 --update-baseline 从基线移除：`
- `node scripts/knip-ratchet.mjs --profile production` → `[knip-ratchet] production dead-export 扫描完成：1097 个命中文件；当前 3345 个符号，基线 3355 个符号` / `[knip-ratchet] ✓ 未新增；有 10 个存量符号已清理…`（首跑在与其它门并行时崩溃——Node OOM 尾迹 `Node.js v24.21.0`，环境性；裸跑复跑 EXIT=0）
- `node scripts/knip-production-ratchet.mjs` → `[knip-production-ratchet] ✓ 没有新增的严格生产不可达源码`
- `node scripts/knip-dependency-gate.mjs` → `[knip-dependency-gate] ✓ 依赖维度 0 处，档位 0 处错档（声明 158 包，运行时非 bundle 10 包，消费解析 158/158 包·8291 文件，knip 豁免 2 项均在册）`
- `node scripts/ci/agent-event-schema-gate.mjs` → `[agent-event-schema-gate] ✓ committed schema matches AgentEventEnvelopeSchema`（未动事件 schema，核对性跑）
- `npx vitest run tests/unit/agent tests/unit/services/core tests/unit/shared tests/unit/testing` → `Test Files  536 passed (536)` / `Tests  5488 passed (5488)`（EXIT=0）
- `npm run gates:fast -- --regressions ~/work/out/N-MODELCAT-SERVICE-TIER-COST-FU2/regressions.json` → `✓ gates:fast passed required local preflight. schema=2 head=9a032ab4f5353a08ea8b3db9634797f9c774d1e0 base=1ab12397e0c885e8d961da248aef9db2539dbf0e receipt=339c23fd-1b3e-43bb-b8c7-c9c70d17d27e`
- 模型可见请求字节零变化（纯记账路径），无需 snapshot 重录（任务书明示）。

## 逐条验收（原文引用 + 证据）

### ① "calculateTotalCost now goes through tier-aware pricing (TokenUsage already carries the tier): a flex subagent call is priced at 0.5x on input and output, and standard-tier results are bit-for-bit unchanged — paste the numbers from the new tests (flex vs standard for the same tokens) and the unchanged `budgetCacheAwareCost` case."

同一笔 usage（gpt-6.1-sol，3M in / 1M out，刊例 input $2/M、output $10/M）：

- 无档（=standard 计价）：`subagentCost` = **$16.00**；flex：**$8.00**（恰 0.5x）。3 笔累计：无档 **$48** vs flex **$24**（测试 `subagentCost prices flex usage at exactly 0.5x…`，断言 `toBe`）。
- 逐位不变：`standard` / 缺席 / `priority`（表外）三种用法 `subagentCost` 均 `toBe` 改前算式内联复算值（`16`），无浮点重排（测试 `standard / absent / unknown tier usages keep the pre-change figure bit for bit`）。
- budgetCacheAwareCost 不变用例：既有 `estimateCost stays cache-unaware (planning path unchanged)` 仍 `toBeCloseTo(18, 6)`（sonnet 1M/1M = 3+15）；新用例补 flex = **9**、表外档 = 无档逐位一致。

### ② "Tests cover subagentCost and getRemainingBudget — name the test titles and paste the vitest summary of the new file plus `tests/unit/agent` and `tests/unit/services/core` whole directories."

新文件 5 条用例名（`tests/unit/agent/subagentPipeline.serviceTier.test.ts`）：

1. `subagentCost prices flex usage at exactly 0.5x of the same tier-less usage`
2. `standard / absent / unknown tier usages keep the pre-change figure bit for bit`
3. `getRemainingBudget hands nested subagents the flex-discounted remainder`
4. `checkBudget no longer stops a flex subagent whose standard price would exceed maxBudget, but still stops real overruns`
5. `completeContext, checkBudget and getBudgetStatus report the same tier-aware figure`

vitest 汇总（原样粘贴）：

```
新文件（--reporter=verbose，5/5 全绿）：
 ✓ tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > subagentCost prices flex usage at exactly 0.5x of the same tier-less usage 4ms
 ✓ tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > standard / absent / unknown tier usages keep the pre-change figure bit for bit 1ms
 ✓ tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > getRemainingBudget hands nested subagents the flex-discounted remainder 1ms
 ✓ tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > checkBudget no longer stops a flex subagent whose standard price would exceed maxBudget, but still stops real overruns 1ms
 ✓ tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > completeContext, checkBudget and getBudgetStatus report the same tier-aware figure 0ms
 Test Files  1 passed (1)
      Tests  5 passed (5)

整目录：
 tests/unit/agent          → Test Files  335 passed (335) / Tests  3900 passed (3900)
 tests/unit/services/core  → Test Files   33 passed (33)  / Tests   169 passed (169)
 四目录合跑（agent+services/core+shared+testing）→ Test Files  536 passed (536) / Tests  5488 passed (5488)
```

getRemainingBudget 专测：maxBudget $50 下 flex 单笔余量 **42**、标准单笔 **34**（差恰省下的 $8）；flex+标准混记两笔 = $24 → 余 **26**，全部 `toBe` 精确断言。

### ③ "Reverse mutation (ignore the tier): remove the `usage.serviceTier` argument in `calculateTotalCost` (and separately make `estimateCost` ignore the 5th parameter) → the new tests go red; paste the raw red lines; restore from a backup copy (not `git checkout -- <file>`) → green."

变异 A（`subagentPipeline.ts:553` 去掉第 5 参 `usage.serviceTier`）→ `npx vitest run tests/unit/agent/subagentPipeline.serviceTier.test.ts` EXIT=1，红行原文：

```
⎯⎯⎯ Failed Tests 4 ⎯⎯⎯
 FAIL  tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > subagentCost prices flex usage at exactly 0.5x of the same tier-less usage
AssertionError: expected 48 to be 24 // Object.is equality
 FAIL  tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > getRemainingBudget hands nested subagents the flex-discounted remainder
AssertionError: expected 34 to be 42 // Object.is equality
 FAIL  tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > checkBudget no longer stops a flex subagent whose standard price would exceed maxBudget, but still stops real overruns
AssertionError: expected false to be true // Object.is equality
 FAIL  tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > completeContext, checkBudget and getBudgetStatus report the same tier-aware figure
AssertionError: expected 32 to be 16 // Object.is equality
 Test Files  1 failed (1)
      Tests  4 failed | 1 passed (5)
```

（第 5 条「逐位不变」用例在变异 A 下应绿也确实绿——它断言的是无档路径不变。）

变异 B（`budgetService.ts:593` 改 `const multiplier = 1; // MUTATION-B: estimateCost ignores the 5th parameter`）→ 两测试文件 EXIT=1，红行原文：

```
⎯⎯⎯ Failed Tests 5 ⎯⎯
 FAIL  tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > subagentCost prices flex usage at exactly 0.5x of the same tier-less usage
AssertionError: expected 48 to be 24 // Object.is equality
 FAIL  tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > getRemainingBudget hands nested subagents the flex-discounted remainder
AssertionError: expected 34 to be 42 // Object.is equality
 FAIL  tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > checkBudget no longer stops a flex subagent whose standard price would exceed maxBudget, but still stops real overruns
AssertionError: expected false to be true // Object.is equality
 FAIL  tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > completeContext, checkBudget and getBudgetStatus report the same tier-aware figure
AssertionError: expected 32 to be 16 // Object.is equality
 FAIL  tests/unit/services/core/budgetCacheAwareCost.test.ts > BudgetService cache-aware cost accounting (WP2-1) > estimateCost applies the flex service tier at 0.5x; absent tier stays 18 (N-MODELCAT-SERVICE-TIER-COST-FU2)
AssertionError: expected 18 to be close to 9, received difference is 9, but expected 5e-7
 Test Files  2 failed (2)
      Tests  5 failed | 13 passed (18)
```

还原：`cp /tmp/fu2-backup-subagentPipeline.ts src/host/agent/subagentPipeline.ts`、`cp /tmp/fu2-backup-budgetService.ts src/host/services/core/budgetService.ts`（备份副本，未用 `git checkout -- <file>`）；`git diff --stat` 空输出、`git status --short` 空；复跑两文件 `Test Files  2 passed (2)` / `Tests  18 passed (18)`。

### ④ "`completeContext`, `checkBudget` and `getBudgetStatus` all report the same tier-aware figure (assert one number across the three in a test)."

用例 `completeContext, checkBudget and getBudgetStatus report the same tier-aware figure`：2 笔 flex（各 $8）maxBudget=$16 的上下文，三路同报 **16**——

- `getBudgetStatus(ctx).subagentCost` → `toBe(16)`
- `checkBudget(ctx).reason` → `toBe('Subagent budget exceeded: $16.00 / $16.00')`
- `completeContext(agentId, true)` 审计条目（`getAuditLog(agentId)` 取 `action:'complete'`）`cost` → `toBe(16)`

### ⑤ "Expected gain: an unattended run with a subagent budget whose subagents ran on flex is no longer stopped or throttled early because spend was overestimated 2x — proven by the test in To-do 3(d) with the real pricing table, raw output pasted (a live model run is impossible: no subscription model reports flex; say so in the evidence file)."

3(d) 用例真跑绿（--reporter=verbose 原始行）：

```
 ✓ tests/unit/agent/subagentPipeline.serviceTier.test.ts > SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2) > checkBudget no longer stops a flex subagent whose standard price would exceed maxBudget, but still stops real overruns 1ms
```

语义（真实价表 gpt-6.1-sol，无 mock）：maxBudget=$10，一笔 3M in / 1M out——标准价口径 $16 ≥ $10 会拦停（改前行为，测试里同款 usage 无档上下文断言 `allowed === false` 钉住）；flex 实花 $8 < $10 → `allowed: true` 且无警告；再记第二笔 flex（累计 $16 ≥ $10）仍真拦（`reason` 逐字 `'Subagent budget exceeded: $16.00 / $10.00'`）。即：无人值守 run 的子代理跑 flex 时不再因 2 倍高估被提前停/警，真超线照拦。

真机跑不可能：GLM/Step/TypeSafe 订阅模型无一上报 `service_tier=flex`（OpenAI Responses 特性；flex 0.5x 倍率证据来自父单 N-MODELCAT-SERVICE-TIER-REALCALL 真调用 gpt-6.1-sol /v1/responses）。故本单证据档位为 **hermetic-protocol**（真实 BudgetService + 真实价表 + 精确浮点断言，非 mock 单测的形状假设），辅以 static-contract 门（typecheck/tsc-tests/knip/eslint 棘轮）。

## 抽查表

| 断言 | 证据 |
|---|---|
| `estimateCost` 的 src 调用方只有 pipeline 这一处（加参不破坏别的调用点） | `grep -rn "\.estimateCost(" src tests --include="*.ts"` 全量 7 行：`src/host/agent/subagentPipeline.ts:553`（唯一 src 消费方，已传第 5 参）；`src/renderer/components/design/autonomyProposalRouting.ts:80`、`useCanvasProposalReview.ts:135` 是设计面另一个同名 dep 接口，与 BudgetService 无关；测试 4 行：`tests/unit/testing/evalSubagentCostScope.test.ts:57`（4 参调用，不受影响，四目录跑绿）、`tests/unit/services/core/budgetCacheAwareCost.test.ts:108,114,115,116` |
| 倍率逻辑与 computeUsageCostUsd 同源、不重排无档浮点 | `budgetService.ts:592-594`（multiplier===1 原值返回）对照 `src/shared/constants/pricing.ts:97-102` 同款写法 |
| 未新增 Date.now / 硬编码 provider/价格进 src | diff 全量核对本单 src 改动仅 2 文件 +7 行；自检 grep `\\|\\| 'deepseek'` 0 行；repositories `Date.now()` 96 行全为存量（本单未触碰该目录） |

## 取舍记录（无人答复，按字面继续）

1. **双证据档**：任务书指名 `docs/evidence/N-MODELCAT-SERVICE-TIER-COST-FU2-2026-10-22.md`（仓内，已提交）；mq-dispatch 队列只认 `~/work/evidence/N-MODELCAT-SERVICE-TIER-COST-FU2.md`——同内容另写一份，DONE 行在两份末尾。
2. **测试直接 `ctx.tokenUsage.push(...)` 而非 `pipeline.recordTokenUsage`**：后者会连带写全局单例（`recordUsage` → DB appendUsageRecord + scoped recorder），把红绿耦合到无关全局态；`calculateTotalCost` 消费的恰是 `ctx.tokenUsage`。executor→recordTokenUsage 带档接线已由父单 `tests/unit/agent/subagentExecutor.serviceTier.test.ts` 覆盖。
3. **beforeEach 钉全局单例 `enabled + maxBudget:0`**：让 `checkBudget` 的全局半边恒 NONE，红绿只取决于子代理本地账。
4. **期望值从 `MODEL_PRICING_PER_1M` 取**（不在测试里再抄一份价表），绝对锚点数字（16/8/24/48/42/34/26/9/18）作为 REALCALL 口径字面断言，沿用 `tests/unit/shared/pricingTiers.test.ts` 的先例。
5. **gates:fast 登记件**：两个 src 路径不在 policy 登记表，按机制写 `~/work/out/N-MODELCAT-SERVICE-TIER-COST-FU2/regressions.json`（reason + 3 个守门测试文件）后复跑绿，回执绑定 HEAD。
6. 无槽/桌面验证不适用：纯 host 记账路径，无 renderer/IPC 面。

## 未跑的格与原因

- `npm run gates:local`（691s 全量）：工人机禁令（权威门在 CI），已按改动面跑上列门 + 四目录整跑。
- `npm run acceptance:snapshot-replay:record`：模型可见请求字节零变化（纯记账），任务书明示无需重录。
- 真机 flex 复现：订阅模型无一上报 `service_tier=flex`，任务书已声明不可能，见 ⑤。
- request-replay / 工具输出 schema / PTC / context-overhead / ESM-CJS / 视觉基线：未触碰对应面（队列若跑以队列为准）。

## 分支与 HEAD

- 分支 `mq/modelcat-service-tier-cost-fu2`，HEAD `9a032ab4f`（领先 origin/main 2 提交：`0fca40822`、`9a032ab4f`；本档随后作为第 3 提交）
- 只 commit 不 push（工人机无 ship/fleet；分支名交编排）

DONE N-MODELCAT-SERVICE-TIER-COST-FU2 9a032ab4f
