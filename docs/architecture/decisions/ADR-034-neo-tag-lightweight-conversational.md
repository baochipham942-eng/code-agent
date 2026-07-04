# ADR-034 — Neo Tag 轻量化重设计（@neo 直接开干 + 内联清单 + topic 目录）

- 状态: accepted
- 日期: 2026-07-01
- 相关: ADR-031（运行时安全护栏，保留）、`neoTagRuntimeService`、`tag.ts` 契约、`NeoWorkCardInlineCard`、`projectCollaboration/*`、[[feedback_agent_neo_is_cowork_product]]
- 触发: v0.23.0 dogfood 暴露「现在的 @neo 实现太重」；对齐 Claude Tag「tag 只是入口、无缝嵌入聊天、像同事一样直接开干」。

## 背景：审批工作卡模型与 cowork 定位错配

v0.23.0 的 @neo 是一张**重工作卡**：`@neo` → 建 draft → 弹「任务摘要 / 读取范围 / 写入范围 / 模型 / 审批」表单 → 人点批准（draft → needs_review → approved → queued → working → in_result_review）→ 人接受结果。这套「人逐任务批预算 + 事后逐卡复核」的审批语义，和 Agent Neo「像同事一样被 tag 进对话、直接开干」的 cowork 定位打架：

- 入口重：动手前有审批 / scope 表单 / 模型选择三道门。
- 进度与答案脱节：工作卡是独立 trace 节点，运行结果在卡里复述一遍（dogfood #5）；运行态只有卡上 spinner，看不出在跑（dogfood #4b）。
- 左下 tag 菜单是绑死审批模型的重仪表盘（status 分组 / 决策 / 上下文审计 / 读写范围）。

## 决策：减重成「直接开干 + 内联清单 + topic 目录」，权限下沉为项目级 ambient

1. **@neo 直接开干，无审批门**：提及即「建卡 → 自动批准（reviewer = 发起人本人）→ 落地运行」一步完成（`createAndRunNeoWorkCard`）。用户不再看到审批按钮，卡直接进入运行态。
2. **进度 = thread 内联勾选清单**：`NeoWorkCardInlineCard` 从重卡减重为融进对话的轻量条——`delta.completed` → ✓、运行中 → ⏳，四相收敛为 `运行中 / 待你确认 / 已完成 / 失败`（+ 已结束）。dogfood #4b/#5 在无独立重卡的模型下自动消失。
3. **权限项目级 ambient**：删逐任务 readScope/writeScope 语义门。文件写权限走**全局 permission mode**（composer「全权限运行」开关，`setPermissionMode` 已推 host 全局），@neo run 在同 session 自动继承。**ADR-031 运行时护栏保留且本就 ambient**：它按 `neoTag` 上下文 fail-closed 阻断非文件类状态突变（git push / MemoryWrite / MCP / 多 agent），对文件写零影响；护栏 ≠ 审批卡，减重后照常生效。
4. **左下 tag 菜单 = topic 目录**：`ProjectCollaboration` 从审批仪表盘重写为扁平 topic 列表（标题 / 相位 / **发起人** / 最近活动）+ 轻详情（对话与执行步骤 / 内联清单 / 产物 / 记忆候选）。

## 四相运行态映射（共享真源）

11 个内部 work card 状态收敛成 5 个用户相位（`src/renderer/components/features/chat/neoWorkCardPhase.ts`，卡片 / topic 列表 / 详情 / sidebar badge 共用）：

| 相位 | 内部状态 |
|---|---|
| running（运行中） | draft / needs_review / approved / queued / working |
| needs_input（待你确认） | waiting_for_user |
| done（已完成） | in_result_review / completed |
| failed（失败） | failed |
| closed（已结束） | cancelled / archived |

审批态（draft/needs_review/approved）在直接开干下只是运行前的瞬态，统一显示为「运行中」，用户无感。

## 迁移 / 兼容：非破坏（no-op migration）

直接开干**复用**既有 `createDraft` + `approveRevision` + `launchApprovedNeoWorkCard`，只是把审批从「人工闸」变成「自动无操作」。因此：

- `work_cards / revisions / approvals / deltas / result_reviews / memory_candidates` 六张表**结构不变、仍被写入**，老数据与新数据完全兼容。
- 老 v0.23.0 work_cards 通过四相映射直接渲染进 topic 目录，**无需数据迁移脚本、无破坏性 schema 变更**。
- `tag.ts` 契约字段**未删**（审批 / revision / scope / 逐任务 modelIntent 类型仍在，作为 vestigial 记录），故本 ADR 虽属产品级破坏性 UI 改动，但**契约与 schema 层是加法/零破坏**。

## Deferred / Open（明确不在本轮做）

- **契约 / schema / service 层的硬减重**（删除 approval/revision/scope 类型与表、把直接开干从 approveRevision 解耦成「无审批记录直跑」）：**推迟**。理由：① 对用户不可见；② 破坏性且牵动 `createAndRunNeoWorkCard` 当前对 `approveRevision` 的复用，回归风险高；③ 不该在可见价值验收（dogfood）前动。待 dogfood 确认交互形态后单独立项。
- `projectCollaborationData.ts` 里 `buildProjectCollaborationGroups` / fixture / 上下文审计构造器已随重写变为死代码（约 450 行），一并归入上面的硬减重批次清理。
- 内联清单粒度：现 runtime 只在「排队 / 完成」落 delta，逐工具步骤的 `completed` 尚未映射；「逐步 ✓」需把 agent loop 的工具事件增量落 delta，另立项。
- neo-tag surface 全量 i18n（当前与历史实现一致，硬编码中文）。

## 验证口径

分阶段 TDD，逐段独立验收：Phase 0 回退 #4b/#5 治标补丁；Phase 1 直接开干 + 内联清单；Phase 2 topic 目录。每段 typecheck + 受影响测试绿（全量 neo/tag/collab/sidebar 119 测试绿）。dogfood 走 web dev 栈（`npm run dev`，完整 node host + vite 渲染器，@neo 端到端真跑）。
