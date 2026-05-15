# Settings 管理面升级研究：对照 Memoh

日期：2026-05-14

研究范围：

- code-agent 当前 Settings、IPC、配置入口。
- Memoh 的 Provider、Bot、Channel、MCP、Skill、Schedule、Memory、Speech、Web Search 设置页。
- 按 code-agent 的生活/工作助手定位，判断哪些设置要进入主设置，哪些要放到高级、调试或内部评测区。

结论：Settings 应该升级成管理后台式控制面，但不能照搬 Memoh 的 Bot 平台结构。code-agent 的主设置要围绕个人助手的可用性、安全性和日常连接状态组织，把 Provider、Model、Channel、MCP、Skills、Memory、Workspace、Automation、Permission 产品化。Telemetry 只保留健康摘要入口，原始遥测、Eval、Debug Snapshots、Context 溯源细节和 Hook 源文件这类内容应进入调试或内部评测区。

## 1. code-agent 当前 Settings 能力和入口盘点

### 1.1 入口结构

当前 Settings 是一个 `max-w-2xl` 小弹窗，左侧分组导航，右侧单 tab 内容。入口在 `src/renderer/components/features/settings/SettingsModal.tsx`：

- Tab 列表：权限与安全、对话、模型、外观、数据与存储、MCP、Skills、通道、Hook、记忆、屏幕记忆、更新、关于。见 `SettingsModal.tsx:65-85`。
- 导航分组：基础偏好、能力与连接、记忆与隐私、系统。见 `src/renderer/utils/settingsTabs.ts:26-56`。
- 搜索只跳到 tab 级别，不定位具体对象或字段。`SettingsSearch` 会把匹配项按 tab 去重。见 `SettingsSearch.tsx:19-37`。
- 页面骨架只有 `SettingsPage`、`SettingsSection`、`SettingsDetails` 三个轻量 primitive，适合卡片和折叠详情，不适合表格、筛选、批量操作、详情抽屉。见 `SettingsLayout.tsx:25-91`。

这套结构适合“偏好设置”，但已经承载了很多可运行对象：Provider、Channel account、MCP server、Skill repository、Memory file、Cron job、Permission rule。它们需要状态列、错误列、批量操作和对象详情，不适合继续塞在小弹窗里。

### 1.2 配置和 IPC 能力

`AppSettings` 已经覆盖了很多管理面对象：

| 能力 | 已有 contract | 当前 UI 形态 | 管理面缺口 |
|---|---|---|---|
| Provider / Model | `models.providers`、`models.routing`、简化 `model`、timeout、budget，见 `settings.ts:9-167` | `ModelSettings` 表单选择单 provider、API Key、model、temperature、测试连接 | 缺 provider 表格、启停、健康状态、默认模型/用途路由矩阵、最近错误、批量测试 |
| Permission | `permissions.permissionMode`、inheritance、deny/ask/allow，见 `settings.ts:49-80` | `GeneralSettings` 里安全模式、子 agent 继承、规则 textarea | 主层应保留安全姿态；规则编辑需要 drawer 和校验，不能靠自由文本长期承载 |
| Conversation routing / Browser | `ConversationSettings` 管 routing、browser mode、context compression | 低频但用户可理解，已经从输入框移到 Settings | 应保留在日常设置或模型区下，不进入调试区 |
| MCP | `mcp.servers`，MCP IPC 已有 add、refresh、status、enable/disable 方向 | `MCPSettings` 卡片列表 + Add server + Workbench sheet + 诊断折叠 | 应升级为 server table，状态、transport、tools/resources、last error、last probed 是列 |
| Skills | `SKILL_CHANNELS` 支持 repo list/download/update/remove/custom、skill enable/disable、session mount、SkillsMP 搜索，见 `channels.ts:9-79` | `SkillsSettings` 已安装库、启用 skill chip、推荐仓库、自定义仓库、SkillsMP 搜索 | 主层保留库和启停；自定义仓库、SkillsMP 安装、录制生成放高级 |
| Channel | contract 支持 `http-api/feishu/slack/discord/telegram/wechat`，账号状态、隐私策略、inbox/outbox，见 `channel.ts:13-189`、`channel.ts:265-320` | `ChannelsSettings` 支持 HTTP API、飞书、Telegram 账号 CRUD、连接/断开、隐私策略 | 应成为一级对象，因为它决定外部入口、隐私和在线状态 |
| Memory | `memory.ipc.ts` 支持 lightList/lightStats/lightDelete/memoryAudit 等 | `MemoryTab` 是 `~/.code-agent/memory` 文件浏览器，带统计、分组和删除 | 日常层要做记忆开关、范围、回顾、隐私；原始文件浏览应放高级 |
| Screen Memory / Activity | Activity Providers、OpenChronicle daemon、Native Desktop provider | `ScreenMemorySettings` 主层 OpenChronicle，诊断里有 ActivityContext preview 和 Native Desktop | 主层保留自动屏幕记忆和黑名单；ActivityContext preview 属调试 |
| Workspace | `workspace:*` IPC 支持选择目录、当前目录、文件读写、打开路径，见 `workspace.ipc.ts:245-299` | `WorkspacePanel` 是侧栏文件树，LocalBridge 里有工作目录选择 | Settings 缺“工作区”主入口，当前目录、最近目录、本地桥状态、索引状态应独立 |
| Automation | `cron.ipc.ts` 支持 list/create/update/delete/trigger/executions/stats/generateFromPrompt，见 `cron.ipc.ts:43-133` | `CronCenterPanel` 是独立全屏面板，列表+详情+编辑器 | 应进入管理面一级导航，普通用户看到的是自动化任务，cron 术语放高级 |
| Telemetry | `TELEMETRY_CHANNELS` 支持 session、turn、events、tool stats、structured replay，见 `channels.ts:316-341` | `TelemetryPanel` 是会话遥测列表 + 概览/轮次/时间线/工具 | 原始 telemetry 不该进主设置，只给高级健康摘要和调试入口 |
| Eval | `EVALUATION_CHANNELS` 覆盖 run/history/export/objective/subjective/test cases/scoring/review queue 等，见 `channels.ts:192-253` | `EvalCenterPanel` 是独立评测中心，含 7 个页面 | 内部 eval 设置，不进普通用户 Settings |

### 1.3 现有入口的产品问题

1. 设置粒度和对象粒度混在一起。`Appearance` 是偏好，`MCP server` 和 `Channel account` 是运行对象，放在同一弹窗的同一种卡片结构里，用户难以判断哪个是“配一次”，哪个要持续运营。

2. 状态分散。Channel 有 `ACCOUNT_STATUS_CHANGED`、MCP 有 workbench capability status、Cron 有 stats 和 execution history、Telemetry 有 live event，但 Settings 里没有统一的状态列、错误列和最近检查时间。

3. 安全项缺分层。`Permission`、Channel privacy、OpenChronicle blacklists、MCP env/OAuth、Skill trust、Debug snapshots 都涉及风险，但现在散在不同 tab，普通用户容易把“危险调试开关”和“日常连接配置”看成同类设置。

4. Workspace 缺主设置位置。工作目录是生活/工作助手的基础上下文，现状主要在右侧 Workspace、LocalBridge 诊断和工作台里出现，没有一个“当前默认工作范围”的稳定设置页。

5. Eval/Debug 的入口已经存在，但不应挤入 Settings 第一层。`EvalCenterPanel`、`TelemetryPanel`、Debug Snapshots、Context Health 都更像内部质量工程和诊断面。

## 2. Memoh 管理面的信息架构拆解

Memoh 的强项是把每个可运行能力当作一个可管理对象，避免降级成表单片段。它的 IA 可以借鉴对象管理方式，不能直接借它的多 Bot / 多租户心智。

### 2.1 全局 Provider 面

`/tmp/memoh-study/apps/web/src/pages/providers/index.vue` 使用 `MasterDetailSidebarLayout`：

- 左侧 provider sidebar，启用状态用绿点 badge，列表按 enable 排序。见 `providers/index.vue:49-59`、`providers/index.vue:85-170`。
- 右侧 detail 使用 `model-setting.vue`，包括 provider enable switch、ProviderForm、ModelList。见 `model-setting.vue:1-50`。
- API 使用 `getProviders`、`putProvidersById`、`getProvidersByIdModels`、`deleteModelsById`。见 `model-setting.vue:64-179`。

可借鉴点：Provider 是资源对象，有启停、详情、模型列表和健康状态。code-agent 当前 `ModelSettings` 更像“当前 provider 快捷编辑”，需要升级为 Provider/Model 管理表。

### 2.2 Bot Detail 主控制台

`bots/detail.vue` 是 Memoh 的核心管理面：

- 左侧是 Bot identity header、状态 badge、搜索框和分组 tab。见 `detail.vue:1-216`。
- Tab 包含 overview、general、desktop、container、network、memory、channels、access、tool-approval、email、mcp、heartbeat、compaction、schedule、skills。见 `detail.vue:303-320`。
- 搜索索引覆盖 general、container、memory、channels、access、tool approval、mcp、schedule、skills 等。见 `detail.vue:330-353`。
- 分组为 core、capabilities、runtime、security。见 `detail.vue:367-379`。

可借鉴点：左侧导航分组避开“设置/配置/数据”这类抽象词，按用户管理任务拆分：核心、能力、运行、安全。code-agent 可改成“日常、能力、记忆与工作区、自动化、安全、系统”，但不需要 Bot fleet 概念。

### 2.3 Channel 面

Memoh Bot Channel 是 L3 平台 rail + L4 设置面：

- 左侧列出已配置 channel，显示 active/configured 状态，底部添加平台。见 `bot-channels.vue:1-149`。
- Channel settings panel 右侧有 webhook callback、必填 credentials、advanced optional fields、disable/save/delete。见 `channel-settings-panel.vue:1-409`。
- 配置 schema 由 channel meta 提供，按 required/optional 排序，secret、bool、number、enum 动态渲染。见 `channel-settings-panel.vue:483-497`。

可借鉴点：Channel 要按平台/账号管理，必填凭证在主层，optional 参数进入高级折叠。code-agent 当前已经有账号 CRUD 和隐私策略，但缺表格视图、筛选和详情抽屉。

### 2.4 MCP 面

`bot-mcp.vue` 是 Memoh 最像管理后台的页面：

- 左侧 server list，带搜索、添加、导入、状态点、未保存标记。见 `bot-mcp.vue:1-109`。
- 右侧 sticky header 展示 server、last probed、export、probe、save、dirty 状态。见 `bot-mcp.vue:111-221`。
- 主表单拆成 Identity & Protocol、Technical Payload、Advanced Settings。见 `bot-mcp.vue:259-588`。
- Advanced 里放 env/header/OAuth。见 `bot-mcp.vue:435-587`。
- Connected 后展示 discovered tools summary 和 view all。见 `bot-mcp.vue:590-635`。
- Danger Zone 放底部。见 `bot-mcp.vue:637-669`。
- Import 用 Monaco JSON sandbox。见 `bot-mcp.vue:701-760`。

可借鉴点：code-agent 的 MCP 也应该把 name、transport、command/url、enabled、tool/resource count、last error、last probed 放到可扫表格里。env、headers、OAuth、raw JSON import 是高级详情，不进第一屏。

### 2.5 Skill 面

`bot-skills.vue` 的信息结构：

- Header 里有 discovery 和 add skill。见 `bot-skills.vue:1-40`。
- Skill grid 展示 name、description、source、managed/discovered、enabled/disabled/shadowed。见 `bot-skills.vue:91-266`。
- Hover actions 支持 edit/view、enable/disable、adopt、delete。见 `bot-skills.vue:173-263`。
- 编辑器使用 Monaco markdown。见 `bot-skills.vue:268-319`。

可借鉴点：Skill 是“能力库对象”。code-agent 当前 `SkillsSettings` 已有 repo 维度和 skill 启停，适合升级为表格：skill 名、来源、状态、启用范围、依赖风险、最近更新。

### 2.6 Schedule 面

`bot-schedule.vue` 体现高密度任务管理：

- Header 展示数量、刷新、新建。见 `bot-schedule.vue:1-49`。
- 创建/编辑表单包括 name、enabled、description、command、cron code、visual builder、max calls。见 `bot-schedule.vue:85-283`。
- 列表是表格：name、pattern、enabled、max calls、updated at、actions。见 `bot-schedule.vue:331-501`。
- API 支持 list/create/update/delete，并读 bot timezone。见 `bot-schedule.vue:513-760`。

可借鉴点：code-agent 的 `CronCenterPanel` 已经有列表、筛选、详情和执行历史，应该改名为 Automation，进入管理面一级导航。普通用户看到“自动化任务”，高级层再出现 cron expression、shell/webhook action 和重试超时。

### 2.7 Memory 面

Memoh 有两层 Memory：

- 全局 Memory Providers 页面：`memory/index.vue` 用 provider sidebar + provider setting，管理 memory provider 资源。见 `memory/index.vue:1-121`。
- Bot Memory 页面：左侧 memory file list、search、compact；右侧 editor、delete、新建 memory from conversation、chart diagnostics。见 `bot-memory.vue:1-360`、`bot-memory.vue:421-604`。
- Memory status 区分 dense/sparse，并可做 dense search diagnostics、compact ratio、decay date。见 `bot-memory.vue:689-693`、`bot-memory.vue:1126-1154`、`bot-memory.vue:1293-1321`。

可借鉴点：code-agent 的 Light Memory 不应以“文件浏览器”作为普通用户主心智。主层要表达“记忆范围、最近学习、可回顾、可删除、隐私边界”。原始文件、audit、dense/sparse 图表属于高级/调试。

### 2.8 Access 面

`bot-access.vue` 把访问控制产品化：

- 首屏是 access mode posture：blacklist 或 whitelist。见 `bot-access.vue:27-80`。
- Rules list 展示目标、状态、平台、用户、会话 scope、描述和 enable/edit/delete。见 `bot-access.vue:82-241`。
- 表单支持平台、channel identity、chat scope、specific conversation、manual conversation id/thread id。见 `bot-access.vue:243-627`。
- API 覆盖 default effect、ACL rules、channel identities、observed conversations。见 `bot-access.vue:664-800`。

可借鉴点：code-agent 的 Permission tab 可以从自由文本规则升级为“姿态 + 规则表 + 详情抽屉”。普通用户理解“默认询问、自动接受编辑、危险操作仍询问”比理解 deny/ask/allow 文法容易。

### 2.9 Speech / Web Search provider 面

Memoh 的 Speech 和 Web Search 都是 provider resource：

- `speech/index.vue` 用 provider sidebar、enable badge、detail provider setting。见 `speech/index.vue:1-135`。
- `web-search/index.vue` 用 search providers sidebar、AddSearchProvider、provider detail。见 `web-search/index.vue:1-155`。

可借鉴点：code-agent 不必单独开 Speech/Web Search 一级设置。它的工具层已经通过 ToolSearch 管 web/search/document/media；如果未来有 paid provider 或 key 管理，再归入 Provider 的“能力类型”列。

## 3. 用户视角分层

### 3.1 日常设置

日常设置的原则：用户能直接判断“我现在能不能用、连到哪里、会不会越权、会记住什么”。

| 一级区 | 应进入内容 | 不放内容 |
|---|---|---|
| 模型与供应商 | Provider 启停、默认 provider、API key 配置状态、测试连接、模型选择、用途路由（coding/fast/vision/gui）、预算摘要 | 原始 request/response、provider wrapper 内部差异、eval 专用模型 |
| 通道 | HTTP API、飞书、Telegram 账号列表，连接状态，隐私模式，最近 inbox 状态，默认会话路由 | raw payload、脱敏前消息、debug-only `privacyMode=off` 快捷入口 |
| MCP 与工具 | MCP server 列表、启停、transport、tools/resources 数量、last error、连接测试、添加 server | env/header/OAuth 原文、raw JSON import/export、ToolModule registry 全量列表 |
| Skills | 已安装库、skill 启停、来源、依赖警告、更新、移除 | 自定义 GitHub repo、SkillsMP 社区搜索、combo recording 内部数据 |
| 记忆与活动 | Light Memory 开关、最近记住的内容摘要、类型统计、删除/禁用、屏幕记忆开关、隐私黑名单 | `~/.code-agent/memory` 原始文件浏览、ActivityContext raw preview、audit dump |
| 工作区 | 当前工作目录、最近目录、默认目录、本地桥状态、文件访问能力、索引/活动来源状态 | 文件读写 IPC 细节、bridge security debug、native provider raw 状态 |
| 自动化 | 自动化任务列表、启停、下次运行、最近运行、失败原因、手动运行、自然语言创建 | cron 语法细节、shell/webhook raw body 默认展开、执行日志全量 |
| 权限与安全 | 权限姿态、子 agent 继承模式摘要、规则数量、高风险规则提示、危险操作确认策略 | allow/ask/deny 自由文本大编辑器默认展开、legacy migration flags |

### 3.2 高级设置

高级设置给会配置工具链的人用，默认折叠或通过“高级”开关进入：

- Provider：baseUrl、timeout、maxTokens、temperature、provider-specific headers、Ollama endpoint。
- MCP：stdio command/args/cwd/env、remote URL、headers、OAuth client id/secret、raw JSON import/export。
- Channel：CORS、allowed origins、Feishu webhook port/encrypt key/verification token、Telegram proxy/fallback proxy/user/chat allowlist、raw payload 保留策略。
- Skills：自定义 repo、SkillsMP 搜索安装、repo trust、dependency warning、session mount。
- Memory：文件浏览、import/export、memory audit、手动 compact、按类型删除。
- Workspace：Local Bridge 安装、桥接安全等级、默认目录继承、recent directory 清理。
- Automation：cron expression、retry/timeout、shell/webhook action、tags、execution retention。
- Permission：deny/ask/allow 文法编辑、规则导入导出。
- Hooks：Hook tab 应整体归高级，因为它是运行时扩展和诊断接口，普通用户日常配置里不需要第一眼看到。

### 3.3 调试设置

调试设置服务排障，不应出现在普通用户第一层：

- Telemetry 原始会话、turn、event、tool stats、structured replay。
- Context Health bySource、Context intervention get/set、MCP/Skill token 占用拆解。
- Debug Snapshots 统计、retention、清理。
- ActivityContext preview、Native Desktop manual capture、Computer-use diagnostics。
- Doctor diagnostics、logs、provider doctor detailed probes。
- Channel raw inbox/outbox、脱敏前后对照仅限本地受控调试。

### 3.4 内部 eval 设置

内部 eval 面向产品质量、回归和验收：

- Eval Center：会话评测、实验总览、测试集、评分配置、实验详情、失败分析、对比分析。
- Review Queue、Delivery Review、Preview Feedback、structured replay completeness gate。
- Subjective evaluator、scoring config、test subset、regression baseline。
- 与日常 Settings 的关系：只在调试/内部菜单露入口，不进入普通设置导航。

## 4. 管理后台 IA 草案

### 4.1 外层布局

建议把 Settings 从“小弹窗”升级为独立设置页或全高宽面板。当前 `max-w-2xl` + `h-[500px]` 已经不够承载这些对象，尤其是 Provider、Channel、MCP、Skills、Automation 这类需要状态列和详情的配置。

截图里的样式更适合做日常设置壳：

- 左侧固定导航：宽度 260 到 300，保留返回入口、分组导航和高亮态；导航项用图标 + 名称，密度比当前小弹窗更接近 macOS 设置页。
- 内容区居中：普通偏好页使用 880 到 1040 的内容宽度，标题在内容区顶部，页面自身滚动，不再把所有内容压进 500px 高度。
- 设置块克制：工作模式、权限、常规偏好用截图里的横向选择卡、设置行和右侧 toggle/select，用户能快速扫出当前状态。
- 对象页再放宽：Provider、Channel、MCP、Skills、Automation 进入对象管理模板时，内容宽度可放到 1120 到 1280，采用表格、筛选、详情抽屉。
- 顶部工具按需出现：常规页不需要全局 toolbar；对象页才显示搜索、筛选、刷新、添加、批量操作。

因此 Settings Console 应该有两类页面模板：

| 模板 | 适用区域 | 结构 |
|---|---|---|
| 偏好设置页 | 常规、外观、权限姿态、记忆开关、工作区基础项 | 左侧导航 + 居中内容 + section card / setting row |
| 对象管理页 | Provider、Channel、MCP、Skills、Automation、Permission rules | 左侧导航 + 顶部工具 + 表格 + 详情抽屉 |

整体结构：

- 左侧导航：日常、能力、记忆与工作区、自动化、安全、系统、高级、调试、内部评测。
- 顶部工具栏：只在对象管理页出现，承载全局搜索、状态筛选、范围筛选、刷新、健康检查、添加对象、导入/导出（高级可见）。
- 主内容：对象表格为主，详情抽屉为辅。
- 右侧详情抽屉：基础信息、状态、配置、诊断、历史、危险操作。
- 状态列统一语义：Ready、Needs setup、Disconnected、Error、Disabled、Running、Deprecated。
- 空状态：给“添加第一个对象”的明确动作，不写大段说明。

### 4.2 左侧导航建议

| 导航 | 首屏对象 | 说明 |
|---|---|---|
| 模型 | Providers、Models、Routing | 合并当前 ModelSettings 和部分 ConversationSettings |
| 通道 | Channel Accounts、Inbox Health | 外部入口和隐私是主能力 |
| 工具 | MCP Servers、Native Tools Summary | MCP 主表，工具 summary 只显示启用/可用数量 |
| Skills | Skill Libraries、Skills | repo 与 skill 分开，但在同页上下切换 |
| 记忆 | Light Memory、Screen Memory、Activity | 日常记忆视图，不默认打开原始文件 |
| 工作区 | Current Workspace、Recent Workspaces、Bridge | 当前目录和本地能力状态 |
| 自动化 | Automation Jobs、Executions | Cron Center 改产品名 |
| 权限 | Permission Posture、Rules、Subagents | 姿态优先，规则抽屉编辑 |
| 系统 | Appearance、Data、Update、About | 纯偏好和系统信息 |
| 高级 | Raw configs、Hooks、Imports | 可折叠或 dev mode 后可见 |
| 调试 | Telemetry、Context Health、Doctor、Snapshots | 排障 |
| 内部评测 | Eval Center、Review Queue、Scoring | 默认隐藏，内部开关开启 |

### 4.3 顶部工具

通用工具：

- 搜索：对象名、类型、错误、标签、路径。
- 筛选：状态、类型、来源、是否启用、最近失败。
- 刷新：拉取状态，不改配置。
- 添加：根据当前导航创建对应对象。
- 批量操作：启用、停用、测试连接、刷新状态、导出、删除。
- Health check：只运行只读检查，写操作需要明确确认。

### 4.4 表格和详情抽屉

#### Providers / Models

表格列：

- Provider、Enabled、Default、Key status、Model count、Routing roles、Last tested、Status、Actions。

详情抽屉：

- 基础：name、provider type、API key、baseUrl。
- 模型：可用模型列表、默认模型、用途路由。
- 诊断：test connection、doctor probes、最近错误。
- 高级：timeout、temperature、maxTokens、budget。

#### Channels

表格列：

- Name、Type、Status、Privacy、Inbound mode、Port/Webhook、Default session/agent、Last message、Error、Actions。

详情抽屉：

- 必填凭证。
- 连接状态与 callback URL。
- 隐私策略：默认 local-redact，allow-raw 和 off 进入高级并有明确风险提示。
- Inbox/outbox 最近事件。
- 高级：CORS、proxy、allowed user/chat ids、raw payload。

#### MCP Servers

表格列：

- Name、Enabled、Status、Transport、Tools、Resources、Lazy/Connected、Last probed、Last error、Actions。

详情抽屉：

- Identity / Protocol。
- Payload：stdio command/args/cwd 或 remote URL/transport。
- Discovered tools/resources。
- 高级：env、headers、OAuth、raw JSON import/export。
- 诊断：probe log、connection events。

#### Skills

表格列：

- Skill、Library、Source、Enabled、Scope、Dependencies、Last updated、Trust、Actions。

详情抽屉：

- Description、trigger keywords、allowed tools 摘要、source file。
- Enable/disable、update library、remove library。
- 高级：custom repo、SkillsMP install、session mount、combo recording。

#### Memory / Activity

表格或分组列：

- Type、Count、Last updated、Auto inject、Privacy、Source、Actions。

详情抽屉：

- 最近记忆摘要、来源会话、删除/禁用。
- 屏幕记忆：OpenChronicle daemon 状态、auto inject、blacklisted apps/URLs。
- 高级：raw memory files、audit、manual compact、import/export。
- 调试：ActivityContext preview、Native Desktop manual provider。

#### Workspace

表格列：

- Path、Current、Last used、Bridge status、Access level、Index/activity status、Actions。

详情抽屉：

- 默认目录、最近目录、打开/切换、show in folder。
- Local Bridge version/status。
- 高级：security level、web mode manual path、index rebuild。

#### Automation

表格列：

- Name、Enabled、Schedule、Next run、Last run、Latest status、Retries、Tags、Actions。

详情抽屉：

- Natural language prompt/create wizard。
- Schedule builder。
- Action：shell/webhook。
- Execution history、last output、failure reason。
- 高级：cron expression、timeout、max retries、retention。

#### Permission

表格和卡片：

- 顶部 posture cards：Default、Accept edits、Bypass（危险态要明显）。
- Rule table：Effect、Tool/Path、Scope、Source、Enabled、Last hit、Actions。
- Subagent inheritance card：strict-inherit、child-narrow、independent。

详情抽屉：

- 规则编辑、校验、冲突提示。
- 导入/导出规则。
- 高级：raw deny/ask/allow 文本。

## 5. 哪些设置必须产品化

必须产品化，进入主设置：

- Provider / Model：没有 provider，助手不可用；模型路由决定成本、速度和任务质量。
- Channel：飞书、Telegram、HTTP API 是“助手在哪里出现”的问题，且包含隐私边界。
- MCP：它决定外部工具和上下文来源，且有连接状态和可发现工具。
- Skills：它决定助手学会哪些可复用流程，是生活/工作助手的高频能力扩展。
- Memory：记忆是产品承诺，用户需要能看懂它记了什么、怎么删、什么时候注入。
- Workspace：当前工作目录和本地桥是 code-agent 作为工作助手的基础上下文。
- Automation：提醒、定时任务、周期执行是生活/工作助手的核心场景，不应藏在开发者菜单。
- Permission：安全姿态要明确可见，尤其是 shell、文件、浏览器、邮件、日历、提醒事项、外部通道。

主设置只给摘要或入口：

- Telemetry：给“本地诊断数据开启/关闭、占用、清理”摘要，不给普通用户原始 turn/event 表。
- Context Health：给“上下文占用来源摘要”，具体 bySource 树、intervention 和 token 明细放调试。
- Data & Storage：保留使用量、清理缓存、清理调试快照入口，但不要把调试快照摆成第一屏核心能力。

不该暴露给普通用户第一层：

- Eval Center、scoring config、test cases、subjective evaluator、review queue。
- Raw telemetry events、structured replay、system prompt hash、tool call timeline。
- MCP env/header/OAuth secret 原文、raw JSON import/export。
- Channel raw payload、脱敏前数据、`privacyMode=off`。
- Hook config 源文件、matcher、parallel observer/decision 细节。
- ToolModule registry 全量表、自我进化工具、dynamic tool creation。
- Context intervention get/set、memory audit dump、ActivityContext raw preview。

## 6. 推荐路线

### P0：把“对象管理”先立起来

目标：不重写底层能力，先把已有 Settings 和 Cron Center 的信息架构改成可运营。

1. 新建 Settings Console shell：先做截图式独立设置页，左侧固定导航、内容区居中、全高滚动。保留现有 tab 组件作为迁移过渡，不再用小弹窗承载所有对象。

2. 优先产品化 5 个表：Provider、Channel、MCP、Skills、Automation。它们已有 IPC 和状态事件，收益最大。

3. Permission 保留一级入口：顶部 posture card + rule count + subagent inheritance 摘要。deny/ask/allow 文本编辑先移入高级 drawer。

4. Memory 做“用户能读懂”的主视图：最近记忆摘要、类型统计、删除/禁用、屏幕记忆开关和黑名单。原始文件浏览放高级。

5. Telemetry/Eval 从普通 Settings 第一层隔离：Sidebar User Menu 或 Settings Console 的“调试/内部评测”分区承载。

验收口径：

- 用户能在一个地方看到“模型是否可用、通道是否在线、MCP 是否连上、Skills 是否启用、自动化是否运行、权限是否危险”。
- 不要求 P0 做完整批量操作，但至少有搜索、状态筛选、详情抽屉和只读健康状态。

### P1：补齐控制面动作和安全解释

1. 给 Provider/Channel/MCP 增加批量 test / refresh / enable / disable。

2. 给 Channel/MCP/Permission 做风险提示和冲突校验：raw payload、bypass、env secret、public webhook、allowed users 为空等。

3. Workspace 独立成主设置：当前目录、最近目录、本地桥、默认 workspace、索引状态。

4. Automation 改名和向导：从 Cron Center 转成 Automation Center，保留 cron code，但默认用视觉 schedule builder 和自然语言生成草稿。

5. Model routing 做矩阵：default/code/fast/vision/gui，每行显示 provider、model、last tested、fallback。

6. Skills 和 Memory 建立“来源/信任”概念：builtin、project、user、custom repo、session mounted 分开。

### P2：做配置治理和内部质量面

1. 配置 profile：工作模式、生活模式、低成本模式、离线模式、本地优先模式。

2. Settings health report：一键生成本地配置诊断，汇总 provider、MCP、channel、workspace、permission、automation。

3. Import/export config bundle：Provider 只导出 key status，不导出 secret；MCP/Channel 支持脱敏导出。

4. Debug Console：Telemetry、Context Health、Debug Snapshots、Doctor、ActivityContext、Computer-use diagnostics 放同一个调试入口。

5. Internal Eval Console：Eval Center、Review Queue、Scoring Config、Test Cases、Regression Baseline 明确挂内部开关。

6. 如果未来 code-agent 真的有多 Bot / 多助手实例，再考虑引入 Memoh 式 Bot Detail。当前不需要把个人助手做成 Bot fleet 管理。

## 7. 最小 IA 取舍

最小可行版本不需要重做视觉语言，也不需要概念大屏。推荐直接借鉴截图的设置页结构，再按对象页补管理后台能力：

- 外壳用独立页面或全高 overlay，宽度吃满主窗口，不再使用 `max-w-2xl` 小弹窗。
- 左侧导航宽 260 到 300，顶部有返回入口，导航项行高 40 到 44。
- 普通偏好页内容区居中，宽 880 到 1040，顶部留 56 到 80 的呼吸空间。
- 工作模式、权限姿态这类选择项用横向卡片；常规开关用设置行，label/说明在左，toggle/select 在右。
- 对象管理页内容宽 1120 到 1280，顶部工具条高度 48 到 56。
- 表格行高 40 到 48，状态点、类型 badge、错误 tooltip。
- 详情抽屉宽 420 到 520，基础信息在上，高级设置折叠，危险操作在底部。
- 对象表默认只展示常用字段，复杂字段进抽屉。
- 普通用户默认看不到 eval/debug 低频项，除非打开高级/调试模式。

对 code-agent 的判断：Settings 升级的价值来自对象化控制面。现在已经存在的运行对象需要可扫、可查、可诊断、可恢复。Memoh 给了对象管理的骨架，code-agent 要按个人生活/工作助手收敛主层，把平台运维、内部评测和开发调试分开。
