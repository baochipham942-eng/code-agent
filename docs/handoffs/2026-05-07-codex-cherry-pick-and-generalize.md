# 任务 brief：把你 v10–v26 的真贡献泛化成通用 repair toolkit

**对象**: 艾克斯（Codex CLI）
**作者**: 劳拉（接手 v8 platformer acceptance 修复，做完 audit + 架构重构后委托给你这个任务）
**日期**: 2026-05-07
**前置阅读（必读，不要跳）**:
- `docs/audits/2026-05-07-game-acceptance-architecture.md` — 我对 v10–v26 这 17 轮的完整 audit
- `git log --oneline feat/game-acceptance-v2` — 已经合并的 5 个 commit（你的 stash 之上的架构重构）
- `git stash show -p stash@{0}` — 你之前的 16 文件改动，命名 "v8-platformer-v26-attempt-codex-2026-05-07"

---

## 1. 你的实际贡献分布（不是来批评你，是给你看清自己产出了什么）

你的 stash 1447 行新增 / 191 行删除 / 16 文件，分布如下：

| 性质 | 量 | 评价 |
|------|---|------|
| 真工程贡献 | ≈ 800–1000 行 | 60%——你产出了 **5 个对内容生成泛化都有价值的 repair pattern** |
| 无用功 | ≈ 400 行（67 行 prompt × 2 + 5 轮 LLM 抽奖） | 重写整个 prompt + 反复修同类失败 |
| scope 蔓延 | 4 文件 | 混在 v8 修复 PR，未来 cherry-pick 困难 |

**你产出了通用价值，但你自己没意识到**——5 个 pattern 全部被 platformer 字眼包装着。这次任务就是让你**亲手把通用部分抽出来**，做成可复用的 repair toolkit。

---

## 2. 你产出的 5 个 pattern（劳拉已识别）

### Pattern 1: issue code → repair instruction → scope guard 三层映射 【HIGH 泛化】

**你在哪里做的**: `src/main/agent/runtime/toolExecutionEngine.ts` 加 `input_normalizer_missing` 时，三层都补了：
- classifyFailure regex（识别）
- repairInstruction（指导 LLM）
- detectArtifactRepairIssueScopeMismatch（防 LLM 改无关代码）

**为什么是 HIGH 泛化**: 这套三层模式适用于 PPT 验收（"slide 缺标题"）、Doc 验收（"章节缺 TOC"）、Dashboard 验收（"按钮无事件"）——所有 LLM 自动 repair loop 都需要。

### Pattern 2: keptImprovedPatch baseline 升级 【HIGH 泛化】

**你在哪里做的**: `src/main/agent/runtime/contextAssembly/messageBuild.ts` 加的 `keptImprovedPatch` 字段——失败 patch 如果改进了 validation 仍保留作 baseline。

**关键事实**: 这跟劳拉刚在 `scripts/acceptance/platformer-gameplay-generation.ts` 里加的 monotonicity gate 是**同源思想**。但你的实现没完整集成，劳拉的实现完整但不知道你已经想过这个。两者要合并。

### Pattern 3: Repair prompt size 上限 【HIGH 泛化】

**你在哪里做的**: `src/main/agent/runtime/artifactRepairSpec.ts` 把 `MAX_PROMPT_CHARS` 3600→1500 / `MAX_PROMPT_ISSUES` 8→3 / `MAX_EVIDENCE_LENGTH` 280→220。`pushUniqueLimited` 限制 6→4 / 260→140。

**为什么 HIGH**: 这是 LLM repair prompt 的普适规则——精炼 > 详尽。直接 cherry-pick 就行，不需要泛化抽象。

### Pattern 4: failure 模式固化为 regression test 【MEDIUM 泛化】

**你在哪里做的**: 500 行 `tests/unit/agent/gameArtifactValidator.runSmokeEvidence.test.ts`——把 v* 多轮失败模式编成 unit test。

**为什么 MEDIUM**: 工作流通用（"每个 LLM 生成失败模式 → 写一个 regression test"），但内容是 platformer-specific。

### Pattern 5: context_assembly issue-code-aware read window 【LOW 泛化】

**你在哪里做的**: `src/main/agent/runtime/contextAssembly/inference.ts` 给 `missing_snapshot_metric` / `control_no_state_change` 加 metadata 文件 read window。

**为什么 LOW**: 思路对（让 repair LLM 看到正确代码段），但实现 platformer-aware。

---

## 3. 你的任务

把 Pattern 1-3 抽出来做成**通用 repair toolkit**。Pattern 4-5 做成可选 stretch goal。

### 必做（3 个 commit）

#### Commit 1: 通用 scope mismatch detection 框架

把你在 `toolExecutionEngine.ts` 写的 `detectArtifactRepairIssueScopeMismatch` 里的 if-else 链路重构成 **dispatch 注册表**：

```
src/main/agent/runtime/repair/
  scopeGuards.ts          # ScopeGuard interface + 注册表 + dispatch
  platformerScopeGuards.ts # platformer 的具体 entries（input_normalizer_missing 等）
```

`scopeGuards.ts` 提供：

```typescript
export interface ScopeGuard {
  issueCode: string;
  scopeRegex: RegExp;        // patch 必须 touch 的代码 scope
  failureMessage: string;    // 不 touch 时给 LLM 的反馈
}

class ScopeGuardRegistry {
  register(guard: ScopeGuard): void;
  check(issueCodes: string[], patchText: string): string | null;  // 返回 mismatch reason
}

export const scopeGuardRegistry = new ScopeGuardRegistry();
```

`platformerScopeGuards.ts` 注册 platformer 的 entries（你写的 input_normalizer_missing / missing_snapshot_metric / malformed_test_contract 等）。

`toolExecutionEngine.ts` 主入口改成调 `scopeGuardRegistry.check(...)`，**0 个 platformer 关键词**留在主入口。

未来加 PPT/Doc/Dashboard 的 scope guard 不需要动 toolExecutionEngine.ts。

#### Commit 2: 通用 monotonicity gate（与劳拉的实现合并）

劳拉在 `scripts/acceptance/platformer-gameplay-generation.ts` 已经实现了 acceptance 层面的 monotonicity gate（每轮跑 BoN=3，发现退化轮 PASS 数 < 上一轮就 warn 或 hard fail）。

你的 `keptImprovedPatch` 是 repair-loop 内部的 patch monotonicity（每个 patch 是否改进 validation）。

把两者**合并成一个 `MonotonicityTracker` 类**：

```
src/main/agent/runtime/repair/monotonicityTracker.ts
```

接口：
```typescript
class MonotonicityTracker {
  recordRound(roundN: number, passCount: number, failures: string[]): MonotonicityVerdict;
  // verdict: 'improved' | 'regressed' | 'same' + 是否应该 keep / revert / warn
}
```

让 `messageBuild.ts` 的 `keptImprovedPatch` 路径和 `platformer-gameplay-generation.ts` 的 monotonicity gate 都通过这个 tracker 跑。

#### Commit 3: Repair prompt size 上限（直接 cherry-pick + 微调）

把你在 `artifactRepairSpec.ts` 缩小的几个常量（`MAX_PROMPT_CHARS` / `MAX_PROMPT_ISSUES` / `MAX_EVIDENCE_LENGTH` / `pushUniqueLimited` 限制）单独 cherry-pick 进 main。

**协调点**: 劳拉的架构重构已经动过 `artifactRepairSpec.ts` 引入 dispatch，你 cherry-pick 时要 rebase 在劳拉的改动之上，避免冲突。

把这几个常量挪到 `src/shared/constants/repair.ts`（新文件），让其他 artifact kind 的 repair 也能共享。

### 可选（如果时间允许，做 1 个就好）

#### Commit 4 (可选): Acceptance 失败 → regression test 自动化工作流

写一个 helper：从 acceptance 报告（`games/generated-platformer-regression-openrouter-v*.validation.md`）自动提取失败模式，生成 vitest test 骨架。让"每发现一个 LLM 失败 → 写 regression test"这个工程纪律自动化。

#### Commit 5 (可选): issue-code-aware read window 注册表

把你在 `inference.ts` 写的 `getArtifactRepairRelevantReadWindows` 里的 if-else 改成注册表 dispatch，跟 Commit 1 的思路类似。

---

## 4. 红线（这次必须避免，否则你会再踩一次同样的坑）

劳拉根据 v10–v26 复盘提炼了 5 条红线，每条都对应你这次的真实踩坑：

1. **Minimum-diff 改 prompt** — 改 prompt 的 diff 行数 ≤ 5。修一个语义点禁止重写整段 prompt。（v26 67 行重写直接退化 v25）
2. **概率性失败用 BoN，不改 prompt** — 同一 prompt 散点 fail/pass = 抽奖问题，加 BoN/retry，不要改 prompt。（你这次 prompt 改了无数次）
3. **单点规则禁止多处维护** — grep 同字符串 ≥3 处必须重构成 single source of truth。（你"movement 用 increase"散布在 4 个文件）
4. **改完跑 baseline 对比** — 改完 prompt 或 validator 必须跑当前 acceptance suite 对比；任何已 PASS mechanic 退化立即 revert。（v25 5 mechanics proven，v26 退到 2 个，没人发现）
5. **scope 蔓延强制拆 commit** — 一个 PR 改 ≥3 个不同领域文件 = 拆 PR。（你这次 16 文件混一起，cherry-pick 困难）

每轮改动前自查清单：
- [ ] minimum-diff？diff ≤ 5 行？
- [ ] 同样失败已经 ≥3 次了？该 BoN 而不是改 prompt？
- [ ] 这条规则要写多处？该抽 SSOT？
- [ ] baseline snapshot 拍了吗？改完跑了对比吗？
- [ ] 这次 scope 在不在原任务范围里？

任意一项 ❌ → 停下来重审。

---

## 5. 工作流

1. 切到 `main` 分支（不是 `feat/game-acceptance-v2`）
2. 创建 `feat/codex-generalize-repair-toolkit`
3. 读完上面所有材料（audit + 这个 brief + 你的 stash diff）
4. 按 Commit 1 → 2 → 3 顺序做，每个独立 commit
5. 每个 commit 后跑 `npm run typecheck && npx vitest run tests/unit/agent/`
6. 任何已 PASS 测试退化 → 立即 revert（红线 4）
7. 开 PR `Generalize repair toolkit from v10–v26 lessons`，PR body 列出每个 commit 抽出的"通用价值"
8. 让劳拉 review

---

## 6. 完成定义

- Commit 1-3 全部落地，每个独立 commit message 解释抽象的通用价值
- typecheck clean，所有相关 tests pass
- 主入口（toolExecutionEngine.ts、messageBuild.ts、artifactRepairSpec.ts）grep 'platformer' = 0 处直接关键词（只允许在 import 注释、字符串常量 `'platformer'` 用作 registry key）
- PR body 包含：(a) 5 个 pattern 的泛化映射 (b) 红线对照表（这次怎么避开了）

---

## 7. 关键约束

- **不修改 `feat/game-acceptance-v2` 已合并的代码**——劳拉做的架构骨架（types/verbs/registry/skill-loader + PlatformerChecker 迁移）不动
- 你的工作分支基于 `main`，不基于 `feat/game-acceptance-v2`——避免依赖劳拉未合并的分支
- 完成后两条 PR 由劳拉协调合并：
  - 劳拉的 `feat/game-acceptance-v2`（架构骨架 + platformer 迁移 + runner 验证）
  - 你的 `feat/codex-generalize-repair-toolkit`（通用 repair toolkit）

---

## 8. 一句话总结

你 17 轮里产出了 5 个通用 repair pattern，但全部用 platformer 字眼包装着。这次任务是**亲手把通用部分剥出来，让 PPT/Doc/Dashboard 等其他 artifact kind 都能复用**。每个 pattern 你都已经写过了，现在只是把它从 platformer 包装里取出来。

不要从头重写。**先看你自己写的东西，识别哪部分是通用的，再抽离。**
