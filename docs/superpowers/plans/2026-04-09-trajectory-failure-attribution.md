# Trajectory Failure Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-Evolving v2.5 Phase 2 — 给每条失败/部分失败的 Trajectory 产出结构化 `failure_attribution`（根因 + 因果链 + 置信度 + 关联 reg-* case），接入 Grader Report 和 synthesize skill，让 v2.4 Regression Floor Gate 被触发时能直接带根因说"为什么塌了"。

**Architecture:** 现有 `src/main/evaluation/trajectory/` 只有规则级 deviation marker（loop/wrong_args/hallucination/unnecessary_step），本期在其上加 `attribution/` 子模块，做「规则优先 + LLM fallback」的根因定位 + 因果链 + 回归 case 匹配。

**Tech Stack:** TypeScript + vitest v4（CA 项目）+ modelRouter（复用已有 provider 抽象，禁止硬编码模型）

---

## File Structure

**Create:**
- `src/main/evaluation/trajectory/attribution/ruleAttributor.ts` — 规则归因主逻辑
- `src/main/evaluation/trajectory/attribution/llmAttributor.ts` — LLM fallback（低信触发）
- `src/main/evaluation/trajectory/attribution/regressionMatcher.ts` — 匹配 `~/.claude/regression-cases/*.md`
- `src/main/evaluation/trajectory/attribution/failureAttributor.ts` — 门面
- `src/main/evaluation/trajectory/attribution/index.ts` — barrel
- `src/main/evaluation/trajectory/attribution/__tests__/ruleAttributor.test.ts`
- `src/main/evaluation/trajectory/attribution/__tests__/regressionMatcher.test.ts`
- `src/main/evaluation/trajectory/attribution/__tests__/llmAttributor.test.ts`
- `src/main/evaluation/trajectory/attribution/__tests__/failureAttributor.test.ts`

**Modify:**
- `src/main/testing/types.ts` — 追加 `FailureAttribution` 接口；`TestResult.trajectoryAnalysis` 增加 `failureAttribution?: FailureAttribution`
- `src/main/evaluation/trajectory/index.ts` — barrel export 追加 attribution
- `src/main/evaluation/EvaluationService.ts` — 调用点约在 L246 附近，`enableLLM: false`
- `src/main/evaluation/telemetryQueryService.ts` — 调用点约在 L511 附近，`enableLLM: true`
- `~/.claude/skills/grader/SKILL.md` — Grader Report schema 升级到 v2.2，新增可选 `failure_attribution` 字段
- `~/.claude/skills/synthesize/SKILL.md` — Step 3.5 block 分支聚合 top-3 rootCause.category
- `~/.claude/projects/-Users-linchen/memory/self-evolving-v2.md` — 追加「十四、Trajectory Failure Attribution (v2.5, 2026-04-09)」章节

---

## Schema

```typescript
// src/main/testing/types.ts 追加
export interface FailureAttribution {
  trajectoryId: string
  outcome: 'success' | 'partial' | 'failure'
  rootCause?: {
    stepIndex: number
    category: 'tool_error' | 'bad_decision' | 'missing_context'
            | 'loop' | 'hallucination' | 'env_failure' | 'unknown'
    summary: string            // 一句话人话
    evidence: number[]         // 相关 step index
    confidence: number         // 0-1
  }
  causalChain: Array<{
    stepIndex: number
    role: 'root' | 'propagation' | 'terminal'
    note: string
  }>
  relatedRegressionCases: string[]  // 匹配到的 reg-* id
  llmUsed: boolean
  durationMs: number
}
```

成功 trajectory 的 `rootCause` 省略、`causalChain` 为空、`relatedRegressionCases` 为空。

---

## Task 1: Schema + 测试桩

**Files:**
- Modify: `src/main/testing/types.ts`
- Create: `src/main/evaluation/trajectory/attribution/__tests__/ruleAttributor.test.ts`（失败 stub）

- [ ] **Step 1:** 追加 `FailureAttribution` 到 `types.ts`，并在 `TestResult.trajectoryAnalysis` 类型里追加可选 `failureAttribution` 字段
- [ ] **Step 2:** `npm run typecheck` 通过
- [ ] **Step 3:** 写 ruleAttributor 的失败测试（4 个场景见 Task 2），先保证 import 失败

---

## Task 2: ruleAttributor —— 纯规则根因定位

**Files:**
- Create: `src/main/evaluation/trajectory/attribution/ruleAttributor.ts`
- Create/Modify: `__tests__/ruleAttributor.test.ts`

**规则优先级**（自上而下扫描 trajectory）：
1. 首个 `severity === 'high'` 或 `'critical'` 的 DeviationMarker → `root`，category 按 marker.type 映射：`loop → 'loop'`、`hallucination → 'hallucination'`、`wrong_args → 'bad_decision'`。confidence = 0.9
2. 否则：前 30% 出现的首个 `type === 'error'` 或 failed tool_call → `root`，category = `tool_error`。confidence = 0.75
3. 否则：末尾 5 步内出现的 failed tool_call → `root`（环境失败），category = `env_failure`。confidence = 0.6
4. 都不匹配：`category = 'unknown'`，confidence = 0.3（触发 LLM fallback）

**因果链构建**：
- root 后到末尾之间，所有 failed tool_call → `propagation`（note 写失败原因）
- 最后一个 step 若 outcome !== 'success' → `terminal`

**测试场景：**

- [ ] **Step 4:** loop 场景 — 构造 trajectory 含 high-severity loop marker → rootCause.category === 'loop' && confidence >= 0.8
- [ ] **Step 5:** tool_error 传播 — 第 2 步 failed，后续 3 步继续 failed → root @ step 2, causalChain 包含 3 条 propagation
- [ ] **Step 6:** env_failure — 前面全成功，末尾 bash 失败 → category === 'env_failure'
- [ ] **Step 7:** success trajectory → rootCause 省略，causalChain 空
- [ ] **Step 8:** unknown — 无 deviation 无 error 但 outcome=partial → category === 'unknown', confidence < 0.5
- [ ] **Step 9:** 实现 `ruleAttributor.ts`，所有测试绿
- [ ] **Step 10:** `npm run typecheck`

---

## Task 3: regressionMatcher —— 关联 reg-* case

**Files:**
- Create: `src/main/evaluation/trajectory/attribution/regressionMatcher.ts`
- Create: `__tests__/regressionMatcher.test.ts`

**实现约定：**
- 读 `~/.claude/regression-cases/*.md` 的 frontmatter（复用 v2.4 的 `caseLoader` 如已就绪，否则轻量 gray-matter 解析）
- 匹配信号：trajectory 内出现的 tool 名 ∩ case.tags、error 消息 ∩ case.scenario 关键词、related_rules 文件路径命中
- 评分：`score = 0.4 * tool_overlap + 0.4 * keyword_overlap + 0.2 * path_hit`
- 阈值 `> 0.6` 视为命中
- 目录路径从 `os.homedir()` 拼接，不硬编码 `/Users/linchen`

**测试：**

- [ ] **Step 11:** tmpdir 造 2 个假 reg-*.md（含 tags/scenario），trajectory 含匹配 tool → 命中预期 id
- [ ] **Step 12:** 无关 trajectory → 返回空数组
- [ ] **Step 13:** 目录不存在 → 返回空数组，不抛
- [ ] **Step 14:** 实现 + 绿

---

## Task 4: llmAttributor —— 低信 fallback

**Files:**
- Create: `src/main/evaluation/trajectory/attribution/llmAttributor.ts`
- Create: `__tests__/llmAttributor.test.ts`

**约束：**
- 通过依赖注入接收一个 `chatCompletion` 函数，不直接 import provider（方便 mock 和测试）
- 真实调用端传入 `modelRouter` 封装的 completion
- 输入只发送摘要：`intent` + `deviations` + 前 5 + 后 5 步 + error messages
- Token 预算上限 5000（超则截断）
- 输出强制 JSON schema 同 FailureAttribution.rootCause
- JSON 解析失败 → 退回规则结果 + `llmUsed: false`
- 不硬编码模型名，模型由调用方 `DEFAULT_PROVIDER` 决定

**测试：**

- [ ] **Step 15:** mock chatCompletion 返回合法 JSON → FailureAttribution 正确填充，llmUsed=true
- [ ] **Step 16:** mock 返回非法 JSON → 不抛，返回 null 让门面降级
- [ ] **Step 17:** mock 抛错 → 不抛，返回 null
- [ ] **Step 18:** 实现 + 绿

---

## Task 5: failureAttributor 门面

**Files:**
- Create: `src/main/evaluation/trajectory/attribution/failureAttributor.ts`
- Create: `src/main/evaluation/trajectory/attribution/index.ts`
- Create: `__tests__/failureAttributor.test.ts`

**API：**

```typescript
export class FailureAttributor {
  async attribute(
    trajectory: Trajectory,
    opts?: {
      enableLLM?: boolean
      llmFn?: (prompt: string) => Promise<string>
      regressionCasesDir?: string
    }
  ): Promise<FailureAttribution>
}
```

**流程：**
1. 先跑 ruleAttributor
2. 若 `enableLLM === true` 且 `rule.rootCause.confidence < 0.5` → 跑 llmAttributor，成功则替换 rootCause
3. 并行跑 regressionMatcher 填充 `relatedRegressionCases`
4. 记 `durationMs`

**测试：**

- [ ] **Step 19:** enableLLM=false + 高信规则 → llmUsed=false
- [ ] **Step 20:** enableLLM=true + 低信规则 + mock llm 命中 → llmUsed=true, category 被替换
- [ ] **Step 21:** enableLLM=true + 低信规则 + mock llm 返 null → 保留规则结果，llmUsed=false
- [ ] **Step 22:** 实现 + 绿
- [ ] **Step 23:** 更新 `trajectory/index.ts` 追加 `export * from './attribution'`

---

## Task 6: 接入 EvaluationService + telemetryQueryService

**Files:**
- Modify: `src/main/evaluation/EvaluationService.ts` (around L246, 在 `trajectoryAnalysis = { ... }` 之后)
- Modify: `src/main/evaluation/telemetryQueryService.ts` (around L511)

- [ ] **Step 24:** EvaluationService: `new FailureAttributor().attribute(trajectory, { enableLLM: false })`，写入 `result.trajectoryAnalysis.failureAttribution`
- [ ] **Step 25:** telemetryQueryService: 同上但 `enableLLM: true` 且注入 modelRouter-based `llmFn`
- [ ] **Step 26:** `npm run typecheck` 通过
- [ ] **Step 27:** 手动拿一条近期真实 session（`~/.claude/grader-reports/2026-04-08-a6abbd8c-092.json` 对应的 sessionId）跑 trajectoryAnalysis，人工检查 `failureAttribution.rootCause` 合理

---

## Task 7: 接入 Grader Report + synthesize skill

**Files:**
- Modify: `~/.claude/skills/grader/SKILL.md`
- Modify: `~/.claude/skills/synthesize/SKILL.md`

- [ ] **Step 28:** grader SKILL.md schema 升级到 v2.2，新增可选字段：
  ```json
  "failure_attribution": {
    "root_cause_category": "...",
    "root_cause_summary": "...",
    "confidence": 0.0,
    "related_regression_cases": []
  }
  ```
  标注 "v2.2 新增，可选，来自 telemetryQuery trajectoryAnalysis"
- [ ] **Step 29:** synthesize SKILL.md Step 3.5 block 分支追加一段："若最近 5 条失败 session 有 `failure_attribution`，聚合 top-3 `root_cause_category` 在 `⚠️ REGRESSION BLOCKED` 下方输出"

---

## Task 8: 文档 + 验收

**Files:**
- Modify: `~/.claude/projects/-Users-linchen/memory/self-evolving-v2.md`

- [ ] **Step 30:** 追加「十四、Trajectory Failure Attribution (v2.5, 2026-04-09)」章节，≤ 40 行，含：模块清单 / Schema / 集成点 / 与 v2.4 的互补关系
- [ ] **Step 31:** 更新 MEMORY.md 索引条目
- [ ] **Step 32:** commit（一次一个功能点，别积攒）

---

## 验收标准

- [ ] `npx vitest run src/main/evaluation/trajectory/attribution/` 全绿
- [ ] `npm run typecheck` 通过
- [ ] 拿 `~/.claude/grader-reports/2026-04-08-a6abbd8c-092.json` 对应 session 跑一次 trajectoryAnalysis，`failureAttribution.rootCause` 非空且 `causalChain.length >= 1`
- [ ] 手动构造 loop session → `category === 'loop'` && confidence >= 0.8 && llmUsed === false
- [ ] 手动构造匹配 reg-003 的 session → `relatedRegressionCases` 包含 `reg-003`
- [ ] 触发 `/synthesize` 并人为造 gate block → 简报带 top-3 root_cause_category
- [ ] self-evolving-v2.md 十四章节已落盘

---

## 非目标（YAGNI）

- ❌ 不改 DeviationDetector 的现有规则
- ❌ 不做跨 trajectory 的归因聚合（留给 Phase 3）
- ❌ 不做自动 prompt 优化 / GEPA
- ❌ LLM attributor 默认关闭，只在人工查询场景开
- ❌ 不做 regression case 的自动生成
- ❌ 不引入新 LLM provider，全部走现有 modelRouter
