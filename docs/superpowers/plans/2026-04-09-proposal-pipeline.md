# Proposal Pipeline + Shadow Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-Evolving v2.5 Phase 3 — 把 synthesize 的规则变更从"审批后立刻落地"改成"先写入 `~/.claude/proposals/` 待确认"，并用 Phase 2 的 `failure_attribution` 数据 + Phase 1 的 regression gate + 冲突扫描做三信号 shadow eval。每个 proposal 有完整 trail：创建 → 评估 → 审批 → 应用 / 归档。

**Architecture:**
```
synthesize Step 5 (approve)
         │
         ▼
~/.claude/proposals/YYYY-MM-DD-<id>.md  (pending)
         │
         ▼ shadowEvaluator
  ┌──────┴──────┐
  │ 冲突扫描     │  grep 新 rule 关键词 vs ~/.claude/rules, skills
  │ attribution │  读最近 20 条 grader-reports 的 rootCause category
  │ regression  │  跑 npm run regression:gate (DI 注入可 mock)
  └──────┬──────┘
         │
         ▼ recommendation
  apply / reject / needs_human
         │
         ▼ (apply)
~/.claude/experiments/exp-NNN-*.md  (现有路径)
proposal.status = applied
```

**Tech Stack:** TypeScript + vitest v4，无 LLM、无 trajectory

---

## File Structure

**Create:**
- `src/main/evaluation/proposals/proposalTypes.ts` — Proposal/ShadowEvalResult 类型
- `src/main/evaluation/proposals/proposalStore.ts` — 读写 proposals 目录（markdown + frontmatter）
- `src/main/evaluation/proposals/shadowEvaluator.ts` — 三信号评分器
- `src/main/evaluation/proposals/proposalApplier.ts` — apply 时从 proposals/ 搬到 experiments/
- `src/main/evaluation/proposals/index.ts` — barrel
- `scripts/proposal-cli.ts` — CLI 入口 (`list / eval / apply / reject / show`)
- `~/.claude/skills/propose-review/SKILL.md` — 新 skill
- `tests/unit/evaluation/proposals/proposalStore.test.ts`
- `tests/unit/evaluation/proposals/shadowEvaluator.test.ts`
- `tests/unit/evaluation/proposals/proposalApplier.test.ts`

**Modify:**
- `~/.claude/skills/synthesize/SKILL.md` — Step 5 落地路径切换
- `~/.claude/projects/-Users-linchen/memory/self-evolving-v2.md` — 十五章节
- `package.json` — 新增 `proposal` script 指向 `tsx scripts/proposal-cli.ts`

---

## Schema

```typescript
export type ProposalStatus =
  | 'pending'          // 刚写入，未 eval
  | 'shadow_passed'    // shadow eval 通过，等 apply
  | 'shadow_failed'    // regression gate block 或冲突过多
  | 'needs_human'      // 自动评分不确定
  | 'applied'          // 已落地到 experiments/
  | 'rejected'         // 用户拒绝
  | 'superseded';      // 被新 proposal 覆盖

export type ProposalType =
  | 'new_l3_experiment'
  | 'promote_l3_to_l2'
  | 'archive_expired'
  | 'merge_rules';

export interface Proposal {
  id: string;                  // prop-YYYYMMDD-NNN
  filePath: string;
  createdAt: string;           // ISO8601
  status: ProposalStatus;
  source: 'synthesize' | 'manual';
  type: ProposalType;

  // Content
  ruleId?: string;
  ruleContent?: string;        // 规则文本 body
  hypothesis: string;
  targetMetric: string;
  rollbackCondition: string;
  tags: string[];
  sunset?: string;             // 可选 YYYY-MM-DD

  // Filled by shadow evaluator
  shadowEval?: ShadowEvalResult;
}

export interface ShadowEvalResult {
  evaluatedAt: string;
  conflictsWith: string[];     // 文件路径片段
  addressesCategories: Array<{
    category: string;          // FailureCategory from Phase 2
    hits: number;
  }>;
  regressionGateDecision: 'pass' | 'block' | 'skipped';
  score: number;               // 0-1
  recommendation: 'apply' | 'reject' | 'needs_human';
  reason: string;              // 一句话
}
```

---

## Task 1: Types + Proposal Store (TDD)

**Files:**
- Create: `src/main/evaluation/proposals/proposalTypes.ts`
- Create: `src/main/evaluation/proposals/proposalStore.ts`
- Create: `tests/unit/evaluation/proposals/proposalStore.test.ts`

- [ ] **Step 1:** 写 proposalTypes.ts
- [ ] **Step 2:** 写 proposalStore.test.ts 的失败测试（loadProposal / loadAll / writeProposal / updateStatus / defaultDir）
- [ ] **Step 3:** 实现 proposalStore.ts
- [ ] **Step 4:** `npx vitest run tests/unit/evaluation/proposals/` 全绿

**测试场景：**
- parses well-formed proposal markdown
- rejects missing required fields (hypothesis / target_metric)
- writeProposal atomically creates a new file with stable ID
- updateStatus rewrites frontmatter without touching body
- loadAll sorts by createdAt desc
- missing dir returns []

---

## Task 2: Shadow Evaluator — 冲突扫描信号

**Files:**
- Create: `src/main/evaluation/proposals/shadowEvaluator.ts` (partial)
- Create: `tests/unit/evaluation/proposals/shadowEvaluator.test.ts`

ShadowEvaluator 用依赖注入方式组合三个信号，方便 mock：

```typescript
interface ShadowEvaluatorDeps {
  scanConflicts: (proposal: Proposal) => Promise<string[]>;
  readAttributionCategories: () => Promise<Map<string, number>>;
  runRegressionGate: () => Promise<'pass' | 'block' | 'skipped'>;
}

class ShadowEvaluator {
  constructor(private deps: ShadowEvaluatorDeps) {}
  async evaluate(p: Proposal): Promise<ShadowEvalResult> { ... }
}
```

- [ ] **Step 5:** 写 shadowEvaluator.test.ts 第一批（冲突扫描 + 高分 apply / 低分 needs_human / 硬 block）
- [ ] **Step 6:** 实现评分逻辑：score = 0.3 * regression_pass + 0.2 * per_attribution_hit - 0.3 * per_conflict，clamp 0-1；recommendation 规则见 brief
- [ ] **Step 7:** 实现默认 `scanConflicts`：grep 规则关键词在 `~/.claude/rules/`，返回命中的文件路径
- [ ] **Step 8:** 测试全绿

---

## Task 3: Shadow Evaluator — Attribution 信号默认实现

**Files:**
- Modify: `src/main/evaluation/proposals/shadowEvaluator.ts`
- Modify: `tests/unit/evaluation/proposals/shadowEvaluator.test.ts`

- [ ] **Step 9:** 实现默认 `readAttributionCategories`：扫最近 20 条 `~/.claude/grader-reports/*.json`，累加 `failure_attribution.root_cause_category`，返回 `Map<category, count>`
- [ ] **Step 10:** 评分：proposal.tags ∩ categories，命中 → `addressesCategories.hits`；每个 hit +0.2 up to 0.4
- [ ] **Step 11:** 测试 mock tmp dir 造 JSON 文件，验证读取和累加逻辑
- [ ] **Step 12:** 兼容 schema v2.1（无 failure_attribution 字段）的旧报告

---

## Task 4: Shadow Evaluator — Regression Gate 注入

**Files:**
- Modify: `src/main/evaluation/proposals/shadowEvaluator.ts`

默认 `runRegressionGate` 调 `child_process.spawnSync('npm', ['run', 'regression:gate'])`，解析 `/tmp/synth-gate.json` 或 stdout JSON。

- [ ] **Step 13:** 实现默认 runRegressionGate（超时 30s，失败返回 `'skipped'` 不硬阻塞 proposal 流程）
- [ ] **Step 14:** 测试 mock 注入 `pass / block / skipped` 三路径，验证 decision override
- [ ] **Step 15:** 测试全绿

---

## Task 5: Proposal Applier

**Files:**
- Create: `src/main/evaluation/proposals/proposalApplier.ts`
- Create: `tests/unit/evaluation/proposals/proposalApplier.test.ts`

将 `shadow_passed` 的 proposal 搬到 `~/.claude/experiments/exp-NNN-*.md`。不调用真实目录，通过 DI 接收目标目录。

- [ ] **Step 16:** 测试 applyProposal 生成符合现有 experiment 模板的 markdown
- [ ] **Step 17:** 生成 `exp-NNN` 编号（扫描目标目录现有最大序号 +1）
- [ ] **Step 18:** 更新 source proposal 的 status 为 `applied`
- [ ] **Step 19:** 实现 + 测试全绿

---

## Task 6: CLI 入口

**Files:**
- Create: `scripts/proposal-cli.ts`
- Modify: `package.json` (add `proposal` script)

CLI 命令：
- `proposal list [--status pending|applied|...]`
- `proposal show <id>`
- `proposal eval <id>`  → shadow evaluator
- `proposal apply <id>` → applier
- `proposal reject <id> [--reason]`

- [ ] **Step 20:** 实现 CLI 命令 dispatcher
- [ ] **Step 21:** 手动冒烟：用 fake proposal 走完 list / eval / apply 流程
- [ ] **Step 22:** 更新 package.json
- [ ] **Step 23:** `npm run typecheck` 通过

---

## Task 7: 接入 synthesize skill + 新 propose-review skill

**Files:**
- Modify: `~/.claude/skills/synthesize/SKILL.md`
- Create: `~/.claude/skills/propose-review/SKILL.md`

- [ ] **Step 24:** synthesize SKILL.md Step 5 `### If user says "y"` 分支下：不再直接写 `~/.claude/experiments/`，改为写 `~/.claude/proposals/YYYY-MM-DD-<slug>.md`，末尾提醒 "下一步跑 `/propose-review` 做 shadow eval + apply"
- [ ] **Step 25:** 写 propose-review SKILL.md：流程图 / CLI 使用 / apply 前的人类 review checklist

---

## Task 8: 文档 + 冒烟 + 验收

**Files:**
- Modify: `~/.claude/projects/-Users-linchen/memory/self-evolving-v2.md`

- [ ] **Step 26:** self-evolving-v2.md 追加「十五、Proposal Pipeline + Shadow Eval (v2.5 Phase 3)」
- [ ] **Step 27:** 手动造 2 个 fake proposal（一个会命中冲突、一个命中 attribution），跑 CLI 完整流程
- [ ] **Step 28:** commit

---

## 验收

- [ ] `npx vitest run tests/unit/evaluation/proposals/` 全绿
- [ ] `npm run typecheck` 通过
- [ ] CLI 跑完 list → eval → apply 流程
- [ ] Shadow eval 能用真实 `~/.claude/grader-reports/*.json` 的 failure_attribution 数据打分
- [ ] regression gate block 时 proposal 被强制标 `shadow_failed`
- [ ] self-evolving-v2.md 十五章节落盘

---

## 非目标（YAGNI）

- ❌ 不改 ExperimentRepository（数据库层与本模块正交）
- ❌ 不做 LLM-based 语义 diff
- ❌ 不做 auto apply（永远走人类 confirm）
- ❌ 不做 proposal 冲突的自动合并
- ❌ 不接 git（rollback 用户手动）
