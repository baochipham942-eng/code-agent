# Codex Audit Report — eval-html-report

**Date**: 2026-07-03
**Scope**: origin/main(337e03cfa)..HEAD（feat/eval-html-report，6 commits；审计在 1eb1b12d2 基线上进行，收敛后 rebase 到 337e03cfa，零冲突）
**Starting commit**: bf47aa0e0（审计启动时 HEAD）
**Rounds run**: 3 / 4
**Converged**: ✅ yes（Round 3 = converged，见下）

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     |  1*  |  3  |  0  | 990ecd915  |
| 2     |  0   |  1  |  0  | 32c9bbc0e  |
| 3     |  0   |  0  |  0  | —          |

\* HIGH 为主干既有问题（本分支零接触），defer 上报，见下。

## Findings by Round

### Round 1

#### 🔴 HIGH — baselineManager compare/promote 能力分母不含 skipped
**Finding**: `BaselineManager.compare()/promote()` 的通过率分母 = total − infraExcluded（不减 skipped），而 markdown/HTML 报告口径 = total − skipped − infraExcluded（WP1-2）。带 skipped 的 run 会出现「HTML 报 100% / baseline delta 报 50%」的分裂，可能误触回归阈值或让 promote 落一个口径不一致的基线。
**Resolution**: ❌ deferred — **主干既有**（该逻辑随 PR#299 合入，本分支未触碰 baselineManager.ts）。且处于 G3 红线区（infra_excluded 分母/promote 口径冻结）：静默改分母会让存量已存基线产生幻影 delta，需产品负责人拍板口径 + 基线迁移方案，单独立项。本分支新增的 HTML 报告遵循的是既有 markdown 口径，未引入新的不一致。
**后续动作**: 已列入 PR 正文与装包后待办清单。

#### 🟡 MEDIUM — HTML 报告内容注入无上限
**Finding**: prompt/responses/errors/failure diff/tool output 全量插值，超大模型输出会把自包含 HTML 撑到浏览器无法打开。
**Resolution**: ✅ fixed in 990ecd915 — `capText()`（20k 字符/块 + 截断提示指向 JSON 报告）盖住 case 下钻区全部注入点。

#### 🟡 MEDIUM — 评分权威分桶表出现 unknown 第四桶（红线嫌疑）
**Finding**: 契约只定义三个 `ScoreAuthority`，HTML 表新增 unknown 行并计算均分。
**Resolution**: ℹ️ false positive — markdown 报告（WP1-1，`generateScoreAuthoritySection`）既有完全相同的四行结构（unknown=未标注历史遗留，配「不作能力证据」告诫），HTML 是刻意对齐。顺手补齐了 HTML 侧缺失的告诫脚注（parity fix，随 990ecd915）。

#### 🟡 MEDIUM — autoTestHook 完成消息分母 total−skipped
**Finding**: 与报告口径不一致（漏 infraExcluded），且全 skipped 时输出 NaN%。
**Resolution**: ✅ fixed in 990ecd915 — 抽 `formatAutoTestCompletionMessage()` 统一 WP1-2 能力分母 + 除零守卫（该行为主干既有，但本分支触碰了此文件且修复为纯展示层，无口径风险）。

### Round 2

#### 🟡 MEDIUM — capText 未对称应用（Baseline Delta / infra 表）
**Finding**: R1 的 cap 只盖住 case 下钻区；`BaselineManager.compare()` 会把超大 failureReason 复制进 `BaselineDelta.newFailures`，经 Baseline Delta 表无上限注入；基础设施排除表 reason 同款。教科书式 symmetric application 类发现。
**Resolution**: ✅ fixed in 32c9bbc0e — baseline failure reason / regressionDetails / infra reason 三处补齐同一 cap，双测试锚定。

### Round 3

首跑在最终 verdict 前被 900s timeout 截断，但已捕获的过程结论全部为通过性验证（插值点机器辅助分类、两枚 fix commit 无副作用、分母口径三处一致、无第二条 HTML 拼接路径）。verdict 重跑（窄 scope：逐插值点分类，1200s）：**converged — no findings**。

## Deferred Items
- baselineManager compare/promote 分母不含 skipped（主干既有，红线区，需拍板+基线迁移，单独立项）。

## LOW Findings（informational）
- 无。

## Convergence Analysis

三轮单调收敛（4→1→0）。R2 的唯一发现是 R1 修复的对称应用缺口（cap 没追到 BaselineDelta 这条数据搬运路径），再次印证：加防护时要沿数据流追到所有渲染出口，而不是只盖住"主表面"。XSS 维度两轮零发现——escapeHtml/escapeHtmlAttribute 全插值点覆盖在 R1 就成立；效率指标全程只存在于 trajectory 导出与 HTML triage 列，未进任何统计口径（专项 grep 验证）。
