# 对抗审计报告 — design-conversational-surface phase1

**Date**: 2026-06-24
**Scope**: `d93e26f932..HEAD`（设计 Surface 会话化改造一期，5 feat/test commit + 4 fix commit）
**Starting commit**: d93e26f93（origin/main，含 ADR-026+027）
**Final commit**: 217e21ef2
**Rounds run**: 3 / 4
**Converged**: ✅ yes（HIGH 趋势 2→2→0）
**审计方式**: codex 三连 flaky（exit 0 但 stdout 截断，仅旁白）→ 按既定 fallback 改用独立 context 反方 subagent（每轮全新 context，未读实现 narrative）。codex 旁白已嗅到正确边界（"boundary between new session state and old global canvas state"）。

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     |  1   |  3  |  4  | a6a6b336b（H1）+ 698de0c49（M1/M2/M3）|
| 2     |  1   |  1  |  2  | e2749a53b（H2-R2）+ 217e21ef2（M1-R2 含 L1/L2-R2）|
| 3     |  0   |  0  |  0  | — converged |

## 根因主线
本刀把设计画布从「全局 design 模式」改成「per-session 设计会话」，但 `useDesignCanvasStore` 仍是**全局单例**（runDir=`run-${Date.now()}`，与 sessionId 无关联），`switchSession` 不重载它。per-session 激活标记盖不住会话无关的全局画布 → 跨会话隔离不变量破裂。三轮把这个不变量从读、写、生命周期三个面补齐。

## Findings by Round

### Round 1
#### 🔴 HIGH — 跨会话画布**读**泄漏
**Finding**: 注入闸只验 `isSessionDesignActive(currentSessionId)` + 画布非空。会话 A 设计激活、全局画布载 A 的节点；切到同样设计激活的会话 B → `withCanvasSnapshotContext` 放行 → 把 A 的画布快照注入 B 的 agent 上下文。
**Resolution**: ✅ fixed a6a6b336b。画布 store 加 `ownerSessionId`（运行态），`claimCanvasForSession`/`clearCanvasOwner`，注入闸加严格 `cs.ownerSessionId === sessionId`（fail-closed）。入口按钮认领属主。H1 回归测试钉死跨会话不注入。

#### 🟡 MED — M1 `designActiveSessions` 只进不出 / 删除归档不清理
**Resolution**: ✅ fixed 698de0c49。deleteSession/archiveSession 清 designActive flag + 画布属主（属主匹配才清）。

#### 🟡 MED — M2 孪生 loadCanvasDoc effect（DesignCanvasTab + DesignWorkspace 逐字复制）
**Resolution**: ✅ fixed 698de0c49。抽 `useRestoreCanvasFromDisk` 共享 hook，两处共用。

#### 🟡 MED — M3 `data-testid="design-canvas"` 双挂载 DOM 重复
**Resolution**: ✅ fixed 698de0c49。DesignCanvasTab 容器加 `design-canvas-tab` testid，E2E 改在该容器内查 canvas，去脆弱 `.first()`。

#### 🟢 LOW
- L1 入口可发现性（按钮仅在 workbench 面板已展开时可见）→ 二期布局收口给设计一等入口。
- L2 markSessionDesignActive 后无回退 UI → 二期。
- L3 E2E 未测 disabled 态（理由合理，记录）。
- L4 注入闸注释误导 → 随 H1 一并修正。

### Round 2（symmetric application — 后轮第一优先级命中）
#### 🔴 HIGH — H2-R2 写路径属主缺口（读闸的对称缺口）
**Finding**: agent 改画布走 `proposeCanvasOps`/`RequestDesignAutonomy`，main 广播给单例 renderer，`useCanvasProposalReview`/`useAutonomyEnvelopeReview` 无条件应用到全局画布——会话 B 的 agent 能改/烧钱出图到会话 A 的画布。`CanvasOpProposal` 契约还没 sessionId。
**Resolution**: ✅ fixed e2749a53b。契约加 `sessionId`（向后兼容可选）；`proposeCanvasOps` 填 `ctx.sessionId`；两个 renderer 监听器设 pending 前加属主闸，跨会话 fail-closed 解阻 agent（proposal 回 reject / autonomy 回 decline，绝不静默丢弃致超时）；sessionId 缺省不拦（`ctx.sessionId` 必填无法伪造成空，读闸兜底，非可利用洞）。

#### 🟡 MED — M1-R2 claim 重置丢数据 + 刷新孤儿化
**Finding**: `ownerSessionId` 不持久化 → 刷新后 owner=null、画布从盘恢复但无主 → 再点入口走重置分支清空画布 + runDir 孤儿化、UI 找不回；手动编辑未落盘静默丢。
**Resolution**: ✅ fixed 217e21ef2。partialize 持久化 ownerSessionId；`claimCanvasForSession` 三分支（同会话 no-op / owner=null 认领保留 / 真·跨会话才重置）；跨会话重置前落盘兜底 + 清 generating/error（L2-R2）。

#### 🟢 LOW — L1-R2 遗留全屏表单 surface 不参与会话化属主语义
**Resolution**: ℹ️ 文档化 defer（spec §7）。它是表单路径（不走 agent loop、直连出图、不发 proposeCanvasOps），读注入失效与写闸都不从这触发，无害；二期退役表单时收口。
#### 🟢 LOW — L2-R2 claim 不清 generating/error → 随 M1-R2 一并修。

### Round 3
**converged — no findings.** 逐项核验：H2-R2 闸不误伤单会话 happy path；fail-open-on-missing-sessionId 不可利用（ctx.sessionId 必填）；adopt-on-null 安全（clearCanvasOwner 同时清空 nodes，刷新后 owner 已持久化非 null，owner=null+外来节点仅升级一次性迁移态、单机单用户找回自己画布、非多租户隔离威胁）；无第三条写路径（designProposedImageGen 的写全在两条已 gated 监听器内同步触发）；deleteSession/archiveSession 对称；stale persisted owner fail-closed 无损坏。

## Convergence Analysis
HIGH 在 Round 2 命中的是教科书级 symmetric application 缺口——Round 1 只补了读路径，写路径（proposal/autonomy 两条 IPC）是同一隔离不变量的另一半。教训：移植/改造一个**单例 + 全局模式**到 per-key 语义时，Round 1 就该把该单例的**所有读出点 + 所有写入点 + 生命周期清理**三类一起列出来逐个查属主，而不是只盯被直接改动的那个注入函数。adopt-on-null 这类"为修数据丢失放宽重置"的改动，Round N+1 必须反问"放宽后能不能据为己有别人的数据"——本轮已确认安全。

## 验证证据（final）
- typecheck 净；新增/更新单测全绿（owner-gate 4 文件 20 例 + sessionStore.designActive + designCanvasTab + workbenchTabsDesignEntry + proposeCanvasOps + 两个 IPC 监听器跨会话 reject/decline）；design 目录 + hooks 全量绿。
- E2E `test:e2e:design-canvas` 1/1（konva 在 design-canvas-tab 容器内非零渲染）。
- 既有 `settingsModal.screenMemory.test.ts` 一处红经 git stash 验证为基线既存、与本刀无关。
- **未做**：真模型驱动 proposeCanvasOps + 真付费出图的 dogfood（需林晨显式确认成本后单跑）。
