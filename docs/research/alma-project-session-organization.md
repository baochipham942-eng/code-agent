# Alma Project / Session Organization 对标研究

> 日期：2026-06-14
> 分支：`codex/alma-project-session-organization-visible`
> 范围：Project、Session、New Chat、侧栏、会话分组、项目上下文、历史恢复、长任务回流、Review/Replay/Artifacts 回到同一工作流。
> 原始边界：只做研究和方案，不改产品实现。
> 后续状态：用户追问价值和现状后，已进入第一轮实现推进，本文保留研究判断，并补充当前落地状态。

## 核心判断

Neo 的组织能力底座比当前入口表达更强。它已经有 `projectId`、ProjectService、项目目标/角色/跨会话产物、工作区分组、会话状态、workbench snapshot、跨会话搜索、Workflow/Replay/Review 的后端身份链路；用户感知层却主要停留在“按工作目录折叠的会话列表”。Project、Session、Task、Review、Replay、Artifacts 的关系没有在侧栏这个高频入口形成清楚的层级。

Alma 的优势是把 Thread 当成可持续任务单位：线程归属 workspace/project，侧栏行直接显示活动、审批、diff、收藏、标签/状态，New Chat 页和已有会话 composer 保持一致，Artifact workspace 和 thread 绑定，项目分组折叠动画服务于层级理解。它让用户从“新建任务”到“回到任务”再到“跨会话继续交付”少一次猜测。

对 Neo 的优先级判断：

1. Neo 已经有大部分项目/会话组织底座，甚至比 Alma 暴露出来的维度更完整。
2. P0 的价值是把已有能力拉回主路径：New Chat 继承项目、项目 header 状态、Review/Replay/Artifacts 回流、项目级搜索和具体 turn 跳转。
3. P1 再补体验：折叠动画、默认展开策略、命名体系、完整 drawer、状态/类型过滤。
4. 大量底层能力不用重做，后续重点是让用户一眼知道已有能力在哪里。

## 当前实现推进状态

截至 2026-06-14，本专项已经从研究进入第一轮产品实现，重点是把已有能力显性化，避免重造底层 project/session/task 系统。

已落地：

1. 顶部 New Chat 和 Conversation tab 新建默认继承当前项目/工作区；“空白会话”成为显式入口，renderer 会传 `workingDirectory: null`，main `AgentAppService.createSession` 也已按显式 null 处理为无项目上下文，不再回退到当前工作区。
2. Sidebar 搜索和状态筛选保留项目/工作区分组，不再搜索后退回全局日期列表。
3. 状态筛选从 `all/background` 扩展为 `all/unfinished/approval/running/attention/artifact/review/background`，其中未完成覆盖待确认、执行中、暂停、错误、输入不完整；用户可见文案为“交付线索”，用于找回有 workspace/write/edit/artifact/notebook 或 replay/trace 证据的会话，`review` 只在管理员视角显示，用于直接找回有 pending Review 证据的会话。
4. 项目 header 显示项目名、工作区短路径、多工作区数量、当前 active goal、未完成/待确认/执行中/待处理数量、目标数、产物数、会话数和最近活动；项目内新建和项目产物入口保持可见，长目标会截断，避免 header 被撑爆。
5. 项目组内排序优先恢复链路：待确认优先，其次执行中，再其次待处理，已完成会话按最近活动排序。
6. 会话行增加可扫读恢复线索：工作区、branch、PR、产物、最近工具、Skill/Connector/MCP 数量；有工作台上下文的会话可直接打开产物与资产。
7. 新会话空态显示当前继承上下文：项目会话展示项目/工作区名，空白会话明确标注不继承项目或工作区上下文。
8. 当前会话、搜索/筛选命中、以及有未完成会话的项目组会保持展开；普通已完成项目继续遵循用户折叠状态。
9. 项目 header 增加“项目详情”展开入口，复用 `ProjectDetail` / `ProjectArtifact` 数据，在侧栏直接露出项目状态、目标状态、最近产物、来源会话、入驻角色和项目会话数；项目详情里的最近产物可跳到来源 session，并通过 `previewItemId`、`messageId/artifactId` 或 `path` 直接选中 Workspace Preview 里的对应产物。Project artifacts 现在会聚合 assistant artifact code block、工具 previewItem、工具 outputPath 和 metadata.artifact path/url。
10. 会话行、侧栏右键菜单和当前会话动作菜单增加 admin-gated “打开 Replay”，复用 `REPLAY_GET_STRUCTURED_DATA` 读取结构化 replay，并以轻量 timeline 弹层展示 turns、模型调用、工具调用、失败工具、来源、耗时、工具分布和遥测完整性问题；当前会话动作菜单也已接入同一 session 的 workflow/background/evidence 上下文，避免从不同入口打开 Replay 时信息不一致；普通用户看到禁用态，不产生死链。
11. Sidebar 搜索接入 `SESSION_SEARCH` 的跨会话消息内容命中：搜索时默认限定当前项目/工作区，可切换到全部；本地元数据未命中但消息内容命中的会话会保留在原项目分组内，并在 row 二级信息显示“消息命中”snippet。每个会话保留最多 3 条消息级命中，主行显示最佳命中，额外命中可直接点击；命中展示包含会话 turn 编号和相对时间；点击后记录 pending search jump，切到目标会话后优先按 `messageId` 映射到现有 turn search highlight/scroll，缺少可投影 message id 时按 `turnNumber` 锁定目标轮再找 query。
12. 项目详情里的 active goal 可新建同项目会话，并通过 Project `updateGoalStatus` 写回 `lastRunSessionId`；新会话成为当前会话后会自动发送带 `GoalRunInput` 的 goal envelope，保留项目目标的 `verify` / `review` 条件，没有显式条件时补齐与 `/goal` 一致的默认软评审，并初始化 goal run 状态、goal notice 和 seed todos。
13. Project group 折叠从即时隐藏改为可测试的状态模型：普通项目进入 `expanded/collapsing/collapsed`，点击收起先淡出/轻微上移 rows，再写入持久折叠状态；当前会话、搜索/筛选命中、未完成任务所在项目进入 `forced-expanded`，即使用户之前折叠过也保持可见并显示“保持展开”。rows 进入时增加轻量 stagger，`prefers-reduced-motion` 下关闭动画。
14. Sidebar 接入已有 Artifact Issue / Admin Review Queue 数据：新增 `SESSION_LIST_REVIEW_ITEMS` IPC，管理员视角下按当前可见 session 拉取 pending review items；项目 header 统计“待审”数量，会话行显示 `N 待审` 徽标，并提供“待审”状态筛选；点击徽标回到该 session 的 Replay 证据。它复用现有 artifact issue repository 和 `sessionId/replayKey` 身份链路，不创建普通用户“加入 Review”的假入口。
15. ChatView 空会话页展示继承上下文：项目会话不仅显示 `项目会话 · <workspace>` 和完整工作区 title，还会从 session `workbenchSnapshot` 展示继承的工作台摘要、最近工具和 Skill/Connector/MCP 数量；空白会话即使外部 app workspace 存在，也明确显示“不继承项目或工作区上下文”，且不展示继承能力摘要。
16. ChatSearchBar 的“跨会话”搜索结果也复用 pending search jump：点击结果会记录 `messageId/messageIndex/turnNumber/matchOffset/query`，切换 session 后进入同一套 turn highlight/scroll 机制，不再只是打开目标会话顶部。
17. Sidebar 分组已从纯 `workingDirectory` fallback 前进到 Project-first：有真实 `projectId` 的 sessions 会合并进同一个 `project:<id>` group；没有 Project 元数据时才按完整工作区路径 fallback；同一 Project 下多工作区会在 header 显示主路径和额外工作区数量。
18. Sidebar 新建会话后的展开状态也已改为使用同一套 Project-first group key：项目会话展开 `project:<id>`，无项目会话才展开工作区路径，空白会话进入“未分类”组；测试已覆盖同一 Project 跨多个 worktree 时只渲染一个项目组。
19. Sidebar 现在会把 Workflow run 和后台任务 `outputRefs` 里的 `replay` / `trace` 识别成会话恢复证据：会话行显示独立 `Replay` hint，并在 row 内展示具体证据摘要（例如 `Workflow replay`、`Trace · trace.json`）；点击证据时，workflow replay 走结构化 Replay，本地 path 走 workspace `openPath`，http(s) link 走外链打开，opaque handle 降级复制。普通用户仍能看到 replay 证据存在，但结构化 Replay 的 hint 和证据 title 会明确说明“仅管理员可打开”；“交付线索”筛选也能把这类有交付证据的 session 找回来，但不会因为只有 replay 信号就伪造“产物”行标签。
20. “打开 Replay”弹层已从单一 turn timeline 升级为合并证据摘要：同一个 session 的 workflow runs、background tasks、replay/trace evidence 会在 `Workflow / Background` 区块展示，用户能同时看到 workflow 目标、阶段、run id、开始/结束时间、agent 状态、agent prompt/result/error 摘要、最近 workflow logs、后台任务状态、task id、更新时间、task events 和 output refs，再往下看 structured replay timeline；多 run / 多 task 会优先展示最近项，并提示还有多少 workflow run、background task 没展开。replay/trace evidence 会优先挂回对应 workflow run 或 background task 卡片，挂不到当前可见卡片的才进入“其他证据”；每个 run/task 也有聚焦入口，点击后顶部显示该执行现场的证据和关键明细，file/url/copy evidence 可直接打开或复制，不需要退回侧栏 row。侧栏 row、侧栏右键菜单和当前会话动作菜单都使用这套 session replay context。

仍未落地：

1. Review Queue 还没有直接做成普通用户评审流。当前证据显示 Review Queue contract 标注评测中心 UI 已下线，所以本轮只做管理员可见的待审证据提示和 Replay 回跳，不接“加入 Review”假入口，也不做 allow/request-changes 决策 UI；Replay 已有 admin-gated 行级入口、普通用户受限说明、轻量 timeline、Workflow/Replay 证据摘要、合并 workflow/background 摘要、agent/log/task event 下钻，多 run/task 的最近排序和溢出提示，证据归位到对应 run/task 卡片，以及 run/task 聚焦入口；聚焦后会展开 workflow agents/logs 或 background outputs/events。剩余是跨证据比较与普通用户评审面向。
2. 独立 Project detail drawer 已落成项目控制台：项目 header 保留轻量详情展开，同时新增“项目控制台”入口，drawer 内展示项目摘要、工作区、目标、角色、产物、最近会话、交付线索、Replay 数量和管理员待审数量，并能回到来源 session / Workspace Preview 或从 active goal 新建同项目 session；项目名、描述和项目状态也能在 drawer 内编辑；active goal 启动现在会自动带入 goal prompt / run 上下文；搜索结果 turn 编号已带入 pending jump，并对 runtime supplement 与 renderer projection 的 turn 归属做了对齐。浏览器真实交互手验已补，剩余未实现的是普通用户 Review 产品面向。
3. 项目控制台当前展示 active goal 文案、状态和从 goal 新建项目会话入口，但不直接露出 goal 的 `verify` / `review` 原文；这两项已经由 goal seed 单测覆盖，会随新会话 envelope 进入执行上下文。是否在控制台直接显示验收条件，属于下一轮 IA/文案取舍。

## 资料状态

给定资料里有三项在本机不可见：

| 资料 | 结果 |
|---|---|
| `/tmp/alma-update-20260613/release-notes-805-823.md` | 不存在 |
| `/tmp/alma-update-20260613/old/extract/renderer-assets/index-DZO6LH4W.js` | 不存在 |
| `/tmp/alma-update-20260613/new/extract/renderer-assets/index-lrtJ1hZ1.js` | 不存在 |

可核验资料：

| 资料 | 用途 |
|---|---|
| `/Applications/Alma.app` | `CFBundleShortVersionString = 0.0.823` |
| `/private/tmp/alma-current-extract/out/renderer/assets/index-lrtJ1hZ1.js` | Alma 0.0.823 renderer bundle |
| `/private/tmp/alma-current-extract/out/main/index.js` | Alma 0.0.823 main bundle |
| GitHub release notes | v0.0.805 - v0.0.823 的公开更新记录 |

证据标记：

| 标记 | 含义 |
|---|---|
| 实证 | release notes、bundle grep、Neo 源码直接支持 |
| 推断 | 由实证组合出的产品意图，需要交互验证或更多 bundle 还原确认 |

## Alma 证据

### Release notes

| 版本 | 证据 | 对 Project / Session Organization 的含义 |
|---|---|---|
| v0.0.823 | [GitHub release](https://github.com/yetone/alma-releases/releases/tag/v0.0.823)，发布时间 2026-06-12，说明 main process 和 database layer 响应性提升 | 会话列表、线程切换、项目侧栏这类高频导航依赖 DB/main process，性能属于组织体验的一部分 |
| v0.0.822 | [GitHub release](https://github.com/yetone/alma-releases/releases/tag/v0.0.822)，发布时间 2026-06-11，明确改 Project sidebar group animations：closing animation、two-step collapse、staggered entrance | 项目组展开/折叠被当成信息架构动作，服务于层级认知 |
| v0.0.821 | [GitHub release](https://github.com/yetone/alma-releases/releases/tag/v0.0.821)，发布时间 2026-06-11，chat composer 内集成 slash command menu，并修复 New Chat 页 slash menu 不可用 | New Chat 和已有会话 composer 的能力一致性被纳入会话组织体验 |
| v0.0.814 | [GitHub release](https://github.com/yetone/alma-releases/releases/tag/v0.0.814)，artifact cards 增加一行描述，并修复 image placeholders 只出现在正确 chat thread | 产物可扫读和产物归属 thread 是同一条体验线 |
| v0.0.807 | [GitHub release](https://github.com/yetone/alma-releases/releases/tag/v0.0.807)，设置加入 Plugins & Providers，文档强调 local-first、memory-first agent，并把 main chat model 改成 main task model | Alma 把对话模型表达为任务模型，倾向让 thread 承载任务连续性 |
| v0.0.805 | [GitHub release](https://github.com/yetone/alma-releases/releases/tag/v0.0.805)，plugin events 增加 finish reasons、response IDs、subagent didComplete hook，截断 tool output 存文件 | 跨会话回放、子任务完成、长输出恢复都有事件/文件证据基础 |

### Renderer bundle

路径：`/private/tmp/alma-current-extract/out/renderer/assets/index-lrtJ1hZ1.js`

| 证据 | 解释 |
|---|---|
| `newChatThreadManager`、`useThreads`、事件名 `thread_deleted`、`thread_created`、`thread_updated`、`thread_generating`、`title_generating`、`title_generated`、`thread_focus` | Thread 是实时可更新对象，标题生成、生成中、聚焦状态都能反映到列表 |
| `threadLabelsApiClient`、`gtdSidebarSections`、`sidebarMode` | 侧栏不止一种排序：simple / project / gtd，标签、状态分组、收藏是组织维度 |
| `useWorkspaces({ includeWorktrees: true })`、`ProjectSidebar`、`newChatThreadManager.focusThread` | Project sidebar 以 workspace/worktree 为组织单位，并在创建/切换后显式 focus thread |
| `pendingApprovalCount`、`DiffStatsBadge`、worktree PR merge badge 相关代码 | 会话行承载待审批、diff、PR/worktree 状态，用户能从列表判断任务是否需要回来 |
| `project-row-enter`、`project-row-exit`、`rowAnimDelayMs` | v0.0.822 release notes 的 stagger/two-step 动效在 bundle 中有对应实现痕迹 |
| `ArtifactWorkspaceProvider`、`initWorkspace`、`loadTerminalSessionsForThread`、`createTerminal(workspaceId, currentThreadId, name)` | Artifact/file/terminal workspace 与 thread 绑定，回到 thread 时能恢复同一工作面 |

### Main bundle

路径：`/private/tmp/alma-current-extract/out/main/index.js`

| 证据 | 解释 |
|---|---|
| `workspaces` table：`path`、`name`、`is_worktree`、`parent_workspace_id`、`worktree_branch`、`pr_number`、`pr_url`、`pr_state` | Alma workspace 不只是目录名，也承载 worktree / PR 语义 |
| `chat_threads` table：`workspace_id`、`artifact_workspace_id`、`is_generating`、`is_favorited`、`is_favorite_pinned`、`parent_thread_id`、`skill_ids`、`metadata` | Thread 直接保存工作空间、产物空间、收藏、父子关系、技能上下文 |
| `thread_labels` | 线程标签是持久组织维度 |
| `channel_mappings` | 外部 channel 到 thread 的映射支持跨入口继续同一线程 |
| CreateThread tool 描述为创建新 chat thread 并可切换用户到该 thread；实现里读取 `settings.general.defaultWorkspaceId`，否则使用 default workspace | Agent 也能主动创建/切换 thread；默认 workspace 是兜底，不等同于当前项目继承 |

### Alma 产品思路

实证支持的判断：

1. New Chat 是同一套 composer 能力的入口。v0.0.821 修的是 New Chat 页 slash menu，说明 Alma 不允许“新建任务”能力比已有会话少。
2. Project sidebar 的折叠/展开是层级导航。v0.0.822 明确投放在 Project group 动效，bundle 里也能看到 row enter/exit。
3. Thread row 要显示任务状态，不能停在标题列表。renderer bundle 有 generating、pending approval、diff stats、favorite/pin、labels/status 等痕迹。
4. Artifact workspace 跟 thread 绑定。回到 thread 就能回到同一个文件/终端/产物上下文。

推断：

1. Alma 倾向把 Thread 当成“可恢复的任务单元”，Project/Workspace 是它的归属容器。
2. 它减少路径跳转的方式是：在侧栏行里展示用户需要回来的理由，在 group 动效里维持层级感，在 New Chat 里保持能力一致。
3. 它的 default workspace 机制说明 agent-created thread 有兜底归属，但还不能由现有证据证明所有 New Chat 都继承当前 project。

## Neo 当前实现核验

### 会话侧栏

| 文件 | 事实 |
|---|---|
| `src/renderer/components/Sidebar.tsx:304` | 本地 search/filter 会匹配 session title、workingDirectory、gitBranch、status、workbench snapshot 等 |
| `src/renderer/components/Sidebar.tsx` | 当前使用 Project-first 分组：有 `projectId` 的 session 先按 Project group 合并，缺少项目元数据时才退回按 `workingDirectory` 分组 |
| `src/renderer/components/Sidebar.tsx` | 原始核验时顶部“新会话”调用 `createSession('新对话', { workingDirectory: null })`，强制进入无工作区 Chats；当前已改为默认继承当前项目/工作区，并保留显式“空白会话”入口 |
| `src/renderer/components/Sidebar.tsx:716` | session row 显示标题、类型、状态 badge、workbench summary、最近活动、未读、置顶、归档；当前已补 Replay 按钮、产物入口和管理员可见的 pending Review 徽标 |
| `src/renderer/components/Sidebar.tsx` | group header 展示项目名/路径/多工作区计数/状态计数，当前会话、搜索命中和未完成项目保持展开 |
| `src/renderer/components/Sidebar.tsx:953` | group header 可折叠，项目内新建会话按钮藏在 hover/focus 后 |
| `src/renderer/components/Sidebar.tsx` | 搜索/过滤保留项目分组；当前已把本地 session/workbench 元数据匹配和跨会话消息内容匹配合并进同一侧栏结果，并按可见 session 拉取管理员 Review issue 摘要 |
| `src/renderer/stores/sessionUIStore.ts` | 原始核验时状态过滤只有 `all` 和 `background`；当前已扩展为 `all/unfinished/approval/running/attention/artifact/review/background` |
| `src/renderer/utils/sidebarProjectSummary.ts` | 当前按 group 内 session 汇总 running、pending approval、attention、pending Review issue、artifact、goal、recent activity，用于项目 header |
| `src/renderer/stores/sessionUIStore.ts:25` | workspace 折叠状态持久化，默认展开 |
| `src/renderer/utils/workspaceGrouping.ts` | 分组键优先 `project:<projectId>`，无项目时使用完整 workingDirectory，无目录会话进入“未分类”；`getSidebarGroupKeyForSession` 同时服务分组和新建后的展开状态 |
| `src/renderer/utils/sessionPresentation.ts:53` | status presentation 能识别 background、live、approval、paused、error、done、incomplete、idle |

判断：Neo 侧栏的底层状态识别足够，原始问题是入口表现把 Project 退化成 workspace basename。当前已把分组 key 升到 Project-first，并把项目名、active goal、多工作区关系、未完成状态、Replay、Artifacts 和管理员 pending Review issue 拉回侧栏；剩余是独立 drawer、命名体系和未解决项的信息架构继续打磨。

### Session store 与 New Chat

| 文件 | 事实 |
|---|---|
| `src/renderer/stores/sessionStore.ts:301` | `createSession` 若没有传 `workingDirectory`，会继承 `useAppStore.getState().workingDirectory` |
| `src/renderer/stores/sessionStore.ts:303` | 但只要调用方显式传 `workingDirectory: null`，继承就被关闭 |
| `src/main/app/agentAppService.ts:438` | main createSession 已区分“不传 workingDirectory”和“显式传 null”：前者继承当前工作区，后者创建真正空白 session |
| `src/renderer/stores/sessionStore.ts:327` | 新会话会继承上一个外部 engine 选择，如 Codex/Claude engine |
| `src/renderer/stores/sessionStore.ts:384` | `switchSession` 会预设并最终恢复 session workingDirectory、messages、todos、sessionTasks、streamSnapshot |
| `src/renderer/components/features/chat/ConversationTabs.tsx` | 原始核验时新 tab 明确落入 Chats；当前已改为默认继承当前项目/工作区 |
| `src/renderer/components/ChatView.tsx` | 当前空会话页能区分项目会话和空白会话；项目会话展示继承工作区和 workbench snapshot 摘要，空白会话不展示项目或能力继承 |
| `src/renderer/components/features/chat/ChatInput/useChatInputSessionScope.ts:12` | 切换 session 会清空输入草稿和附件，避免跨会话污染 |

判断：Neo 本来已经具备“默认继承当前工作区”的 store 机制，但两个关键 UI 入口曾主动覆盖为 null。当前这部分已改成默认继承，并保留显式空白会话入口；剩余问题是项目上下文提示、group header 新建入口的可见性和项目详情层级。

### Session backend 与 Project backend

| 文件 | 事实 |
|---|---|
| `src/shared/contract/session.ts:81` | Session 字段包含 `workingDirectory`、`type`、`origin`、`parentSessionId`、`sourceRunId`、`engine`、`workbenchSnapshot`、`workbenchProvenance`、`streamSnapshot`、`gitBranch`、`projectId` |
| `src/main/services/infra/sessionManager.ts:269` | 创建 session 时写入 workingDirectory、type/origin、parent/source、engine、gitBranch |
| `src/main/services/infra/sessionManager.ts:289` | 新 session 创建后按 workspace 隐式归桶到 project，并写 `project_id` |
| `src/main/services/infra/sessionManager.ts:324` | 加载 session 时懒加载最近消息、todos，并构建 workbenchSnapshot |
| `src/main/services/project/projectService.ts:85` | `ensureProjectForWorkspace` 按 workspace path 拿/建 Project；无目录进入 unsorted |
| `src/main/services/project/projectService.ts:134` | Project detail 返回 project、goals、roles、sessionIds |
| `src/main/services/project/projectService.ts:147` | Project artifacts 跨该项目所有 session 抽取 assistant 产物 |
| `src/main/services/core/repositories/ProjectRepository.ts:190` | repository 有 session 与 project 关联、listProjectSessions、backfillSessions |
| `src/web/routes/sessions.ts:125` | Web API 创建 session 只接受 title/workingDirectory，交给 SessionManager |

判断：Neo 的 Project 实体真实存在，且有目标、角色、产物、会话聚合。当前 Project 已开始成为左侧导航主对象，缺口从“没有进入侧栏”变成“如何把 Project 名称、目标、状态和多工作区关系表达得更像任务容器”。

### Workbench / Task / Artifact / Search

| 文件 | 事实 |
|---|---|
| `src/shared/contract/sessionWorkspace.ts:9` | workbench snapshot 存 summary、labels、recentToolNames、primarySurface、workspaceLabel、routingMode、skillIds/connectorIds/mcpServerIds |
| `src/renderer/utils/sessionPresentation.ts:117` | session search text 会索引 workbench summary、labels、recent tools |
| `src/renderer/components/features/chat/ChatSearchBar.tsx:20` | Chat search 有 current/cross 两个 tab |
| `src/renderer/components/features/chat/ChatSearchBar.tsx:99` | cross-session search debounce 调 `SESSION_SEARCH`，当前点击结果会写入 pending search jump，再切到目标 session，复用 turn highlight/scroll |
| `src/main/session/search.ts:1` | 后端有跨 session 内容、日期、metadata、相关度排序搜索能力 |
| `src/renderer/components/TaskPanel/TaskMonitor.tsx:1` | 右侧 TaskPanel 主链路是任务、待审、产物、上下文、MCP |
| `src/renderer/components/TaskPanel/RunWorkbenchCards.tsx:192` | 当前会话任务和后台任务能在 TaskPanel 中显示 |
| `src/renderer/components/TaskPanel/RunWorkbenchCards.tsx:349` | outputRefs 支持 trace/replay/report/url/artifact 类型展示 |
| `src/renderer/components/WorkspacePreviewPanel.tsx:597` | ProjectHeaderBar 挂在 Workspace Preview 顶部，不在 Sidebar |
| `src/renderer/components/ProjectHeaderBar.tsx:254` | ProjectHeaderBar 折叠态能显示目标、角色、产物、会话数 |

判断：Task/Artifact/Search 能力都有，但从“回到项目/会话”路径看，入口散在 ChatSearchBar、TaskPanel、WorkspacePreviewPanel，侧栏只露出很小一部分 summary。

### Workflow / Review / Replay

| 文件 | 事实 |
|---|---|
| `src/renderer/stores/workflowStore.ts:1` | Workflow store 按 runId 折叠 ScriptRunSnapshot，支持 launch approval |
| `src/renderer/components/features/workflow/WorkflowLaunchCard.tsx:28` | workflow 启动审批只显示当前会话请求 |
| `src/renderer/components/features/workflow/WorkflowInlineMonitor.tsx:63` | workflow 进度树按当前 session 隔离显示 |
| `src/renderer/hooks/useRunWorkbenchModel.ts:123` | workflow snapshot 会变成 session task record，带 `Workflow replay` outputRef |
| `src/shared/contract/reviewQueue.ts:1` | Review Queue contract 只保留 trace identity，文件注释写明评测中心 UI 已下线 |
| `src/web/routes/adminReviewQueue.ts:86` | admin review queue API 可列出、写入、决策 artifact issue |
| `src/main/ipc/session.ipc.ts` | 当前新增 `SESSION_LIST_REVIEW_ITEMS`，管理员权限校验后按 sessionId 从 `ArtifactIssueRepository` 拉取 review items，供 Sidebar 项目 header 和会话行展示待审证据 |
| `src/shared/contract/reviewQueue.ts:16` | `buildSessionTraceIdentity(sessionId)` 把 replayKey 绑定为 sessionId |
| `src/main/evaluation/replayService.ts:21` | `extractStructuredReplay(sessionId)` 从 telemetry 或 transcript 构建结构化 replay |
| `src/main/ipc/telemetry.ipc.ts:82` | `GET_STRUCTURED_REPLAY` 是 admin-only IPC |
| `src/renderer/components/SessionActionsMenu.tsx:5` | 注释提到“打开 Replay / 加入 Review”；当前已接入 admin-gated “打开 Replay”轻量 timeline，侧栏 row/右键/当前会话动作菜单都能进入 Replay |
| `src/renderer/components/Sidebar.tsx` | 当前对管理员展示 pending Review 徽标、项目级待审计数和“待审”筛选，点击打开同 session Replay 证据；普通用户不出现 Review 假入口，但能看到 replay 证据存在和结构化 Replay 的管理员限制说明 |

判断：长任务和 Replay 的身份链路成立，Review Queue 也能用 `sessionId/replayKey` 追踪；Replay 已经回到侧栏 row、右键和当前会话动作菜单，并能通过同一套 session replay context 查看轻量 turn timeline、workflow/background 合并摘要、agent 摘要、最近 logs 与 task events。弹层里的 trace/replay file、URL 或 opaque handle 证据也能直接打开或复制；多 run/task 时会优先展示最近项，并把证据挂回对应 run/task 卡片，挂不到当前可见卡片的证据放进“其他证据”；run/task 可进入聚焦态查看该执行现场的证据和关键明细。当前实现进一步把 pending artifact issue 以管理员可见徽标拉回项目 header 和 session row，并让普通用户看到 replay 证据存在和受限原因；但 Review 仍是 admin/debug 证据入口，完整普通用户评审流、聚焦后的深层跨证据 drilldown 和 Review 决策面向需要另行设计。

## 差异判断

### 1. Project 与 Session 的关系

Alma：Thread 表直接有 `workspace_id`，Project sidebar 基于 workspace/worktree 分组，thread row 展示活动状态。用户在列表里能理解“这个任务属于哪个项目”。

Neo：Session 表和 contract 有 `projectId`，SessionManager 会自动归桶，ProjectService 有 goals/roles/artifacts。当前 Sidebar 已优先按 `projectId` 分组，缺少项目元数据时才 fallback 到 workingDirectory；同一 Project 下多工作区不再被拆成多个裸目录组。

差距类型：IA / 文案 / 多工作区表达为主，功能缺口较小。

### 2. New Chat 是否继承项目上下文

Alma：release notes 明确修 New Chat 页 composer 能力一致性；bundle 里 project sidebar 创建 thread 后会 focus thread。main CreateThread tool 有 default workspace 兜底，但不能证明所有入口都继承当前 project。

Neo：store 默认可继承当前 workingDirectory；原始状态下顶部 New Chat 和多会话 tab 新建显式传 null，进入 Chats。当前已改为默认继承当前项目/工作区，另保留空白会话入口。workspace group 里的 plus 可以在项目内创建，但可见性仍弱。

差距类型：默认策略 / 入口文案 / 创建路径。

### 3. 长任务、Review Queue、Replay、Artifacts 是否能回到同一工作流

Alma：thread row 有 pending approval、diff、generating、artifact workspace，用户能从 Project sidebar 回到任务状态。

Neo：TaskPanel、WorkflowInlineMonitor、ProjectHeaderBar、Replay service、Review API 分别存在；当前侧栏已经把 Replay、Artifacts 和管理员 pending Review issue 拉回 session row / project header，侧栏 row、右键菜单和当前会话动作菜单也已共享同一套 Replay 上下文，Replay 弹层能把 workflow/background、agent、logs、task events 放进同一个证据面板，能直接操作 file/url/copy evidence，并能在多 run/task 场景里先展示最近证据与溢出数量。replay/trace evidence 也已按 id 归位到对应 workflow run 或 background task 卡片，无法归位到当前可见卡片时进入“其他证据”。普通用户能看到 replay 证据和受限原因，但完整 Review 决策和普通用户评审流仍不在主路径。

差距类型：信息聚合和基础回跳动作已进入主路径；剩余主要是 Review 产品面向、普通用户评审流和点击聚焦式跨证据 drilldown 深度。

### 4. Sidebar 动画/折叠是否帮助理解层级

Alma：v0.0.822 只改 Project sidebar group animation，说明它把动画当成层级认知的一部分。staggered entrance 和 two-step collapse 能让用户确认“哪些会话属于刚刚展开/收起的组”。

Neo：workspace 折叠状态持久化，默认展开，Chevron 旋转；当前已补 `expanded/collapsing/collapsed/forced-expanded` 状态模型、rows fade/shift 后再持久收起、强制展开保护态和轻量 stagger。浏览器手验已确认项目组、详情展开和控制台入口可用，剩余是更细的视觉节奏。

差距类型：动效和默认展开策略。核心状态模型已补，视觉节奏仍可继续细调。

### 5. 搜索、命名、分组、最近活动、未完成任务

Alma：GTD sidebar、thread labels、favorite/pin、status sections、Project sidebar 共同覆盖“按状态回到任务”和“按项目回到任务”。

Neo：sidebar search 能索引 session/workbench 元数据，并已接入跨会话消息内容命中；ChatSearchBar 也保留当前/跨会话搜索条，跨会话结果已复用 pending jump 落到消息命中。状态筛选已经覆盖未完成、待确认、执行中、待处理、交付线索，以及管理员视角下的待审会话；搜索 scope、每个会话多条 message-level 命中、会话 turn 编号/时间标签和基础 turn 跳转已经进入侧栏路径；pending jump 已携带 `turnNumber`，缺少可投影 message id 时会先在目标轮里找 query，后端 turn 推断也把 runtime supplement 归入当前 renderer turn。剩余缺口是 Project name/goal/unresolved items 更深进入左侧主路径。

差距类型：入口整合 / 过滤维度 / 项目级 search scope。

## 价值与效果 Mock

### 价值是什么

这件事的价值在于减少用户回到工作流时的判断成本。Neo 原本的能力散在多个地方：项目在 Workspace Preview，任务在 TaskPanel，Replay/Review 偏 admin/debug，搜索在 ChatSearchBar，New Chat 原始入口还会主动传 `workingDirectory: null` 掉进 Chats。用户想继续一个任务时，需要先想“我上次在哪个会话、哪个目录、哪个面板、哪个产物里”。这一层心智成本会直接影响长任务交付。

按当前核验结果，New Chat 继承、项目 header 状态、产物/Replay 证据筛选、管理员待审、Replay 轻量入口、普通用户受限说明、项目内搜索和项目产物 item 级回流都已经进入第一轮实现。项目产物回流已覆盖 assistant artifact code block、工具 previewItem、工具 outputPath，以及 metadata.artifact 里的 path/url；Workflow run 和后台任务的 replay/trace outputRef 也已能在侧栏变成可见证据摘要，并进入 Replay 弹层的 `Workflow / Background` 合并视图；agent 状态、agent prompt/result/error 摘要、最近 workflow logs 和 task events 也已经出现在同一弹层里，file/url/copy evidence 可在弹层内直接操作，多 run/task 场景会先展示最近证据并提示溢出数量。Replay 弹层还会把 evidence 优先挂回对应 workflow run / background task 卡片，剩余证据放进“其他证据”。当前会话动作菜单复用同一套 session replay context，不再与侧栏入口割裂。剩下的工作集中在三类收敛：完整普通用户评审流、点击聚焦式跨证据 drilldown、以及 Project 作为真实对象的命名和信息架构。

做完后要解决四个问题：

1. 新任务不会跑偏：在项目里点 New Chat，默认就是这个项目的新会话。
2. 老任务容易找回：侧栏项目 header 告诉用户哪里在跑、哪里待确认、哪里失败、哪里有交付线索。
3. 交付链路不断：Review、Replay、Artifacts 从 session row 能直接回到同一工作流。
4. 项目关系更清楚：Project 是主对象，工作区路径是副信息，会话是项目里的任务记录。

对用户的体感变化：

| 当前体感 | 改完后的体感 |
|---|---|
| “我刚才那个任务在哪个会话里？” | “这个项目下有 2 个未完成，点进去就是。” |
| “New Chat 会不会跑到空白 Chats？” | “默认就在当前项目，想空白时再手动选。” |
| “Review / Replay / 产物要去哪个面板找？” | “会话行和项目 header 都有回流入口。” |
| “侧栏只是历史列表。” | “侧栏是任务控制台。” |

### 侧栏主路径 Mock

目标效果：左侧侧栏仍然是 Neo 现在的深色、紧凑、工作台气质，但 Project group 不再只是目录折叠。它要像一个项目任务夹，header 直接告诉用户项目状态。

示例内容：

```text
新会话  v
  新项目会话    继承 code-agent
  空白会话      不带项目上下文

搜索项目、会话、产物、工具...

code-agent
/Users/linchen/.codex/worktrees/8df1/code-agent
2 未完成 · 1 待确认 · 3 产物 · 最近 8 分钟
[+] [详情] [筛选]

  待确认  Alma Project / Session Organization
          research · docs/research · Replay · 8 分钟

  执行中  Usage & Context 对标
          coding · rg, docs, tests · 14 分钟

  已完成  Composer 对标研究
          report · 2 产物 · 昨天

voice-coding
/Users/linchen/Downloads/ai/voice-coding
0 未完成 · 0 待确认 · 1 产物 · 最近 2 天

未分类
空白会话，不继承项目
```

这里有几个关键点：

1. `新会话` 变成带下拉的动作，不再默认创建无项目会话。
2. 项目 header 显示路径，但主标题是项目名。
3. 状态数字放在项目 header，用户不用展开也知道哪个项目需要回来。
4. session row 里的 `Replay`、`产物`、`待确认` 是回流入口，不只是标签。
5. `未分类` 明确表示空白会话，减少 `Chats` 的语义漂移。

### New Chat Mock

当用户在项目里点新会话，composer 顶部给一个轻提示，告诉他继承了什么。

```text
新项目会话
项目：code-agent
工作区：.../worktrees/8df1/code-agent
继承：Codex CLI · 当前权限配置 · 项目能力上下文

[输入任务...]
```

如果用户点“空白会话”：

```text
空白会话
不继承项目、工作区或任务上下文

[输入任务...]
```

这个提示不需要做成大卡片，放在 composer 上方一行就够。价值是避免用户一开始就创建错上下文。

### Project Detail Drawer Mock

点击项目 header 的“详情”，右侧或侧边 drawer 展示项目级信息。它属于侧栏的放大视图，不承担新的工作台面板职责。

```text
code-agent
进行中 · 12 会话 · 4 目标 · 7 产物

目标
  [进行中] Alma 0.0.805 -> 0.0.823 对标
  [进行中] Review/Replay 回流设计
  [已完成] Composer 对标研究

待处理
  1 待确认
  2 执行中
  1 失败需要处理

最近产物
  alma-project-session-organization.md
  composer-competitive-analysis.md
  usage-context-gap.md

Review / Replay
  Alma Project / Session Organization · Replay 可用
  Artifacts 专项 · 1 条 Review issue

最近会话
  Alma Project / Session Organization
  Usage & Context 对标
  Composer 对标研究
```

它解决的是“跨会话继续交付”的总览，不替代 Chat，也不替代 TaskPanel。

### 会话行交互 Mock

session row hover 或右键动作建议：

```text
Alma Project / Session Organization
research · docs/research · 8 分钟

快捷动作：
继续会话
打开产物
打开 Replay
查看 Review 证据
复用工作台
导出 Markdown
```

排序建议：

1. 待确认、执行中、失败排在项目组顶部。
2. 置顶会话仍保留在项目组内，不抽到全局置顶区。
3. 已完成按最近活动排序。
4. 搜索时仍保留项目分组，并在 header 显示命中数量。

### 最小实现切法

第一刀的原始范围是“新会话不跑偏”和“项目 header 可见”，当前已基本落地：

1. `Sidebar.handleNewChat` 和 `ConversationTabs.handleNewTab` 已默认继承当前项目/工作区。
2. “空白会话”已成为显式入口，renderer 传 `workingDirectory: null`，main createSession 不再把 null 回退为当前工作区。
3. 侧栏 group 已从裸目录折叠升级为带项目 summary 的 header：project/workspace name、path、session count、状态 counts、goal/artifact/review/recent activity。
4. 侧栏内联项目详情已能展示 goals、roles、artifacts、source sessions，并支持从 active goal 新建同项目会话。

这一版的验收很简单：

1. 在 `code-agent` 项目里点新会话，新 session 出现在 `code-agent` 组里。
2. 同一组 header 能看到未完成/待确认数量。
3. 搜索某个项目内产物或工具名时，结果仍保留项目归属。
4. 用户仍能主动创建“空白会话”。

## 对标矩阵

| Alma 体验点 | 用户感知 | Neo 现状 | 差距类型 | 优先级 | 开发/设计建议 |
|---|---|---|---|---|---|
| Project sidebar 按 workspace/worktree 分组 | 我知道每个任务属于哪个项目 | Sidebar 已改为 Project-first 分组，缺项目元数据时才 fallback 到 workingDirectory；Project 实体已进入左侧主路径，header 二级信息展示 path、多工作区数量、active goal、目标/产物/会话数 | IA/文案 | P0 | 继续打磨独立 drawer、命名体系和未解决项表达 |
| Project group 新建 thread 并 focus | 我在项目里开新任务不会跑偏 | group plus 可按工作区新建但 hover 才出现；顶部 New Chat 当前已默认继承项目/工作区 | 默认策略 | P0 | 保留顶部默认继承，继续强化“空白会话”和项目内新建的文案/入口 |
| New Chat composer slash menu 一致 | 新任务也有完整能力 | ChatInput 会按 session 切换清空草稿；slash 能力不在本专项展开 | 一致性验证 | P1 | New Chat 页展示当前项目能力摘要，能力来源沿用当前 session/project |
| Thread row 显示 generating / pending approval | 我知道哪个任务正在跑、哪里等我确认 | row 有 status badge，当前已补未完成/待确认/执行中/待处理/交付线索/管理员待审筛选、Replay 证据摘要、普通用户受限说明、Workflow/Background 合并摘要、agent/log/task event 摘要、多 run/task 最近证据、证据归位和项目 header 计数 | 可见性 | P0 | 继续补普通用户评审流和点击聚焦式跨证据 drilldown |
| Thread row 显示 diff/worktree/PR | 我能判断代码任务进度 | Neo 有 gitBranch、PRLink 字段，但 sidebar 未集中展示 diff/PR | 功能+IA | P1 | 代码项目 row 显示 branch/PR/diff 摘要，先只显示已有字段 |
| Artifact workspace 绑定 thread | 回到会话就回到产物现场 | ProjectHeaderBar 能聚合产物；当前 session row/project header 已有产物入口，普通用户可用“交付线索”筛选同时找回产物与 replay/trace 证据，项目详情产物可携带 `previewItemId` / `messageId+artifactId` / `path` 选中 Workspace Preview item；Workflow/background replay/trace outputRef 已能作为 `Replay` 证据摘要进入侧栏，带 path/url/opaque uri 的证据已有打开或复制动作，Replay 弹层已展示 workflow/background、agent/log/task event 摘要和多 run/task 最近证据，并把 evidence 挂回所属 run/task | 回流动作 | P0 | 下一步补点击聚焦式证据 drilldown，不停在 session-level structured replay |
| Sidebar mode: simple / project / gtd | 我能按项目或状态组织历史 | Neo 只有 workspace default + search flat view | 功能缺口 | P1 | 不急着做多 mode，先在同一侧栏补 project/status filters |
| Labels/status sections/favorites | 我能用自定义组织维度 | Neo 有 pin/archive/rename，但没有 label/status section | 功能缺口 | P2 | 先做系统状态维度；用户标签排到后续 |
| Project group 动效 | 展开/折叠时层级不丢 | Neo 只有 chevron rotate 和 instant mount/unmount | 动效/层级 | P1 | 对 group row 加两阶段收起、stagger、active row 保持可见；支持 reduced motion |
| Cross-entry thread mapping | 外部 channel 也回同一 thread | Neo 有 origin/parent/source 字段，channel 本专项未见完整 UI | 功能验证 | P2 | 把 origin kind 显示为 row 小标识，支持筛选 schedule/heartbeat/subagent |
| Thread labels / favorite pinned | 高频任务更容易回到 | Neo 有 pinnedSessionIds、本地置顶 | IA | P1 | 置顶区保留项目归属，不要把置顶任务从项目语境里抽走 |
| Long output saved / plugin events | 长任务证据不丢 | Neo 有 structured replay、workflow outputRefs、session diagnostics；当前 row/project header 已接入 Replay、Artifacts 和管理员 Review 证据提示，Replay 弹层已合并 workflow/background/evidence 摘要，并展示 agent 状态、logs、task events、多 run/task 最近项、溢出数量和归位后的证据 chips | 入口整合 | P0 | 继续补点击聚焦式跨证据 drilldown 和 Review 决策面向，不恢复普通用户“加入 Review”假入口 |

## P0 切片

### P0-1 New Chat 继承当前项目

目标：用户在项目中点顶部 New Chat 或新 tab，默认创建属于当前项目/workingDirectory 的 session。

当前状态：已落地。顶部 New Chat、Conversation tab 新建、项目 group 内新建都已按当前项目/工作区创建；显式“空白会话”在 renderer 和 main createSession 两层都保持无工作区；ChatView 空态会展示 `项目会话 · <workspace>`、继承工作区 title 和 workbench snapshot 摘要，空白会话明确标注“不继承项目或工作区上下文”。

建议：

1. 后续不再重复实现继承逻辑，只需要打磨文案强弱。
2. 保留明确入口“空白会话”，用于用户想离开项目时主动选择。
3. 新建后 row 保持在当前 project group，group 自动展开并滚动到新 session。
4. 能力提示继续沿用 session `workbenchSnapshot`，避免再新建一套项目能力模型。

验收：

1. 当前工作区为 `/repo/foo` 时，顶部新会话创建后 `session.workingDirectory = /repo/foo`，`projectId` 由 SessionManager 归桶。
2. 用户选择“空白会话”时，session 不继承当前工作区，进入“未分类”。
3. 切换到已有 session 后再新建，继承的是当前 session 对应 workingDirectory。
4. 现有 untouched draft 复用逻辑仍按 workingDirectory 生效。

风险：

1. 老用户可能习惯顶部 New Chat 代表空白，需要文案和入口明确。
2. app 当前 workingDirectory 与当前 session workingDirectory 不一致时，要以当前 session 为准，或显示将继承的项目名。

### P0-2 侧栏 Project header 成为项目控制台

目标：用户不用打开 Workspace Preview，就能在左侧看到项目状态和回流入口。

当前状态：第一轮已落地。项目 header 已显示未完成、待确认、执行中、待处理、目标、产物、待审、会话数和最近活动；项目详情读态已能展示目标、角色、产物和来源会话。下一步重点是确认信息密度、命名和默认展开策略。

建议：

1. 保持 Project summary 的短路径和计数可扫读，避免 header 变成小仪表盘。
2. 项目内新建、空白会话、从目标启动继续保持在同一组动作里。
3. 复用 `ProjectService.getProjectDetail` 和 `getProjectArtifacts`，但注意不要在列表高频渲染里同步重查所有项目。
4. 当前 active project、有 running/pending approval/error 的项目继续保持 protected expanded。

验收：

1. 有 active goal 的项目 header 显示当前目标摘要和目标数量。
2. 有 pending approval / running / error session 的项目 header 显示对应计数。
3. 从 header 新建 session 会落在该 project。
4. ProjectHeaderBar 在 Workspace Preview 继续可用，但左侧也能进入项目详情读态：项目状态、目标状态、最近产物、来源会话、角色和会话数。

风险：

1. Project detail/artifacts 聚合可能带来列表性能问题，需要按 projectId 缓存和懒加载。
2. workingDirectory hash、symlink、大小写路径可能造成同一项目分裂，需要统一 project key 展示规则。

### P0-3 项目级搜索与恢复

目标：用户能在项目范围内搜索历史会话、消息、产物、工具、任务状态，并跳回具体 session/turn。

当前状态：侧栏搜索已经保留项目分组，并把 `SESSION_SEARCH` 返回的消息内容命中合并进 session row；搜索默认限定当前项目/工作区，可切换到全部。每个会话最多保留 3 条消息级命中，主行展示最佳命中，额外命中可以直接点击；命中项优先展示 `第 N 轮` 和相对时间，搜索层会按 cached message 顺序推断 turn number，并把 runtime supplement 归入当前 renderer turn。点击消息命中会切换 session，并用 `messageId` 映射到现有 `ChatSearchBar` / `TurnBasedTraceView` 的 search match 机制；如果 message id 无法投影，则用 `turnNumber` 先锁定目标轮再找 query。ChatSearchBar 自己的跨会话结果也已接入同一 pending jump，不再只切会话。

建议：

1. 侧栏搜索保留项目层级，不再一搜索就变成全局日期列表。
2. 搜索 scope 默认当前项目，可切换所有项目。
3. `ChatSearchBar` 的 cross-session 能力上移或复用到侧栏，支持 projectId/sessionIds 限定。
4. 结果项提供 session title、匹配 snippet、turn 时间、工作流状态、产物标识。

验收：

1. 在项目 group 内搜索，只返回该 project session 的消息和 metadata。
2. 点击结果切 session，并定位到对应 turn 或至少打开 ChatSearchBar 高亮该 query。
3. 搜索结果能识别 workbench labels/recent tools/artifact title。

风险：

1. 当前 `SESSION_SEARCH` 已返回 messageId/messageIndex/matchOffset/turnNumber，并能驱动会话内 search highlight；Sidebar 已展示每个会话最多 3 条 message-level 结果和会话 turn/时间标签。pending jump 会带 `turnNumber`，并在 message id 无法投影时先按目标 turn 定位；cached message turn 推断已覆盖 runtime supplement 与 queued next turn 的差异。剩余风险是极少数不进入搜索缓存的 renderer-only 节点仍只能依赖 query fallback。
2. 跨会话全文搜索可能影响输入响应，需要 debounce、limit、取消上一次请求。

### P0-4 Review / Replay / Artifacts 回到 session row

目标：长任务交付链路能从会话组织入口回到同一工作流。

建议：

1. session row 或 context menu 增加条件动作：打开 Replay、查看 Review 证据、打开产物、导出诊断。
2. Project header 聚合项目内待 Review issue、可用 Replay、最近产物。当前 pending Review issue 已在管理员视角按 session 聚合，产物和 Replay 回跳已接到侧栏；“交付线索”筛选可直接收敛到有 workspace / write / edit / artifact / notebook 线索或 Workflow/background replay/trace 信号的会话。
3. Review Queue 使用 `traceIdentity.sessionId/replayKey` 回跳到 session，Replay 使用 `GET_STRUCTURED_REPLAY(sessionId)`。当前 `SESSION_LIST_REVIEW_ITEMS` 已复用 artifact issue repository，点击待审徽标打开同 session Replay 证据，并可用“待审”筛选只看 pending Review 会话。
4. Workflow outputRef `Workflow replay` 在 TaskPanel 保留，同时在 session row 标记 `Replay` 并展示 `Workflow replay` / `Trace` 证据摘要；带本地 path 的证据可以直接打开，http(s) link 可以打开或降级复制，opaque uri 会复制。这里要保持语义干净：Replay 是工作流证据，不等同于产物，所以 row 只显示 `Replay` 和证据名，不会只因为 replay 信号显示 `产物`。

验收：

1. 有 workflow outputRef 的 session row 能被筛选出来并显示 `Replay` 恢复信号和具体证据摘要。当前已有轻量 structured replay 弹层、replay/trace 证据摘要、path/url/opaque uri 的打开或复制动作，以及 Replay 弹层内的 workflow/background 合并摘要、agent 状态、logs、task events、多 run/task 最近项、溢出数量、证据归位和 run/task 聚焦展开。
2. admin review queue item 能回到对应 session，并带出 artifact issue。当前已做到 pending issue 计数、待审筛选和同 session Replay 证据回跳，决策 UI 未做。
3. 有项目产物的 session row 能打开 Workspace Preview；项目详情中的产物已经能通过 `previewItemId`、`messageId/artifactId` 或 `path` 选中对应 Workspace Preview item，并能通过“交付线索”筛选找回相关会话。剩余是 workflow outputRef 的深层语义解释，而不是 row 级可见性或基础打开动作。
4. 删除/归档 session 后，review/replay 入口显示不可用原因，不出现死链。

风险：

1. Replay 当前 admin-only，普通用户已经能看到 replay 证据存在和“结构化 Replay 仅管理员可打开”的降级文案；轻量 timeline、workflow/background 合并摘要、agent/log/task event 摘要、多 run/task 最近项、溢出提示、证据归位和 run/task 聚焦展开已有，跨证据比较仍需独立设计。
2. Review Queue contract 注释显示 UI 已下线，恢复入口前要确认产品是否面向 admin/debug 还是普通交付评审；当前普通用户不展示“加入 Review”假入口。

## P1 切片

### P1-1 折叠动画和默认展开策略

建议：

1. 对 Project group 增加 two-phase collapse：先淡出/压缩 rows，再收起容器高度。
2. 展开时对 row 做短 stagger，限制最大延迟，避免长列表拖慢。
3. active/running/pending row 所在 group 不自动收起；搜索命中 group 自动展开。
4. 支持 `prefers-reduced-motion`，虚拟列表下禁止昂贵 layout 动画。

验收：

1. 展开/折叠时用户能看清 row 属于哪个 group。
2. running/pending session 不因 group collapse 从视觉上突然消失。
3. 大于 100 个 session 时滚动和折叠仍流畅。

### P1-2 Project detail drawer

建议：

1. 当前左侧 Project header 已能展开项目详情读态，并新增 Project drawer。drawer 承接现有 goals、roles、artifacts、session count、artifact source session，不重新设计项目模型。
2. drawer 已贴近导航：不打开 Workspace Preview 也能看项目摘要、工作区、目标、角色、产物、最近会话、交付线索、Replay 数量和管理员待审数量；artifact source 能跳到来源会话并打开 Workspace Preview。
3. 当前已支持从 active goal 新建同项目 session，并写回 `lastRunSessionId`；新 session 会自动发送带 `GoalRunInput` 的 envelope，进入自治 goal run。

验收：

1. 不打开 Workspace Preview 也能看项目目标/角色/产物、最近会话和恢复线索。当前 drawer 读态已满足，项目名、描述和状态编辑已接入。
2. 点击 active goal 能创建同项目 session。当前侧栏读态和 drawer 都已满足，并会自动带入 goal prompt / run 上下文。
3. artifacts 列表能跳到来源 session。当前侧栏读态和 drawer 都已满足。

### P1-3 命名体系清理

建议：

1. 左侧统一用“项目”表示 Project entity，用“工作区路径”作为副信息。
2. `Chats` 文案已改为“未分类”，和 ProjectService 的 unsorted 语义保持一致。
3. `Project Grouped` 注释和 UI 行为对齐，避免工程语义继续漂移。
4. New Chat 文案区分“新项目会话”和“空白会话”。

验收：

1. 用户看到项目名、路径、会话归属三者关系清楚。
2. 无工作目录会话不会被误认为一个真实项目。

### P1-4 完整状态/类型过滤

建议：

1. 当前 `SessionStatusFilter` 已覆盖 `all/unfinished/approval/running/attention/artifact/review/background`。
2. 下一步才考虑增加 type/origin 筛选：manual、cron、heartbeat、subagent、retry。
3. 过滤结果继续保持 project grouping，并在 project header 显示命中数量。

验收：

1. “待确认”能直接列出所有 pending approval sessions。
2. “未完成”能覆盖 running、paused、error、incomplete。
3. 过滤不会丢失项目归属。

## 开发顺序建议

| 顺序 | 切片 | 原因 |
|---|---|---|
| 1 | P0-1 New Chat 继承当前项目 | 影响最大，改动点集中，能立刻减少任务跑偏 |
| 2 | P0-2 Project header 状态可见 | 把已有 project/service 能力拉回左侧主路径 |
| 3 | P0-4 Review/Replay/Artifacts row 回流 | 解决长任务交付链路断点 |
| 4 | P0-3 项目级搜索 | 基础 scope、跳转、多命中列表、会话 turn/时间标签、pending jump turn fallback 和 runtime supplement parity 已落地，下一步关注缓存控制与真实长列表性能 |
| 5 | P1 动效、drawer、命名、过滤 | 在语义稳定后打磨体验 |

## 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| New Chat 默认继承改变用户习惯 | 用户想要空白会话时多一步 | 保留显式“空白会话”入口，首次提示当前将继承的项目 |
| Project 聚合性能 | 左侧列表卡顿 | project summary 按需加载、缓存、只取 counts，不在列表提取全文 artifacts |
| projectId 与 workingDirectory 不一致 | 会话显示在错误项目 | 以 `projectId` 为主，workingDirectory 为副信息；提供修复/重新归类能力 |
| Review/Replay 权限 | 普通用户知道证据存在，也知道哪些动作受限 | 当前 Replay 按 admin-gated 禁用态展示；普通用户能看到 replay 证据和结构化 Replay 受限原因；Review 待审徽标仅管理员可见，普通用户评审流另行设计 |
| 搜索结果跳转不准 | 用户回不到具体上下文 | 先用 `messageId` 找 trace node，再用 node 内 query offset 定位；多段 assistant message 要用单测覆盖 |
| 动画影响长列表 | 滚动和折叠掉帧 | 限制 stagger 数量，虚拟列表下简化动画 |

## 可直接进入设计的页面状态

1. 左侧默认项目组：
   - Header：项目名、路径缩写、活动数、待确认数、未完成数、最近更新时间。
   - Actions：新会话、空白会话、项目详情。
   - Rows：session title、status、workbench summary、最近活动、artifact/replay/review 小标识。

2. 项目内 New Chat：
   - Composer 顶部轻提示：当前项目、工作区路径、已继承的 engine/capability。
   - 可切换为“空白会话”。

3. 项目搜索：
   - scope：当前项目 / 所有项目。
   - filters：未完成、待确认、错误、交付线索、管理员待审；Replay 已有 row 级证据摘要，筛选文案已从“有产物”改成更准确的“交付线索”。
   - result：session title、匹配 snippet、turn 时间、跳转按钮。

4. Project drawer：
   - 目标、角色、产物、最近会话、Review/Replay 线索。
   - 产物、goal 上次会话、最近会话都能回到来源 session；产物会同步打开 Workspace Preview。

## 需要继续验证的点

本轮新增验证：

1. `npx vitest run tests/unit/renderer/workspaceGrouping.test.ts tests/renderer/components/sidebar.sessionMetadata.test.ts` 通过，覆盖 Project-first group key、同一 Project 多 worktree 单组渲染、状态筛选和恢复线索。
2. `npx vitest run tests/renderer/utils/workspacePreview.test.ts tests/unit/renderer/sessionAssetsNavigation.test.ts` 通过，覆盖 Project artifact 到 Workspace Preview 的精确 item id 选择。
3. `npx vitest run ...` directed suite 通过 27 个文件、195 条测试，覆盖 New Chat main 语义、ProjectRepository、session search、pending jump、Sidebar detail/review/replay、workspace grouping、Workspace Preview、replay evidence、当前会话 Replay context 和 Project header summary 等路径。
4. `npx vitest run tests/unit/renderer/sessionRecoveryHints.test.ts tests/renderer/components/sidebar.sessionMetadata.test.ts` 通过，覆盖 Workflow/background replay 信号进入侧栏恢复 hint 与“交付线索”筛选，同时验证 replay-only session 不会被伪装成“产物”行标签。
5. `npx vitest run tests/unit/renderer/sessionReplayEvidence.test.ts tests/renderer/components/sidebar.sessionMetadata.test.ts` 通过，覆盖 Workflow run、后台 replay outputRef、后台 trace outputRef 归并到同一 session，并在 Sidebar row 展示具体证据摘要。
6. `npx vitest run tests/unit/renderer/openSessionReplayEvidence.test.ts tests/unit/renderer/sessionReplayEvidence.test.ts tests/renderer/components/sidebar.sessionMetadata.test.ts` 通过，覆盖 session replay、本地 trace 文件、http replay link、opaque replay handle 的点击动作分流。
7. `npx vitest run tests/renderer/components/sessionReplaySummaryDialog.test.tsx tests/unit/renderer/sessionReplayContext.test.ts tests/unit/renderer/sessionReplayEvidence.test.ts tests/unit/renderer/openSessionReplayEvidence.test.ts` 通过 4 个文件、11 条测试，覆盖 Replay 弹层里的 `Workflow / Background` 合并摘要、workflow 阶段、agent 计数、agent 状态、agent prompt/result 摘要、后台任务、task events、outputRef 展示、replay/trace evidence 点击分流，多 workflow run / background task / evidence 的最近排序和溢出提示，evidence 归位到对应 workflow run / background task 卡片，以及 run/task 聚焦入口和聚焦后 agents/logs/output refs/events 展开。
8. `npx vitest run tests/unit/renderer/sessionRecoveryHints.test.ts tests/renderer/components/sidebar.sessionMetadata.test.ts tests/renderer/components/sidebar.reviewActions.test.ts` 通过 3 个文件、33 条测试，覆盖普通用户 replay 证据可见但结构化 Replay 受限、管理员 Replay/Review 入口和侧栏恢复线索。
9. `npx vitest run tests/unit/renderer/sessionReplayContext.test.ts tests/renderer/components/chatView.sessionWorkspace.actions.test.ts tests/renderer/components/sessionWorkspaceBar.test.ts` 通过 3 个文件、6 条测试，覆盖当前 session replay context 会聚合同 session workflow/background/evidence，且当前会话动作菜单接入新增 workflow/background store 依赖后仍稳定渲染。
10. `npx vitest run tests/renderer/components/sessionReplaySummaryDialog.test.tsx tests/renderer/components/sidebar.sessionMetadata.test.ts tests/renderer/components/sidebar.reviewActions.test.ts tests/renderer/components/chatView.sessionWorkspace.actions.test.ts tests/renderer/components/sessionWorkspaceBar.test.ts tests/unit/renderer/openSessionReplayEvidence.test.ts tests/unit/renderer/sessionReplayContext.test.ts` 通过 7 个文件、40 条测试，覆盖 Replay 弹层内 file/url/copy evidence 可操作，以及侧栏和当前会话菜单两个入口的接线稳定性。
11. `npx vitest run tests/unit/renderer/sidebarProjectSummary.test.ts tests/renderer/components/sidebar.sessionMetadata.test.ts` 通过 2 个文件、18 条测试，覆盖 Project header summary 的 active goal、多工作区、状态计数、目标/产物/会话数和空白会话命中表达。
12. `npx vitest run tests/unit/services/ProjectRepository.test.ts tests/renderer/components/sidebarProjectDrawer.test.tsx tests/renderer/components/sidebar.sessionMetadata.test.ts` 通过 3 个文件、30 条测试，覆盖 Project drawer 的项目摘要、工作区、目标、产物、最近会话、分支/PR、交付线索、Replay/待审提示、项目名/描述/状态编辑入口，Sidebar header 的“项目控制台”入口，以及 repository 层项目描述写入/清空。
13. `npx vitest run tests/unit/renderer/sessionRecoveryHints.test.ts tests/unit/renderer/sessionPresentation.test.ts tests/renderer/components/sidebar.sessionMetadata.test.ts tests/renderer/components/sidebar.reviewActions.test.ts tests/renderer/stores/sessionUIStore.test.ts` 通过 5 个文件、77 条测试，覆盖“交付线索”筛选文案、delivery signals helper、replay-only 会话可被筛选找回且不会伪装成“产物”行标签。
14. `npx vitest run tests/unit/renderer/workspaceGrouping.test.ts tests/unit/renderer/sidebarProjectSummary.test.ts tests/renderer/components/sidebar.sessionMetadata.test.ts tests/renderer/components/sidebar.newSessionButton.test.ts` 通过 4 个文件、36 条测试，覆盖空白会话进入“未分类”组、Project header summary 继续显示“空白会话”副信息，以及顶部空白会话入口文案。
15. `npx vitest run tests/unit/renderer/projectGoalChatSeed.test.ts tests/renderer/components/chatView.sessionWorkspace.test.ts tests/renderer/components/chatInput.goalCommand.test.ts tests/renderer/components/sidebarProjectDetail.test.tsx tests/renderer/components/sidebarProjectDrawer.test.tsx tests/renderer/components/sidebar.sessionMetadata.test.ts` 通过 6 个文件、27 条测试，覆盖 Project active goal seed 会保留 `verify` / `review`，合并 composer envelope 的 context/options，在缺少 `goal.goal` 时回退到可见 prompt，在没有显式 gate 时补默认软评审，并确认 ChatView、/goal command、Project detail/drawer 和 Sidebar 元数据路径仍稳定。
16. `npx vitest run tests/unit/session/search.test.ts tests/unit/renderer/sessionSearchJump.test.ts tests/unit/renderer/sidebarMessageSearch.test.ts tests/renderer/stores/sessionUIStore.test.ts` 通过 4 个文件、37 条测试，覆盖跨会话搜索 `turnNumber` 写入 pending jump、目标 turn 优先于全局 query fallback、runtime supplement 不新增 renderer turn、queued next turn 仍新增 turn。
17. `npm run typecheck`、`npm run build:renderer`、`git diff --check` 通过；renderer build 只有既有 chunk size / ineffective dynamic import warning。
18. 浏览器手验：用隔离 `CODE_AGENT_HOME=/tmp/code-agent-browser-handtest`、`CODE_AGENT_DATA_DIR=/tmp/code-agent-browser-handtest/.code-agent` 启动 `WEB_PORT=8180 node dist/web/webServer.cjs`，`/api/health` 返回 ok；Browser 打开 `http://127.0.0.1:8180/` 后无 console error。创建 `/tmp/alma-project-browser-handtest` project session 和 active goal 后，页面可见项目组、`目标：验证 Project / Session Or… · 1 目标 · 0 产物 · 1 会话` 摘要、同项目 New Chat 空态 `项目会话 · alma-project-browser-handtest` / `继承：工作区`；项目详情展开后可见 goal 全称；项目控制台可见项目摘要、工作区、目标、最近会话、Replay/资产入口和项目上下文。当前控制台不直接显示 `verify` / `review` 原文，相关执行 seed 由定向单测覆盖。

仍需继续验证：

1. Alma old renderer 缺失，无法比较 v0.0.805 到 v0.0.823 的代码级差异，只能用 release notes 和当前 0.0.823 bundle 判断。
2. Alma UI 真实交互没有运行截图，本研究未确认 Project sidebar 的视觉布局细节。
3. Neo Review Queue 的产品面向需要确认。代码显示 API 和 trace identity 存在，但 contract 注释写评测中心 UI 已下线。
4. Neo project summary 批量读取在真实长会话列表中的性能需要做 runtime profile；当前测试只证明功能路径，不证明大列表性能。
