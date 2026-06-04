# 2026-06-03 ~ 06-04 多 Agent 协作层 + 项目空间 + 角色产品化批次 Spec（as-built）

> 状态: accepted
> 时间窗: 2026-06-03 ~ 2026-06-04
> 依据: [swarm-goal 设计](../designs/swarm-goal.md)、[project-space 设计](../designs/project-space.md)、[role-proactivity 设计](../designs/role-proactivity.md)、[locality-feedback 设计](../designs/locality-feedback.md)
> 关联架构: [multiagent-system.md](../architecture/multiagent-system.md)、[ipc-channels.md](../architecture/ipc-channels.md)、[tool-system.md](../architecture/tool-system.md)、[frontend.md](../architecture/frontend.md)、[native-app-integration.md](../architecture/native-app-integration.md)、[MCP_SERVER.md](../MCP_SERVER.md)

## 目标

这一批次承接 [auto-mode/settings 批次](./2026-06-03-auto-mode-and-settings-batch.md)，把 Agent Neo 从"会话级编程助手"推进到"项目级人机协作产品"，围绕五条主线：

1. **多 Agent 协作从能跑到可控可见**：goal 模式接入 swarm 并行执行（P4）；spawn 加结构化失败码 + 深度截断 + 孤儿回收（swarm-guardrails P1-2/P1-4）；协作过程出讨论流可见（P1-3）。
2. **角色从被动工具到主动协作者**：角色按 cadence / 长任务事件醒来，查自己的产物历史，自主 advance/report/suggest/silence（role-proactivity P0-1 下半），出厂默认 silent。
3. **会话级组织升到项目级容器**：projects / project_goals / project_roles 三表 + 隐式归桶 + 跨 session 产物聚合（project-space P0-2）。
4. **定点反馈闭环**：用户对渲染产物（网页元素 / PPT 页 / 表格单元格）点选→局部反馈→模型局部改（locality-feedback）。
5. **能力产品化 + 只读外露**：内置角色/技能按产物分类可视化分组（P2-1/P2-2）；只读任务状态 MCP server 把任务/项目元数据暴露给外部编排器（P3-A），守住"本地隐私"边界。

## 非目标

- swarm goal 不做子级 DAG / 子级独立闸（拆解委托给编排脚本，三层闸只在总体层；P4.2+ 再做）。
- 角色主动性 P0-2 不接外部渠道（飞书等），只走 session 消息 + history append + （realtime）Electron Notification；UI 设置面板本批次只露主动等级开关，细粒度配置先手改 settings.json。
- project-space 不动 P4 的 `GoalContract` / `GoalRunInput`，只用单向只读投影 `projectGoalToRunInput()`；1:N project↔workspace 留后续。
- locality-feedback Phase 2/3（PPT/表格）不扩 `ConversationEnvelope` 字段，锚点编码进消息文本前缀；依赖 P0-2 的 `WorkspacePreviewPanel` 挂载点。
- P3-A 只读，不暴露 prompt / 输出 / 文件路径 / goal 指令 / 项目描述等正文；`includeContent` 默认 false。

## 变更映射

### 1. 角色主动性（role-proactivity，P0-1 下半）

| 主题 | 关键 commit | 关键文件 |
|------|------------|----------|
| 8 步 wakeRole 循环（cadence + event 双触发） | b45adf0b0、a06f767e1 | services/roleAssets/roleProactivity.ts、agent/runtime/runFinalizer.ts、agent/subagentExecutor.ts |
| 醒来循环 + event 触发链确定性单测（14 条）+ 守卫顺序修复 | 7a692dda1 | services/roleAssets/roleProactivity.ts |
| 出厂默认改为 silent（opt-in，决策修订） | 512ddca0a | shared/constants/memory.ts（`ROLE_PROACTIVITY.DEFAULT_LEVEL='silent'`） |
| 角色面板加主动等级开关（设置页可视化开启/关闭） | baaff02bf | renderer/.../settings/tabs/RolesTab.tsx |

### 2. Swarm goal + 主动性合流（swarm-goal，P4）

| 主题 | 关键 commit | 关键文件 |
|------|------------|----------|
| `GoalContract.allowSwarm` + SWARM_GOAL 常量 | c5fb72fb6 | agent/goalModeController.ts、shared/contract/appService.ts、shared/constants/agent.ts |
| goal 内 swarm 执行接线 + 预算双向打通 | b14b11866 | agent/runtime/contextAssembly/deferredToolPreload.ts、toolExecutionEngine.ts |
| 主动性 advance → 单 agent goal run 合流（allowSwarm=false 强制） | 4ffad0ebc | services/roleAssets/roleProactivity.ts、agent/goalModeController.ts |
| E2E 验收脚本 + 工具预加载门控集成测试 | c8e91b523、7910f1a4c | scripts/acceptance/、tests/ |
| 闸2 软评审 / delivery critic 模型可用性降级链 | 9d4d56d0e、0728ee251 | agent/goalModeController.ts、critic 链路 |
| 渲染器实时点击流 E2E（met + aborted）+ SdkTask 死条目清理 | c96ee5ff2、289763c0d | tests/e2e/、agent/runtime/tools |

### 3. Swarm 执行层护栏（swarm-guardrails，P1-2/P1-4）

| 主题 | 关键 commit | 关键文件 |
|------|------------|----------|
| 结构化失败码 `depth-limit`/`child-refusal`/`child-max-tokens` + 路由策略 | 394851ac9 | shared/contract/cancellation.ts、agent/subagentExecutorTypes.ts |
| spawn 嵌套深度截断 + depth-limit prompt（`SPAWN_GUARD.MAX_DEPTH=1`/`MAX_AGENTS=6`） | 249410564 | agent/multiagentTools/spawnAgent.ts、shared/constants/agent.ts |
| SharedContext 版本戳 + `isStale` 新鲜度判定 | 01d65c715 | agent/parallelAgentCoordinator.ts |
| Agent Inbox 桥接统一查询入口（非破坏 peek） | 6f558614c | agent/agentInbox.ts、agent/spawnGuard.ts |
| 孤儿回收父探活（后台 detached 子代理，`parent-gone`） | 181a2b3ab | agent/orphanLiveness.ts、agent/subagentExecutor.ts |

### 4. Swarm 协作可见性（swarm-visibility，P1-3）

| 主题 | 关键 commit | 关键文件 |
|------|------------|----------|
| 讨论流（发现/决策/人话状态）+ 时间线 UI | c4097c086 | shared/contract/swarm.ts、agent/swarmEventPublisher.ts、agent/multiagentTools/statusReport.ts、renderer/components/features/swarm/DiscussionStream.tsx、SwarmInlineMonitor.tsx、stores/swarmStore.ts |

### 5. 项目空间容器（project-space，P0-2）

| 主题 | 关键 commit | 关键文件 |
|------|------------|----------|
| DB 层 projects / project_goals / project_roles 三表 + sessions.project_id 迁移 | 730a48157 | services/core/database/schema.ts、ProjectRepository.ts |
| ProjectService + 接线（隐式归桶 + 启动迁移） | 6c1ccd313、1ca6a302b | services/.../projectService.ts |
| `domain:project` IPC 处理器（桌面原生 + HTTP 双路） | 42ae0af1d | project.ipc.ts、web/routes |
| 跨 session 产物聚合后端（`getProjectArtifacts`/`buildProjectArtifacts`） | 0f1e8fc81 | services/.../projectService.ts、renderer/utils/workspacePreview.ts |
| 前端项目 header（D5/D6）+ artifacts 端点 smoke + as-built 回填 | 8c7cc4ee8、aeda15089、654dfdf0c | renderer/.../ProjectHeaderBar.tsx |

### 6. 定点反馈（locality-feedback，Phase 1-3）

| 主题 | 关键 commit | 关键文件 |
|------|------------|----------|
| Layer A 编排地基 — 注入 `<live_preview_selection>` 块 + 选区注入单测 | 3a5a59a2b、8d750a97a | main/app/workbenchTurnContext.ts |
| Layer B 网页反馈 UI — 选中条内联留言框 | 9c7a5700d | renderer/.../LivePreview/LivePreviewFrame.tsx |
| 可复用定点反馈栏 + 锚点消息构造器（PPT/表格共用） | fdc2316d9 | renderer/.../LivePreview |
| PPT 定点反馈接入 DesignPptPreview | be43de502 | renderer/.../DesignPptPreview |
| 表格单元格定点反馈 — SpreadsheetBlock 加 cell 点击 + filePath | aaeb1c9a7、335c204cd | renderer/.../SpreadsheetBlock |
| 真模型 E2E（选区注入→mimo→visual_edit/ppt_edit/excel_edit→改文件） | dbb5ce9d9、f181f39ac、0e23f5e10 | scripts/acceptance/、tests/ |

### 7. 能力产品化 + 只读 MCP（P2 / P3-A）

| 主题 | 关键 commit | 关键文件 |
|------|------------|----------|
| P2-1 角色视觉产品化（icon + 产物分类分组） | 3a658da6b | services/roleAssets/builtinRoles.ts、renderer/.../RoleIcon.tsx、settings/tabs/RolesTab.tsx |
| P2-2 已安装内置 Skills 按产物分类二次分组（复用 `SkillCategory`） | b082e8f36 | services/skills/builtinSkills.ts、settings/tabs/SkillsInstalledTab.tsx |
| 能力产品化 UI 挂载验收（P2-1/P2-2 E2E） | f6ee4b7e0 | tests/e2e/ |
| P3-A 只读任务状态 MCP server（`neo_list_tasks`/`neo_get_task_status`/`neo_list_projects`） | 92f9fd610 | main/mcp/taskStatusProvider.ts、mcpServer.ts、logBridge.ts |
| webServer 路径启动 logBridge + 注册 P3-A（修发行版 web/main 路径分离） | 167c6b587 | web/webServer.ts、app/initBackgroundServices.ts |

### 8. 收尾 fix

| 主题 | 关键 commit | 关键文件 |
|------|------------|----------|
| release 发版流水线修复 + 加 renderer 冒烟闸 | 184700515 | CI / release 脚本 |
| 产物中心校验稳定化 | cf030083c | product center validation |

（文件路径省略 `src/main/` / `src/` 前缀。）

## 核心合同

### 多 Agent 协作

1. **goal 内 swarm 是可选能力**：`GoalContract.allowSwarm`（默认 true，advance→goal 路径强制 false）。开启时按 dynamic-workflow（scriptRuntime）做编排基底，复用 BudgetTracker / ConcurrencyGate / SerialWriteGate，不引入新并行运行时。
2. **三层闸只在总体层**：goal 的闸1/2/3 语义不变，子任务校验交给脚本的 verification 阶段；不做子级 DAG / 子级闸。
3. **预算双向打通**：swarm 子运行 token 通过 `ToolResult.metadata.tokensSpent` 上报，回灌 goal 预算；`SWARM_GOAL` 常量约束总预算分数与 advance 预算（200k token / 30 turn）。
4. **spawn 结构化失败语义**：嵌套深度 `SPAWN_GUARD.MAX_DEPTH=1`、并发 `MAX_AGENTS=6`；越界返回 NON_CASCADE 失败码 `depth-limit`/`child-refusal`/`child-max-tokens`，由 `routeFailureCode()` 路由为 throw/degrade/retry/surface，单个子代理失败不波及兄弟（延续取消级联契约）。
5. **孤儿回收**：后台 detached 子代理每轮迭代探活父 run（`isParentRunAlive`），父已不在则自 abort（`parent-gone`），属结构化并发回收，非 heartbeat。
6. **Inbox 桥接非破坏**：`peekUnifiedInbox()` 只读统一查询，不碰 write/drain 路径。
7. **协作可见**：`SwarmContextUpdate`（kind = `finding`/`decision`/`status`/`result` + role + at 时间戳）经 `swarm:context:update` 事件喂给 `DiscussionStream`，收起态显近 3 条、展开全时间线，决策高亮。

### 角色主动性

1. **触发双入口**：cadence（启动注册 per-role cron，幂等 tag `role-cadence`）+ event（长任务 Stop hook，turn≥5 且未超日配额）。
2. **四选一决策**：醒来后解析 `<decision>advance|report|suggest|silence</decision>`；silence 归档会话（默认列表过滤），非 silence 推 `SESSION_LIST_UPDATED` + （realtime）Electron Notification。
3. **硬预算**：每次醒来 15 turn、每角色每天 4 次醒来（cadence + event 合并计数），防 token burn 和会话列表污染。
4. **配置分层**：角色 frontmatter `proactivity-level` > `settings.roleAssets.proactivity.defaultLevel` > 常量；`RoleProactivityLevel = silent|daily|realtime`，**出厂默认 silent（opt-in）**。
5. **范围自限**：只查角色自己参与的产物历史（P0-2 后升项目维度）；醒来会话标 `origin=role-cadence`，Stop hook 跳过此类会话防递归。

### 项目空间

1. **三表 + 一迁移**：`projects`（`proj_<nanoid>`，workspace_path/workspace_key/status）、`project_goals`（多 goal，status active→met/aborted/archived）、`project_roles`（join）；`sessions` 增可空 `project_id` 幂等回填。
2. **1:1 workspace 绑定 + 隐式归桶**：首个 session 懒创建项目，存量按 workspace hash 幂等归桶，未映射进 `proj_unsorted`。
3. **双路 IPC**：`domain:project` 处理器同时服务桌面原生与 HTTP，不另起 express 路由。
4. **P4 边界**：`projectGoalToRunInput()` 单向只读投影到既有 `visual_edit`/`ppt_edit`/`excel_edit` 入口，零改 `GoalContract`/`GoalRunInput`。
5. **产物聚合升级**：Workspace Preview 升项目维度，`buildProjectArtifacts()` 跨 session 去重排序，不新增整页。

### 定点反馈

1. **两层分离**：Layer A（编排地基）在 `workbenchTurnContext.ts` 注入 `<live_preview_selection>` 结构块，模型自判路由（system prompt 驱动，非前端硬绑）；Layer B（每面 UI）按产物类型各自加点选→反馈入口。
2. **零扩 envelope**：Phase 1（网页）复用既有 `livePreviewSelection`（file/line/column + tag/text/rect）；Phase 2/3（PPT/表格）锚点编码进消息文本前缀（如 `[针对 deck.pptx 第 3 页]`），保持 envelope 合同不变。
3. **模型自路由**：模型见选区块后自选 `visual_edit(file,line)` / `ppt_edit(slide_index)` / `excel_edit(cell)`。

### 只读 MCP（P3-A）

1. **三只读工具**：`neo_list_tasks`（swarm run + 活跃 session 元数据）、`neo_get_task_status`（按 runId 聚合 agent 数/token/时长/`failureCategory` 枚举）、`neo_list_projects`（项目 + goal 状态计数）。
2. **隐私基线**：`includeContent` 默认 false，只出状态枚举 / 进度计数 / token-cost / 时间戳 / `filesChangedCount`（计数不出路径）；绝不出 prompt / 输出正文 / 事件 message / 文件路径 / goal 指令 / 项目描述。
3. **桥接模式**：`TaskStatusProvider` 接口由 app 进程启动时注册具体实现；web 路径（发行版 `dist/web/webServer.cjs`）与 main/Electron 路径双注册且幂等——本批次修复的正是 web 路径漏启 logBridge 导致只读 server 在发行版不可用。

### 能力产品化（P2）

1. **复用既有 `SkillCategory` 七分类**，不造新 `SkillBundle` 类型。
2. **视觉元数据只挂内置**：内置角色（如 研究员→`Microscope`/research、数据分析师→`BarChart3`/data-analysis）和 17 个内置技能一次性回填 icon + category；自定义角色/技能无元数据时回落默认头像 + "其他"组。

## 验证

- 全部变更合入 main 后全量 vitest + typecheck 通过（GUI smoke 已隔离）；release 流水线加 renderer 冒烟闸。
- role-proactivity：AC1-AC4 确定性 + 真模型 E2E PASS，AC5（event 全链 E2E）受模型 spawn 行为方差影响，以胶水逻辑单测覆盖（`recordRoleParticipation` 过滤 / `runFinalizer` hook 调用确认）。
- swarm-goal：AC1-AC5 E2E，AC4 真模型链路属模型行为非代码缺陷；advance→goal 确定性单测 + 工具预加载门控集成测试。
- project-space：14 场景 E2E（隐式归桶 / 1:1 绑定 / 详情聚合 / 多 goal 独立 / 角色入驻 / 归档重命名往返 / meta.json projectId 摄入）+ ProjectRepository 9 单测。
- locality-feedback：Phase 1-3 真模型 E2E（选区注入→改对应文件）+ Layer A 选区注入单测。
- swarm-guardrails：cancellation 契约 + agentInbox + orphanLiveness + spawnAgent depthGuard + spawnGuard 单测全绿。
- P3-A：taskStatusProvider 单测 + taskStatusBridge 集成测试；web 路径 logBridge 启动经发行版路径验证。
