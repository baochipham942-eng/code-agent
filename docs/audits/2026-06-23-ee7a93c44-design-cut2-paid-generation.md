# Codex/Gemini Audit Report — design-cut2-paid-generation

**Date**: 2026-06-23
**Scope**: ADR-026 二刀（含付费生成提议），feat 起始 commit `ee7a93c44`
**Reviewer**: 独立反方 = Gemini（antigravity）。Codex(exec) 首轮 stdout 截断（已知 flakiness，只吐思考前言），按 infra 记忆 fallback 到 antigravity。
**Rounds run**: 4 / 4
**Converged**: ✅ yes（R4「converged — no findings」）

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     |  2   |  3  |  1  | `5d8767f42` |
| 2     |  0   |  2  |  1  | `1a19011fe` |
| 3     |  1   |  2  |  1  | `9b1baadf3` |
| 4     |  0   |  0  |  0  | —（收敛） |

趋势非严格单调（R3 HIGH 回潮），但属健康现象：R2 的窄修暴露出更深层的并发问题，R3 一次性把锁上移到 store 级按 requestId 闭环，R4 验证滴水不漏。

## Findings by Round

### Round 1（发散 8 维度）

#### 🔴 HIGH-1 — 单次末尾 save 丢已付费产物
**Finding**: `applyProposal` 只在末尾 `save()` 一次；Phase B 多分钟出图期间崩溃/关窗 → 已付费生成的图 + Layer1 改动全丢。
**Resolution**: ✅ 修于 `5d8767f42`。每张生成成功后增量 `safeSave()`；`safeSave` 吞 I/O 错不中断付费批。

#### 🔴 HIGH-2 — ensureRunDir 在 try 外抛错挂死 agent
**Finding**: `generateProposedImage` 的 `ensureRunDir()`（→ resolveDesignDir/createFolder IPC 可抛）在 try/catch 外；抛错→生成函数 reject→控制器循环未捕获→`respond()` 永不调用→agent 挂到超时。
**Resolution**: ✅ 修于 `5d8767f42`。整个函数体包 try（任何抛错收敛 `{ok:false}`）+ 控制器循环 per-op try/catch（单张抛错不拖垮整批、不吞 respond）。

#### 🟡 MED-1 — 付费期间画布不锁，手动编辑被收尾 clearHistory 误清
**Finding**: 提议生成路径不设忙态；用户中途手动编辑，生成毕 `clearEditHistory()` 连带清掉其 undo。
**Resolution**: ✅ 修于 `5d8767f42`（控制器 `setBusy` 包 Phase B + DesignCanvas 忙态遮罩拦 konva 指针），R2/R3 进一步收窄到 `applying`。

#### 🟡 MED-3 — 孤儿提议被后点 Apply 真付费
**Finding**: agent abort/超时后 renderer 审批条不撤；用户后点 Apply → main 忽略 IPC，但 renderer **仍真付费出图**。二刀起这是付费路径，烧钱。
**Resolution**: ✅ 修于 `5d8767f42`。新增 `CANVAS_PROPOSAL_CANCEL` IPC，main 在 abort+timeout 广播，renderer 撤审批条。

#### 🟡 MED-2 — agent 不知具体哪条被否（缓办）
**Finding**: 只回聚合 appliedCount/skippedCount，不回被否 op 的具体身份；prompt 却要求「勿重提被否项」。
**Resolution**: ℹ️ Deferred。三刀 ADR 已定「聚合计数」口径，非二刀引入；做全须扩 decision 契约 + 串联，留后续。

#### 🟢 LOW-1 — ReviewBar 的 L 字典每渲染重建打穿 rows useMemo
**Resolution**: ✅ 修于 `5d8767f42`（L 进 useMemo，同文件搭车）。

### Round 2（对称应用 + 回归）

#### 🟡 MED-1 — racing CANCEL 中途撤审批条
**Finding**: 超时 CANCEL 在 Phase B 进行中撤掉审批条，但生成仍后台跑、画布仍锁，UX 困惑。
**Resolution**: ✅ 修于 `1a19011fe`（applyingRef 守卫）→ R3 升级为 store 级锁。

#### 🟡 MED-2 — 忙态遮罩 z-10 盖住刻意可点的控件（我引入的回归）
**Finding**: 遮罩 `generating` 全程覆盖，挡住未 `disabled={generating}` 的导出/编辑控件。**对称应用漏检**：表单出图路径不该被锁。
**Resolution**: ✅ 修于 `1a19011fe`（遮罩收窄到 `generating && pending`）→ R3 再收窄到 `applying`。

#### 🟢 LOW-1 — Phase A 同步抛错绕过 respond
**Resolution**: ✅ 修于 `1a19011fe`（顶层 try/catch 兜底 respond(reject) 再外抛）。

### Round 3（并发硬化）

#### 🔴 HIGH-1 — applyingRef 双击双付费 + useRef 重挂丢锁
**Finding**: apply()/reject() 自身无重入闸，React state 批处理下快速双击可双跑 Phase B → 双付费；useRef 组件级，重挂重置丢锁。
**Resolution**: ✅ 修于 `9b1baadf3`。锁上移到 `canvasProposalStore.applyingRequestId`（全局单例，跨重挂存活）；apply/reject 入口重入闸（check-then-set 间无 await，单线程原子）。

#### 🟡 MED-1 — 遮罩 generating&&pending 与表单出图串扰
**Finding**: 表单出图（generating）+ agent 后台推来 pending → 遮罩误弹挡住手动流程。
**Resolution**: ✅ 修于 `9b1baadf3`（遮罩改绑 `applying`，只有真点 Apply 才锁）。

#### 🟡 MED-2 — finally 无条件 clear 误清并发新提议
**Finding**: 第一条 apply 的 finally `clear()` 会清掉 Phase B 期间到达的新提议。
**Resolution**: ✅ 修于 `9b1baadf3`（`clearIfStill(requestId)` 仅清 requestId 匹配的自己这条，apply/reject/cancel 三处统一）。

#### 🟢 LOW-1 — respond(apply) 抛错时补发 reject 造成 desync
**Finding**: 正常 respond IPC 抛错→catch 补发 reject，但画布改动已落地，骗 agent「拒绝」=状态不一致。
**Resolution**: ✅ 修于 `9b1baadf3`（`responded` 标志，已应答不补）。

### Round 4（终轮收敛）
**converged — no findings.** 5 个核心机制（重入原子性 / 锁释放 / clearIfStill 并发 / responded 误判 / store 迁移副作用）全部独立复核通过。

## Deferred Items
- **R1 MED-2（agent 不知具体哪条被否）**：三刀 ADR 既定聚合计数口径，非二刀引入；做全须扩 `CanvasProposalDecision` 带 skipped op 描述 + 串联进 tool output，留后续刀。

## Convergence Analysis
根因贯穿 R1→R3：**长时异步付费任务 × 同步 React UI 态**的并发编排。R1/R2 逐点修（catch、save、overlay、cancel），到 R3 才认清「锁必须是 store 级单例、按 requestId 在 apply/reject/clear/cancel 每个边界校验」，一次闭环。最具教学价值的是 **R2 MED-2**（忙态遮罩这一新增 UI 自身就是回归源——symmetric application 类）与 **R3 HIGH-1**（useRef 在重挂场景的锁失效——React 并发态该进 store 而非组件 ref）。

## 测试与验证
- 405 测绿（含本次审计新增 12 测：per-op 抛错/增量落盘/setBusy 锁/cancel 广播/Phase A 兜底/respond 抛错不补发），`npm run typecheck` 净。
- **真 key 付费 dogfood✅过**（林晨授权单跑一次，¥0.14）：`webServer.cjs` + POST `/api/domain/workspace/generateDesignImage` 走二刀 `generateProposedImage` 请求形状（prompt + model `wanx-t2i` + aspectRatio + outputPath，无参考图）→ 真 wanx 返回 `success:true / actualModel:wanx2.1-t2i-turbo / costCny:0.14`，真 PNG 1024×1024 落盘。**实际成本 0.14 == 审批面板 `estimateImageCostCny` 预估**，付费前置审批的账诚实。dogfood 产物落 dev 通道（`~/.code-agent-dev/design`），未污染生产/仓库。
