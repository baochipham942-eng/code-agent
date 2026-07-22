# 专家、资料库与角色化自动化

这三项共用一套“持久搭档”边界：角色提供可复用身份和 L1 资料架，项目资料库保留可检索的产物与引用，自动化在运行时选择该角色并把产出回收进资料库。

## 专家角色包与 L1 资料架

内置专家由 `BuiltinRoleDefinition` 分发；视觉投影使用 `BuiltinRoleVisual`，复用产品类目。当前内置包为牧之、溯真、青禾、明镜。安装时写入用户角色定义与角色资产骨架，已有用户定义不覆盖。

内置包和“在册角色”不是同一概念。`validateBuiltinRolePack()` 对内置包执行硬校验，frontmatter 的 skill 只能引用内置、可解析的 skill；可解析的持久角色集合同时包含内置和用户创建角色，不能倒推其具有内置 skill 资格。

角色上下文分两层：L0 是 agent 定义的人格与工具边界；L1 是 `roles/<roleId>/` 下的记忆、履历和 `bindings.json`。`ExpertContextBinding` 可绑定 file、folder 或 `library_item`，并记录 `always/on_demand` 与 `private/project` 作用域。`buildRoleContextBlock()` 将该角色的资产索引组装进角色块，按角色隔离。

侧栏和 `ExpertPanel` 共享“请 TA 来”入口。`inviteExpert()` 新建会话后先写入 per-session 角色绑定，再写可选开场 prompt，避免同步 effect 尚未落盘时按默认角色启动。

锚点：`src/host/services/roleAssets/builtinRoles.ts`、`src/shared/contract/roleAssets.ts`、`src/host/services/roleAssets/roleAssetService.ts`、`src/renderer/components/features/expert/ExpertPanel.tsx`、`src/renderer/utils/inviteExpert.ts`。

## 项目资料库与会话 pin

资料库条目存于 SQLite `library_items`，由 `LibraryRepository` / `LibraryService` 管理，并通过 `domain:library` IPC 暴露条目、导入、归档和 pin 操作。项目资料库可以登记上传、产物、采集或外部引用；导入文件写入资料库目录，归档文本写入项目资料库文件并以内容哈希去重。

会话 pin 存在 `session_context_pins`，一会话一行并保存条目 ID 列表。`contextAssembly/libraryPins.ts` 只把标题、种类、路径、摘要与标签注入 prompt；正文须按需用读取工具取得。pin 的时间和 ID 列表组成动态 prompt cache key 的指纹，pin 变更会重建缓存。

产物和资产抽屉由 `WorkspacePreviewPanel` 承载，交付卡 `DeliverableCardList` 提供归档入口。库内写入和按路径去重共享 `normalizePathOrUri()`：URI 保持原样，文件路径展开 `~` 后转为绝对路径，保证读写口径一致。归档成功后，交付卡在有工作目录和摘要时异步写入一条项目记忆；写入失败不打断归档。

锚点：`src/host/services/core/repositories/LibraryRepository.ts`、`src/host/services/library/libraryService.ts`、`src/host/agent/runtime/contextAssembly/libraryPins.ts`、`src/renderer/components/WorkspacePreviewPanel.tsx`、`src/renderer/components/features/chat/MessageBubble/DeliverableCardList.tsx`、`src/shared/ipc/domains.ts`。

## 自动化以角色身份运行

`session_automations` 记录 cron、heartbeat、loop 与角色唤醒等自动化的来源会话、调度状态和结果会话。创建流可选择角色与归档；执行时 `buildCronAgentRunOptions()` 解析角色 L1 块，并以 `agentOverrideId` 与 `turnSystemContext` 注入正常 agent 轮。角色不可解析时记录告警并降级默认 agent，避免自动化整体中断。

自动化的文本产出可由 `LibraryService.archiveText()` 归档到项目资料库，并保留 `sourceSessionId` 与 `sourceRoleId` 追溯来源。

锚点：`src/host/services/sessionAutomation/sessionAutomationService.ts`、`src/host/cron/cronAgentRoleContext.ts`、`src/host/cron/cronService.ts`、`src/renderer/components/features/cron/CronSimpleCreate.tsx`、`src/host/services/library/libraryService.ts`。
