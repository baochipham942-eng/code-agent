# 2026-06-05 对话式角色、会话自动化和模型设置收口 Spec（as-built）

> 状态: accepted
> 时间窗: 2026-06-05
> 依据: 本地 worktree 分支 `feat/schedule-loop-slice2`、`feat/role-creation-flow`、`feat/role-edit-flow`、`fix/role-e2e-default-provider`，以及当前 `main` 的 `fix(settings): separate provider save from default model`
> 关联架构: [agent-core.md](../architecture/agent-core.md)、[frontend.md](../architecture/frontend.md)、[data-storage.md](../architecture/data-storage.md)、[ipc-channels.md](../architecture/ipc-channels.md)

## 目标

这一批次把三个过去容易断开的产品面收成可验证的合同：

1. **会话自动化进入主聊天输入面**：`/schedule` 空参不再只报用法，改成模板 + 自定义卡片；`/loop` 能后台跑、进 task ledger、完成后提醒，并把内部轮次标成 meta，避免污染可见会话历史。
2. **角色资产支持对话式创建和修改**：用户从设置页或 slash 入口开一个建/改角色会话，模型只能起草，确认卡由用户落盘；修改已有角色只覆盖定义，保留记忆和履历。
3. **模型设置保存语义拆清楚**：保存 provider 连接配置不再顺手改全局默认模型；只有显式点击「设为默认」才写 `models.default/defaultProvider`。

## 非目标

- `/loop` 本批次不做跨 app 重启恢复。它在主进程单例内后台运行，并把生命周期镜像到 `BackgroundTaskLedger`。
- 对话式改角色不支持改名。`editingRoleId` 必须等于 `roleId`，确认后只覆盖 `agents/<roleId>.md`。
- 角色草稿不会自动入库，也不会让模型替用户确认。落盘动作只来自确认卡 IPC。
- 通知 click 行为做 best-effort。Tauri 原生通知点击回调受桌面环境限制，最低保证系统能把 app 带到前台，session 跳转尽量通过已注册回调完成。

## 变更映射

### 1. `/schedule`、`/loop` 与桌面通知

| 主题 | 关键 commit | 关键文件 |
|------|-------------|----------|
| `/loop` 后台化，生命周期镜像进 task ledger | `af8ab7a1f` | `src/main/loop/loopController.ts`、`src/shared/contract/loop.ts` |
| 定时 agent 任务完成后发系统通知 | `87036e688` | `src/main/cron/cronService.ts`、`src/main/services/infra/notificationService.ts` |
| `/schedule` 空参打开对话式创建卡片和模板库 | `d3388f374` | `ScheduleComposerCard.tsx`、`scheduleTemplates.ts`、`ChatInput/index.tsx` |
| loop meta turns 隔离，FTS 和会话列表过滤内部轮次 | `c6f4e1381` | `schema.ts`、`SessionRepository.ts`、`messageProcessor.ts`、`streamHandler.ts`、`runFinalizer.ts` |
| 通知焦点门、日期解析护栏、原生通知投递 | `a027b8410`、`7537753c4`、`8b545a8e0`、`8f735a5e1` | `notificationService.ts`、`notification.ipc.ts`、`osNotification.ts`、`src-tauri/*` |
| task rail 展示后台任务标题，避免误渲染 checklist | `015b566a4` | `taskRailPresentation.ts` |

核心合同：

- `/schedule <自然语言>` 继续走 `cron:generateFromPrompt -> createJob`。`/schedule` 空参只是打开创建卡片，模板负责拼自然语言，不新增第二套解析逻辑。
- 一次性 `at` 任务创建时必须是未来时间。过去时间和不可解析时间在 `CronService.createJob()` 阶段报错，避免用户看到创建成功但任务永远不跑。
- loop run 启动即 upsert 一条 `kind='loop'` 的后台任务，每轮同步进度，终态写 completed/failed/cancelled。自然完成和失败会入 task ledger notification，并调用系统通知；用户主动 stop 不发完成提醒。
- loop 轮次以 `historyVisibility: 'meta'` 写入运行时历史，消息和事件带 `isMeta`。`messages.is_meta`、FTS trigger、session list/count/search/sync 都过滤 meta 与 loop 内部标记，避免内部自动化轮次污染会话标题、搜索和云同步。
- 后台 loop 禁用交互工具 `AskUserQuestion/ask_user_question`。工具可见性由 `toolRunPolicy` 过滤，模型误调时注入 policy 反馈，超过 retry 上限后以 meta assistant message 收束。
- 通知从主进程 `Notification` 直发改为 main 记录 + renderer 投递。Tauri 模式使用 `@tauri-apps/plugin-notification`，Web 模式回退浏览器 Notification API。`domain:notification/getRecent` 只读暴露最近通知，供 E2E 或诊断核验。

### 2. 对话式创建和修改持久化角色

| 主题 | 关键 commit | 关键文件 |
|------|-------------|----------|
| 角色创建流程设计和 E2E 回填 | `521cd484b`、`cd7e55156` | `feat/role-edit-flow:docs/designs/role-creation-flow.md` |
| `roleDraftQueue` 草稿队列和 roles IPC draft action | `e4456d445`、`6cfadfe02` | `roleDraftQueue.ts`、`roles.ipc.ts` |
| `propose_role` 工具和 role authoring module | `95a0aba91`、`c62a7d5ec`、`dc3e5f979` | `proposeRole.ts`、`proposeRole.schema.ts` |
| 新建/修改角色内置 skill | `95a0aba91`、`c62a7d5ec` | `builtinSkills.ts` |
| 入口和确认卡 | `fbd9e6c4b`、`638b0a971`、`ac2a28027` | `RolesTab.tsx`、`RoleDraftCard.tsx`、`SlashCommandPopover.tsx`、`startCreateRoleChat.ts`、`startEditRoleChat.ts` |
| deferred-loading 下预加载 active skill allowedTools | `9cc158e46` | `deferredToolPreload.ts`、`deferredTools.ts` |
| 严格 skill 工具集，防模型绕过确认卡 | `8fb64041c`、`32834c14f` | `skillBoundaryScope.ts`、`conversationRuntime.ts`、`agentSkill.ts` |

核心合同：

- 角色等价于 `agents/<roleId>.md` 定义 + `roles/<roleId>/` 资产目录。新建角色确认后同时写 agent 定义并初始化角色记忆/履历目录。
- 草稿写入 `~/.code-agent/role-drafts/<draftId>/draft.json + agent.md`。该目录与正式 `roles/` 平级，不会被 `agentRegistry` 扫描。
- `propose_role` 只负责把模型起草的定义入队，并发出 `role_draft_pending` 事件。它是 deferred 工具，只在 `create-role/edit-role` skill 激活时通过 allowedTools 预加载。
- `create-role` 和 `edit-role` 都声明 `strictToolset: true`。严格模式把模型可见工具集收缩到 skill 的 allowedTools，隐藏 core `Edit/Write`，防止弱模型绕过 `propose_role` 直接改文件。
- 创建入口使用确定性 slash seed `/create-role`；修改入口使用 `/edit-role <roleId>`。自然语言触发不作为产品入口依赖，避免模型没有进入 skill 上下文导致 `propose_role` 不可见。
- 修改已有角色必须传 `editingRoleId`。确认时允许覆盖 `agents/<roleId>.md`，但 `ensureRoleAssetDirs()` 对已有目录幂等，角色记忆和历史不被重置。
- 确认前必须展示能力面。`RoleDraftCard` 展示 roleId、description、category、tools，并支持展开完整 system prompt。落盘前走 `scanSkillContent()` fail-closed 安全闸。

### 3. 模型设置保存语义

| 主题 | 关键 commit | 关键文件 |
|------|-------------|----------|
| provider 保存与默认模型设置拆分 | `1e3717e1c` | `ModelSettings.tsx`、`ModelSettings.helpers.tsx`、`ProviderListPanel.tsx` |
| 管理 helper 覆盖 provider-only / set-default 两条路径 | `1e3717e1c` | `modelSettings.management.test.ts` |

核心合同：

- `保存` 只写当前 provider 的连接、模型列表、高级配置和 Key 状态，调用 `buildProviderSettingsUpdate()`，不写 `models.default` 和 `models.defaultProvider`。
- `设为默认` 是独立动作，调用 `buildDefaultModelSettingsUpdate()`，显式写 `models.default/defaultProvider` 和对应 provider config。
- 保存 provider 时保留已有 secret，不把旧 `apiKey` 明文回写；用户输入新 key 时才带入 trimmed `apiKey`。
- 左侧 provider 分组从「已配置 / 未配置」调整为「已可用 / 待添加 Key」，文案对应真实条件：可用 = 有 key 或无需 key。

## 验收和证据

| 范围 | 证据 |
|------|------|
| `/schedule`、`/loop` | `tests/e2e/slash-commands.spec.ts`，`slash-schedule-*` / `slash-loop-*` 截图，`loopController.metaHistory`、`eventBatcher`、`toolRunPolicy`、`osNotification`、`taskRailPresentation` 等单元测试 |
| 角色创建/修改 | `roleDraftQueue`、`proposeRole`、`skillInvocationResolver`、`deferredToolPreload`、`skillBoundaryScope`、`conversationRuntime` 单测；角色创建设计稿 §10 记录 in-app browser E2E |
| 模型设置 | `modelSettings.management.test.ts` 覆盖 provider-only update 不改默认模型、set-default 才写默认模型 |

## 当前风险

- 当前 `main` 只包含模型设置修复；`/schedule`、`/loop`、角色创建/修改在本地 feature worktree 上。合并这些分支前，架构文档应按本 spec 引用源分支和 commit，避免把当前 main 的运行态误读为已全量具备。
- `Notification` click 回调仍受 Tauri 桌面能力限制，需要在真机发行包继续验「点通知跳 session」。
- loop 的跨重启恢复尚未实现。若后续要求 daemon 级长期运行，需要给 loop 状态增加持久化恢复协议，而不是只靠内存 map。
