# Codex/Adversarial Audit Report — t3-wanx-expand-remove

**Date**: 2026-06-21
**Scope**: `605ed45b1..ddb5da3e4` (T3 wanx 扩图 expand + 去水印 remove_watermark)
**Starting commit (feature head pre-audit)**: ddb5da3e4
**Rounds run**: 2 / 4
**Converged**: ✅ yes (monotonic decrease；R2 仅剩对称缺口，已修；其余仅 deferred M1)
**Reviewer**: codex CLI 失灵（agents.sh `set -u` + CLI 截断，仅产出 preamble），降级独立 context 子 agent 当反方律师（与 T2/T4 同路径）。codex preamble 与子 agent 结论方向一致（路径信任 / Date.now id / run 切换静默返回）。

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     |  0   |  4 (M1 deferred, M2/M4 fixed, M3 记录) | 4 | b9268075e |
| 2     |  0   |  1 (对称应用，已修) | 1 | 160f33480 |

最终测试：105/105 green，typecheck 净。

## Findings by Round

### Round 1

#### 🟡 MEDIUM M1 — 路径越界：baseImagePath/outputPath 无 run 目录约束
**Finding**：`handleExpandDesignImage`/`handleRemoveWatermarkDesignImage`（workspace.ipc.ts）直接 `fsp.readFile(baseImagePath)`、`fsp.writeFile(outputPath)`，无校验路径落在设计 run 目录内。恶意/有 bug 的 renderer 调用可读任意本地文件（base64 后发往 DashScope = 外泄）或覆盖任意文件。
**Resolution**：ℹ️ **DEFERRED — 全设计图 handler 家族通病**。同样的暴露已存在于既有 `handleEditDesignImage`/`handleImportDesignImage`/`handleGenerateDesignImage`（T1 代码），本次新 handler 忠实复制了兄弟模式，**未放松**。彻底修需在所有 4–5 个 handler 加共享 `path.resolve(p).startsWith(designRoot)` 守卫——超出 T3 scope 且改动未触碰的兄弟代码。
**Why deferred**：① 非 T3 引入；② 桌面端 renderer 是第一方（非远端攻击者输入），实际风险等级低；③ 修家族级守卫应作为独立一项由林晨拍板，避免 T3 diff 膨胀进未写代码。**建议**：作为一条独立的"设计图 handler 家族路径加固"任务排期。

#### 🟡 MEDIUM M2 — 非法 direction 触发付费空调用
**Finding**：IPC 仅 `!payload.direction` 判存在；联合类型外的字符串（renderer typo / 'top' vs 'up'）为 truthy 通过 → `expandScalesForDirection` 落 default（四向 1.0）→ `expandImage` 发真 wanx 任务但扩了个寂寞 = 一次付费空调用。
**Resolution**：✅ fixed in b9268075e — IPC 边界加 direction allow-list + ratio 有限数/[1,2] 校验，非法值抛错且 `expandImage` 0 调用（测试断言）。

#### 🟡 MEDIUM M4 — buildVariantNode 缺省 id 同毫秒碰撞
**Finding**：`node-${Date.now()}` 同 tick 连续构造 → id 相同 → store 按 id 的 setChosen/discard/对比指向歧义节点（`addNode` 仅 append 不去重，不丢节点但 id 操作歧义）。
**Resolution**：✅ fixed in b9268075e（R1 仅 buildVariantNode）+ 160f33480（R2 对称补 generate/editRegion）。

#### 🟡 MEDIUM M3 — ratio 校验不对称（0/NaN 拒、>2 静默 clamp）
**Resolution**：✅ 随 M2 一并硬化 — IPC 现拒绝 NaN/<1/>2（service `clampExpandScale` 保留作非 IPC 调用方的纵深防御）。GUI slider 1–2，无回归。

#### 🟢 LOW（记录不单独改）
- L1 hook 回调无 re-entrancy 早返（GUI `disabled={generating}` 已挡）
- L2 run 切换中途已落盘的结果 PNG 成孤儿（与兄弟 generate/editRegion 对称，非腐败）
- L3 链式编辑 parentId=groupKey 锚血缘根**正确**（已验证，非 bug）
- L4 expand/removeWatermark 默认 prompt 策略 IPC 级 vs service 级，cosmetic

### Round 2（对称应用 + 回归）

#### 🟡 MEDIUM — M4 修复未对称应用到 generate/editRegion
**Finding**：id 防碰撞只落 buildVariantNode；`generate`(:168) 与 `editRegion`(:230) 仍裸 `node-${Date.now()}`。editRegion 节点与 buildVariantNode 输出同构，应直接复用。
**Resolution**：✅ fixed in 160f33480 — 抽 `nextVariantNodeId()` 三处共用；generate 走它；editRegion 改调 buildVariantNode（消重 + 继承防碰撞）。

#### 回归核验（无）
- 两处 R1 修复无回归；ratio>2 改为拒绝（原静默 clamp）= 有意硬化，GUI 不可达 >2，无真实调用方被惊到；monotonic 计数器为 renderer-only 模块全局态，SSR 不涉及；非法 direction 在 dynamic import 之前抛出（测试断言 0 付费调用）。

#### 🟢 LOW — 资产文件名 `*-${Date.now()}.png` 同形碰撞
每个 run 独立目录 + 用户手势驱动（非循环），同毫秒概率可忽略，节点 src 仍指向有效文件。不改。

## Deferred Items（本轮不修）
- **M1 路径越界**：全设计图 handler 家族通病，建议独立任务加共享 run 目录守卫。

## Convergence Analysis
R1 暴露 2 个真 actionable（M2 付费空调用 / M4 id 碰撞）+ 1 个家族级 deferred（M1）。R2 命中典型 round-N+1 对称应用缺口（M4 修复漏了 generate/editRegion 两个兄弟）——这正是 skill 强调的"修一处先查 siblings"。补齐后无新 actionable，趋势 2→1 单调收敛。0 假阳性（M1 子 agent 自己降级为 MED-with-caveat，未误报 HIGH）。教训：**节点 id / 文件名这类"唯一性"原语应一开始就抽公共源**，移植 editRegion 逻辑成 buildVariantNode 时就该把 generate 也一并收编。
