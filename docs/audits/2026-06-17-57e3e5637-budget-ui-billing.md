# Codex Audit Report — budget-ui-billing

**Date**: 2026-06-17
**Scope**: `6b88fd5a0~1..d9cdaff02`（Item4 预算前端闭环 4 个 commit：IPC+同步 / CostDisplay 染色 / 设置页 / alert toast）
**Starting commit**: 57e3e5637
**Rounds run**: 3 / 4
**Converged**: ✅ yes（Round 3 = "converged — no findings"）
**Reviewer**: Codex gpt-5.5（经代理；diff 喂 stdin 只读审，规避 codex 自导航仓库崩溃）

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     | 3*   | 4   | 3   | 444e6ae7f  |
| 2     | 0    | 1   | 0   | 58a554a25  |
| 3     | 0    | 0   | 0   | —（converged）|

\* Round 1 的 3 个"HIGH"经独立验证后实际为 1 个真 MED + 2 个防御性加固（详见下）。

## Findings by Round

### Round 1

#### 🟡 F2 (MED) — updateConfig 不重置告警去重标志（stale flag）
**Finding**: 已在 85% 告警过 → 把 warningThreshold 提到 95% → 再越 95% 时不会重新告警，因为 `warningEmitted` 仍为 true。
**Resolution**: ✅ fixed in 444e6ae7f — updateConfig 重新武装 warning/blocked 标志（R2 又收紧为"仅边界字段变化时"）。**Codex caught a real bug I missed.**

#### 🟡 F4 (MED) — useBudgetStatus.normalize 不挡异常值
**Finding**: 后端若返回 NaN/Infinity/负数，直接流到 StatusBar 渲染垃圾。
**Resolution**: ✅ fixed in 444e6ae7f — `normalizeBudgetStatus` 钳到有限非负，usagePercentage min(.,10)。防御性（数据源是自家 budgetService，风险低，但加固便宜）。

#### 🟡 F3 (HIGH→MED) — settings.ipc payload narrowing 不安全
**Finding**: `'budget' in payload` 在 payload 为 null/primitive 时抛。
**Resolution**: ✅ fixed in 444e6ae7f — 先验 `typeof === 'object'` 再用 `'in'`。注：原本就被 handler 外层 try/catch 兜住（返回 INTERNAL_ERROR，不会崩进程），故降级为 MED 加固。

#### 🟡 F5 (LOW→fix) — BudgetSettings 允许无意义/倒置配置
**Finding**: maxBudget 可存 0；blockThreshold 可低于 warningThreshold（语义倒置：先 block 后 warn）。
**Resolution**: ✅ fixed in 444e6ae7f — `sanitizeBudgetForm`：maxBudget≥0.01、blockThreshold≥warningThreshold、resetPeriodHours≥1，保存前清洗并回填。

#### 🟢 F1 (LOW) — 跳级到 blocked 时 warning 标志不一致
**Resolution**: ✅ fixed in 444e6ae7f — blocked 触发时把 warningEmitted 置 true（warning 视作已消费）。

#### 🟢 F6 (LOW) — BudgetAlertNotice toast 直接 .toFixed
**Resolution**: ✅ fixed in 444e6ae7f — safeNum 守卫，畸形 IPC payload 不崩 handler。

#### ℹ️ False positives / by-design（验证后不修）
- **"maybeEmitAlert→checkBudget→checkPeriodReset 丢 usage"**：假阳性。recordUsage 顶部先 checkPeriodReset 再 push，checkPeriodReset 幂等（同一 tick 不会二次 reset），usage 不丢。Codex 只看 diff 未看到 recordUsage 全貌。
- **"maxBudget=0 除零 Infinity"**：checkBudget 已有 `maxBudget > 0 ? cost/max : 0` 守卫。Codex 只看 diff 未看到。F5 仍补了 UI 端 min 守卫（0 配置无用）。
- **禁用态 Save 持久化 stale 字段**：by-design，settings 表单常态。
- **listener 注册失败 warn 续跑**：by-design，toast 是非关键特性，不应 fail-loud 阻断启动。

### Round 2

#### 🟡 R2-1 (MED) — 我的 F2 修复引入回归：告警 spam
**Finding**: updateConfig 改成每次都 re-arm，包括启动 hydrate / 原样保存 / no-op payload 这类 benign 重载 —— 已在告警态时会让下次 recordUsage 重复弹同一告警。
**Resolution**: ✅ fixed in 58a554a25 — 仅当告警边界字段（enabled/maxBudget/warningThreshold/blockThreshold）**实际变化**时才 re-arm。**Codex caught a regression I introduced in round 1.**

### Round 3

**converged — no findings.** Codex 确认 boundaryChanged 覆盖了直接影响告警边界的字段，方向性用例（升/降阈值、禁用/启用）均正确，无 float-compare 隐患，silentThreshold/resetPeriodHours 不参与 warning/block 发射故无需纳入。

## Convergence Analysis

3 轮单调收敛（7→1→0）。最有价值的两个发现都是 Codex 抓到我看不见的：F2（我漏了 updateConfig 的 stale flag）和 R2-1（我 F2 修复**本身**引入的 spam 回归——典型的"修一处带出新洞"，正是对抗式审计的价值）。其余多为防御性加固（自家数据源风险低，但便宜）。0 假 HIGH。所有 fix 走 TDD（7 个新测试先行）。

## 本次审计产生的 fix commit
- `444e6ae7f` — round 1 hardening（6 findings）
- `58a554a25` — round 2 hardening（1 regression）
