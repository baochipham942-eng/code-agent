# Codex Audit Report — session-model-token-display

**Date**: 2026-07-03
**Scope**: origin/main..HEAD（三层一致性批②：会话级模型恢复断点 + token 状态栏死链）
**Starting commit**: 3896d4a50
**Rounds run**: 4 / 4
**Converged**: ✅ yes（Round 4 "converged — no findings"）

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     |  2   |  3  |  0  | af3dbd159  |
| 2     |  0   |  2  |  1  | a7f4c63b2  |
| 3     |  0   |  1  |  1  | c7a026adf  |
| 4     |  0   |  0  |  0  | —（收敛）  |

假阳性：0。Codex 在 Round 1 侦查中自行撤回过一条 adapter metadata 证据
（task ledger ≠ session metadata），未进入报告。

## Findings by Round

### Round 1（发散 8 维度）

#### 🔴 HIGH — 内存先改、持久化乱序，慢写复活旧 override
**Finding**: switchModel(A) 后紧跟 clear/switch(B) 时，A 的慢持久化可能最后落库，重启后 A 复活。
**Resolution**: ✅ fixed in af3dbd159 — modelOverridePersistence 增加 per-session promise 链
（enqueuePersistOp），persist/clear 按调用顺序串行落库，与内存写入顺序一致。

#### 🔴 HIGH — 持久化失败静默，IPC/web 仍报成功
**Finding**: persist 失败只 log，用户看到切换成功但重启后丢失。
**Resolution**: ✅ fixed in af3dbd159 — AppService.switchModel/clearModelOverride 返回
`{ persisted }`，session.ipc 与 webServer domain handler 把标志透出到响应
（web 无 DB 模式如实报 persisted:false）。UI 层消费（toast 等）为后续项。

#### 🟡 MEDIUM — metadata 整列替换 read-modify-write race
**Finding**: getSession→updateSession 之间的 await 窗口内并发 metadata 写会互相覆盖 key。
**Resolution**: ✅ fixed in af3dbd159 — SessionRepository.patchSessionMetadata：key 级
合并在单次同步 better-sqlite3 调用内完成（无 await 窗口），null 删 key、可选同调用写
model 列、无变化不写（不抖 updated_at）；持久化改走该通道，不再 getSession+updateSession。

#### 🟡 MEDIUM — /api/run 半显式 body 拼杂交配置
**Finding**: 只传 model 时会拿 override 的 provider 拼成 `zhipu/deepseek-chat`。
**Resolution**: ✅ fixed in af3dbd159 — 双缺才读 override；override 生效时两侧同取。

#### 🟡 MEDIUM — token/cost 显示口径是全局预算周期，标签写 session
**Finding**: BudgetService 是周期账本，跨会话 token 会进新会话状态栏。
**Resolution**: ✅ partial in af3dbd159 — /cost 弹层标题改「Cost (budget period)」；
与已上线的 CostDisplay（PR#302）同源同口径是本批拍板方向。CLI 版 /cost 数据源是
per-agent getCostInfo，"session" 标签正确，不对称改。per-session token 面 deferred（见下）。

### Round 2（回归/对称聚焦）

#### 🟡 MEDIUM — IPC getModelOverride 只读内存（web 路径已回灌，IPC 漏对称）
**Resolution**: ✅ fixed in a7f4c63b2 — appService.getModelOverride 内存空时同步
getDatabase().getSession + 回灌，零契约变更；contextHealth 调用方自动受益。

#### 🟡 MEDIUM — 通用 session.update 整列 metadata 写可越过 patch 通道抹掉 marker
**Resolution**: ✅ fixed in a7f4c63b2 — sessionManager.updateSession 对未显式携带
modelOverride key 的 metadata 替换注入保留合并；清除必须走 clearModelOverride。
sync/import 路径核实不受影响（sync 不带 metadata 且直连 db 层，import 走 create）。

#### 🟢 LOW — patchSessionMetadata 缺审计日志
**Resolution**: ✅ fixed in a7f4c63b2 — 补 `session_metadata_patched`（记录 patch keys）。

### Round 3（二阶回归）

#### 🟡 MEDIUM — clear 窗口内 DB fallback 复活旧 marker
**Finding**: clearModelOverride 先清内存、DB 删除在队列中时，getModelOverride 的 DB
fallback 会把陈旧 marker 回灌进内存。
**Resolution**: ✅ fixed in c7a026adf — rehydrateModelOverrideFromSession 单点加
in-flight guard（persistChains 有挂起项即跳过回灌），对称覆盖全部回灌入口。

#### 🟢 LOW — DB fallback 绕过 owner filter
**Resolution**: ✅ fixed in c7a026adf — 补 `{ userId: currentUser ?? null }`，与
sessionManager 可访问性口径一致（Round 4 复核确认非新引入语义）。

### Round 4

converged — no findings。

## Deferred Items (not fixed this cycle)

- **per-session token 用量面**：状态栏/弹层 token 与 cost 同源为全局预算周期账本
  （本批拍板方向=仿 PR#302 CostDisplay）。会话级 token 面需要 budgetService 按
  sessionId 记账或走 telemetry_sessions 聚合，独立立项。
- **modelSessionState 内存表无 owner gate**：既有架构现状（Round 4 艾克斯明确判定
  不属本批回归），多账号内存隔离属产品安全议题，另行评估。
- **marker 不随云同步**：sessions 云同步不携带 metadata 列，模型切换恢复目前是
  单机语义。跨设备恢复需同步面扩展时再议。

## LOW Findings (informational, no commit)

无（两条 LOW 均已顺手修复）。

## Convergence Analysis

四轮单调收敛（5→3→2→0）。Round 2/3 的 finding 全部是 symmetric application 与
二阶回归类：R2 抓「web 修了 IPC 没修」「专用通道建了通用通道没封口」，R3 抓
「R2 新加的 fallback 与 R1 新加的队列之间的窗口竞态」。教训与 Felix 理论一致：
**给状态新增一条持久化/恢复通道时，Round 1 就应把该状态的完整读写集合
（所有入口 × 所有生命周期阶段 × 新旧通道交叉窗口）列成矩阵逐格检查**，
而不是等对抗轮逐个抓。0 假阳性说明反方律师模式在跨重启一致性这类问题上信噪比很高。
