# Alma Skills / MCP / Plugins 对标研究

研究日期：2026-06-13

目标：核验 Alma 官方推荐/默认/featured 的 Skills、MCP、Plugins，识别它们如何从设置页进入会话页，再和 code-agent 现有能力入口对齐，给出可落地的推荐策略和开发切片。

边界：本研究最初只要求研究和方案；后续用户明确要求推进完整实现，本轮已按下文策略推进设置页与会话页落点。仍不 push，不开 PR。

## 核心判断

Alma 的三个能力层级不能混在一起抄：

| 层级 | Alma 官方事实 | 对 code-agent 的判断 |
| --- | --- | --- |
| Skills | 没有官方 featured/rank 排序。本地包里有 33 个 bundled skills，默认作为内置能力来源展示；只有 `programmatic-tools` 标了 `always-inject: true`。 | 不建议把 33 个全量当“推荐安装”。应按 code-agent 现有 builtin/native 能力做映射，只把缺口类和高频类放进推荐。 |
| MCP | `computer-use` 是 Alma app 在 macOS 上自动写入 `~/.config/alma/mcp.json` 的内置 MCP；远端 MCP registry 当前 37 个 server，其中 6 个 `featured: true`。registry 没有 default/builtin 字段命中。 | 建议把 `computer-use` 做成默认可见但默认不强启的本机能力；MCP featured 只进入“官方精选”货架，安装/启用仍按风险分层。 |
| Plugins | plugin registry 当前 8 个插件，其中 4 个 `featured: true`，没有 default/builtin 字段命中。类型包括 `ui`、`theme`、`provider`。 | 不能直接接到 code-agent 现有 skill-plugin marketplace。先做展示/研究态或 schema adapter，再谈安装。provider 插件要走更严格授权和秘密管理。 |

最明显的产品差异：Alma 会话页已经把 Skills 和 MCP 放进 composer 旁边的直接选择控件里；code-agent 现在会话页只真正做了 Skill 推荐，`CapabilitySuggestionStrip` 里 `capabilitySuggestions` 还是空数组，MCP/Connector 仍主要靠设置页和 `/mcp`、`/connectors` 诊断命令。

## 核验来源

本轮使用的 Alma 来源：

- Release notes：`/tmp/alma-update-20260613/release-notes-805-823.md`
- 旧 renderer：`/tmp/alma-update-20260613/old/extract/renderer-assets/index-DZO6LH4W.js`
- 新 renderer：`/tmp/alma-update-20260613/new/extract/renderer-assets/index-lrtJ1hZ1.js`
- Alma bundled skills：`/Applications/Alma.app/Contents/Resources/bundled-skills/*/SKILL.md`
- MCP registry：[ravitemer/mcp-registry registry.json](https://ravitemer.github.io/mcp-registry/registry.json)
- Plugin registry：[yetone/alma-plugins registry.json](https://raw.githubusercontent.com/yetone/alma-plugins/main/registry.json)

本轮使用的 code-agent 来源：

- MCP 推荐目录：`src/shared/constants/mcpCatalog.ts`
- MCP 设置页：`src/renderer/components/features/settings/tabs/MCPSettings.tsx`
- MCP Discover：`src/renderer/components/features/settings/tabs/McpDiscoverTab.tsx`
- 默认 MCP：`src/main/mcp/mcpDefaultServers.ts`
- Skills 推荐目录：`src/shared/constants/skillCatalog.ts`
- Skills 设置页：`src/renderer/components/features/settings/tabs/SkillsSettings.tsx`
- Skills Discover：`src/renderer/components/features/settings/tabs/SkillsDiscoverTab.tsx`
- 会话 skill 推荐：`src/renderer/components/features/chat/ChatInput/useSkillRecommendations.ts`
- 会话推荐条：`src/renderer/components/features/chat/ChatInput/CapabilitySuggestionStrip.tsx`
- ChatInput 实际接线：`src/renderer/components/features/chat/ChatInput/index.tsx`
- Plugins 设置页：`src/renderer/components/features/settings/tabs/PluginsSettings.tsx`
- Plugin marketplace 服务：`src/main/skills/marketplace/*`
- Connectors：`src/main/connectors/registry.ts`、`src/renderer/components/features/settings/sections/NativeConnectorsSection.tsx`

## Alma 官方事实

### Release notes 只给能力事件，不给推荐排序

v0.0.813 明确增加了 MCP bridge tool calling。v0.0.809 修复 skill selector 顶部按钮不可点击。v0.0.805 增加 plugin events 和 metadata，包括 finish reason、response ID、`chat.subagent.didComplete` hook。

这说明 805-823 这段 release notes 能证明能力层在持续推进，但不能证明“官方推荐项”。

### Skills：bundled 默认展示，没有 featured 排名

Alma app 内置 33 个 bundled skills：

`browser`、`computer-use`、`daily-report`、`discord`、`file-manager`、`image-gen`、`memory-management`、`music-gen`、`music-listener`、`notebook`、`plan-mode`、`programmatic-tools`、`reactions`、`scheduler`、`screenshot`、`self-management`、`self-reflection`、`selfie`、`send-file`、`skill-hub`、`skill-search`、`system-info`、`tasks`、`telegram`、`thread-management`、`todo`、`travel`、`twitter-media`、`video-reader`、`voice`、`web-fetch`、`web-search`、`xiaohongshu-cli`。

本地 frontmatter 里没有 `featured`、`recommended`、`rank`、`priority`。只有 `programmatic-tools` 带 `always-inject: true`，它属于默认注入提示，不等同于 marketplace 推荐排序。

Alma 会话页的 `SkillSelectorAction` 会从 `useSkills()` 取 enabled skills，按来源分组展示：`bundled`、`personal`、`claude-code`、`codex`、`marketplace`、`project`。支持 `Auto`、`Select all`、`Clear all`。会话输入的 slash picker 也支持 skill 项，选中后会插入 `<skill.name>` token，并更新当前 thread 的 `skillIds`。

### MCP：内置 computer-use + registry featured 6 个

Alma 的 `computer-use` 有两层：

- Bundled skill：`/Applications/Alma.app/Contents/Resources/bundled-skills/computer-use/SKILL.md`
- 内置 MCP 注册：解包文件 `computer-use-register-D1DB0ttr.js` 在 macOS 下把 `computer-use` 写入 `~/.config/alma/mcp.json`，指向 `bin/alma-computer-use-mcp.mjs`；packaged 状态下用 `process.execPath` 加 `ELECTRON_RUN_AS_NODE=1` 启动。

这更准确地说应归为“app-bundled MCP 自动注册”；远端 registry 没有把它声明成 default 项。

MCP registry 当前核验结果：

| 字段 | 结果 |
| --- | --- |
| `version` | `1.0.0` |
| `totalServers` | 37 |
| `featured: true` | 6 个 |
| default/builtin/isDefault 命中 | 0 |

Featured MCP：

| id | 名称 | 类别 | 安装方式 | 推荐判断 |
| --- | --- | --- | --- | --- |
| `context7` | Context7 | development | NPX、Remote | 默认推荐展示。文档场景高频，凭证负担低。 |
| `fetch` | Fetch | web-scraping | UVX、Docker、Proxy、User-Agent | 条件推荐。code-agent 已有 native web fetch，默认安装会重复。 |
| `firecrawl` | Firecrawl MCP Server | web-scraping | NPX、Self-hosted | 条件推荐。适合批量抓取，需要 API key。 |
| `github` | GitHub | development | Remote、Docker | 条件推荐。强依赖 token 和权限分层，建议默认只读模板。 |
| `playwright` | Playwright MCP | browser-automation | NPX、Vision、SSE port、Docker | 默认推荐展示。适合网页操作与验收，但要提示和 native browser 能力重叠。 |
| `task_master` | Task Master | project-management | NPX | 不做默认推荐。只给已使用 Task Master 项目的用户。 |

### Plugins：registry featured 4 个，但和 code-agent 当前插件模型不兼容

Plugin registry 当前核验结果：

| 字段 | 结果 |
| --- | --- |
| `version` | `1.0.0` |
| `lastUpdated` | `2026-04-23T09:00:00Z` |
| plugin 总数 | 8 |
| `featured: true` | 4 个 |
| default/builtin/isDefault 命中 | 0 |

Featured plugins：

| id | 名称 | 类型 | 作者 | 推荐判断 |
| --- | --- | --- | --- | --- |
| `token-counter` | Token Counter | `ui` | Alma Team | 默认展示为低风险 UI 示例。code-agent 已有 token/cost UI，更多是参考。 |
| `catppuccin-theme` | Catppuccin Theme | `theme` | Alma Team | 条件推荐。等 code-agent theme plugin API 明确后再安装。 |
| `openai-codex-auth` | OpenAI Codex Auth | `provider` | Alma Community | 条件推荐，高价值但涉及 OAuth、账号和 quota，必须显式授权。 |
| `cursor-auth` | Cursor Auth | `provider` | Alma Community | 条件推荐，只面向 Cursor 订阅用户，并需说明本地 proxy 行为。 |

Alma 会话页通过 `window.pluginCommands.getAll()` 把 plugin commands 放进 slash picker，通过 `window.pluginCommands.execute()` 执行。plugin settings 更新时，会重新 disable/enable plugin 并 activate 当前 thread。plugin provider 的 UI 入口在设置页，release notes 也提到了 provider icon picker。

## Alma 设置页到会话页的落点

### Skills

路径是：Settings `skills` 管理可用来源和启用状态；会话 composer 的 `SkillSelectorAction` 直接读取 enabled skills；slash picker 可搜索 skill 并插入 `<skill.name>` token；发送时会把 slash-selected skills 放入 message metadata 或 thread `skillIds`。

产品含义：Alma 把 skill 当作“本轮会话可显式选择的能力”，设置页只是管理入口。

### MCP

路径是：Settings `mcp` 管理 MCP server；会话 composer 的 Tools popover 内嵌 MCP section。它读取 enabled MCP servers、MCP tools 和 status，支持 refresh、select all、clear all、单 server switch。空状态有安装按钮，点击 `window.settingsWindow.open("mcp")`。

发送时，如果工具选择处于 auto，会把所有 enabled MCP server ids 传给 API；手动模式则传用户选中的 `selectedMCPServers`。

产品含义：Alma 把 MCP server 选择放在“本轮工具范围”里，让用户在会话中控制工具边界。

### Plugins

路径是：Settings `plugins` 管理插件生命周期和 provider；会话 slash picker 合并 plugin commands；plugin settings 更新后重载插件并刷新当前 thread。

产品含义：plugin 进入会话体验的路径主要是 commands、providers、status bar、主题等扩展点，并非 composer 里的独立“推荐卡”。

## 会话页编排借鉴

设置页解决的是“能力从哪里来、怎么安装、有没有权限”。会话页解决的是“这一轮任务到底用哪些能力、用户是否看得懂、出错时能不能原路修复”。Alma 最值得借鉴的是会话页的信息分层：Skills、MCP、Plugin commands 分别落在不同位置，用户聊天时不用再记每个能力藏在哪个设置分组。

### 可直接借鉴的会话页模式

| Alma 模式 | 产品价值 | code-agent 借鉴方式 |
| --- | --- | --- |
| Composer 旁边有 Skill selector | 用户能把 skill 当作本轮工作模式选择，`Auto / Select all / Clear all` 降低心智成本。 | 保留现有语义推荐，同时补一个“本轮 Skills”入口，展示已挂载、自动推荐、已安装未挂载三类。 |
| Tools popover 内嵌 MCP servers | MCP 从全局配置进入本轮 tool scope。用户能看到 enabled server、tool 数量、连接状态。 | 在 ChatInput 增加“本轮工具”入口，把 MCP 和 Connector 统一放进去；只展示已连接、可安全连接、需要配置三种状态。 |
| 空状态直接打开对应 Settings | 会话页发现缺能力时，不让用户自己找设置页。 | capability suggestion 点击后带上下文打开 MCP/Skills/Connector 设置，并定位到对应条目或配置面板。 |
| Slash picker 合并 skill 和 plugin commands | 高意图操作走命令，不占用 composer 常驻空间。 | `/` 继续承载 plugin command、diagnostic command、skill command；provider/theme/status 类插件不要挤进建议条。 |
| 自动模式和手动选择并存 | 新用户可以让系统自动选，重度用户可以限定本轮工具范围。 | ChatInput 需要一个 turn capability scope：`auto`、`selectedSkills`、`selectedMcpServers`、`selectedConnectors`、`selectedCommands`。 |

### code-agent 会话页应该补的编排层

建议把能力从“安装状态”拆成五层，不然设置页和会话页会互相抢职责：

| 层 | 含义 | UI 落点 |
| --- | --- | --- |
| Capability source | 能力来自 built-in、official featured、code-agent curated、user installed、project installed。 | Settings Discover / Capability Center。 |
| Runtime readiness | 是否已安装、已启用、有凭证、bridge 在线、权限可用。 | Settings connected tab；会话页只展示摘要和修复入口。 |
| Turn scope | 本轮会话实际允许模型使用哪些 skill/MCP/connector。 | Composer 工具栏、scope chips、Tools popover。 |
| Intent recommendation | 根据输入内容推荐要不要加某个能力。 | `CapabilitySuggestionStrip`，只放高置信、低噪音建议。 |
| Failure recovery | 执行前或执行中发现缺 key、没权限、server down。 | 会话内 blocked reason + 一键跳转设置项。 |

这个拆法的重点：Settings 仍然是配置主场，会话页只处理当前任务编排。用户在聊天框里看到的应该是“这轮要不要用 Context7 查文档”“Playwright 是否加入本轮验收”“Calendar connector 需要授权”。完整 marketplace 列表留在 Settings。

### 推荐的会话页信息架构

会话页可以分四个入口：

| 入口 | 放什么 | 不放什么 |
| --- | --- | --- |
| Skill selector | 已安装 skills、自动推荐 skills、当前 thread 已挂载 skills。 | 不放未安装 skill marketplace 长列表。 |
| Tools popover | MCP servers、native connectors、tool count、online/offline、turn selected scope。 | 不放 provider/theme 插件。 |
| Suggestion strip | 当前输入触发的 1-3 个高置信建议，比如“用 Context7 查库文档”“启用 GitHub MCP 查 PR”。 | 不放泛化推荐、不放远端 registry 排行榜。 |
| Slash command | plugin commands、诊断命令、显式技能调用。 | 不放需要用户先理解配置细节的复杂安装流。 |

当前 code-agent 已有 `CapabilitySuggestionStrip` 和 semantic suggestion helper，但实际 `ChatInput` 传的是空数组。这里是最短的产品差距：先不做完整新面板，也应该把 MCP/Connector 的高置信建议接进会话页，并让点击行为能进入“本轮 scope”或定位到配置项。

### 编排规则

- 会话页只推荐“当前输入能解释”的能力。比如用户写“查这个 repo 的 PR”，推荐 GitHub MCP；写“看日历”，推荐 Calendar connector；普通闲聊不出现能力货架。
- 已覆盖能力要说清楚。`fetch` 和 native web fetch、`playwright` 和 Browser/Computer Use、`token-counter` 和现有 token UI 都可能重复，建议文案要表达“互补/重复/已覆盖”。
- 高权限能力默认不自动加入本轮。`computer-use`、GitHub 写权限、provider auth、filesystem 类能力必须显式选择。
- 手动选择要可见。用户选了 Context7、Playwright 或某个 connector 后，composer 上应该有 scope chip；否则用户不知道模型为什么用了某个工具。
- 失败恢复要在原地发生。缺 key、未授权、server offline 时，会话页给 blocked reason 和跳转，不把用户丢回设置页首页。
- Plugin 借鉴要克制。Plugin command 可以进 slash picker；provider 进模型/provider 设置；theme 进入外观设置；status/UI 插件进入对应 slot，不做会话页推荐卡。

## code-agent 当前状态

### Skills

code-agent 已有三类入口：

- 内置 skills：`src/main/services/skills/builtinSkills.ts`，自动加载，用户可调用。
- 设置页 Skills：`installed / discover` 两个 tab。Discover 包含角色场景包、按场景浏览、SkillsMP 搜索、整库安装、自定义 GitHub 仓库。
- 会话输入：`useSkillRecommendations()` 根据输入语义拉 `SESSION_RECOMMEND`，可一键挂载已安装 skill，也可下载推荐来源仓库后挂载到当前会话。

差异：code-agent 的会话推荐只覆盖 Skill；Alma 的会话页还有独立 Skill selector 和 MCP server selector。

### MCP

code-agent 已有：

- 默认 MCP：`deepwiki` 默认 enabled，`sequential-thinking` 默认 enabled；`github` 和 `brave-search` 只有 token 存在才 enabled；`filesystem`、`git`、`sqlite`、`memory`、`puppeteer`、`docker` 默认 disabled；`cua-driver` 通过 `CODE_AGENT_ENABLE_CUA=1` 环境变量启用。
- 推荐目录：`src/shared/constants/mcpCatalog.ts` 里有离线兜底 curated catalog，含 `firecrawl`、`github`、`context7`、`playwright`，也含 `exa`、`tavily`、`deepwiki`、`memory`、`sequential-thinking` 等 code-agent 自己的老推荐项。
- 设置页：MCP Settings 有 `connected / discover` tab。Discover 根据 `builtin`、`requiredCredentials`、是否已配置，给出“启用 / 一键连接 / 连接”动作。
- 添加 server：Settings 添加的新 MCP 会写入项目 `.code-agent/mcp.json` 或 legacy `.mcp.json`，默认 `enabled: false`，stdio server 默认 `lazyLoad: true`。

差异：Alma 会话 composer 可以直接选 MCP server；code-agent 当前 ChatInput 没有 MCP suggestion，`CapabilitySuggestionStrip` 传入的 `capabilitySuggestions` 是空数组。`/mcp` 只能列状态，不能把某个 MCP 带入本轮。

### Plugins

code-agent 现在有两套容易混淆的“插件”概念：

- Settings `PluginsSettings` 使用 skill marketplace 服务，读取 `.code-agent-plugin/marketplace.json`、`.claude-plugin/marketplace.json` 或 `.kode-plugin/marketplace.json`。plugin entry 只描述 `name`、`description`、`source`、`skills`、`tags`、`version`、`author`。安装后默认禁用，管理员启用后普通用户才可见。
- Slash `/plugins` 命令走 `extensionOpsService`，管理 installed extensions。这和 Settings marketplace 并非同一套 Alma plugin registry schema。

差异：Alma plugin registry 的 `ui/theme/provider` 类型，code-agent 当前 marketplace schema 还不能表达。直接接入会丢失类型、授权、provider 生命周期和主题扩展点。

### Connectors

code-agent 原生 connectors 当前是 macOS `calendar`、`mail`、`reminders`、`photos`，按需注册。设置入口在 MCP 页的“运行状态与本地桥接”折叠区。Slash `/connectors` 可列状态。

会话语义建议工具里已经有 connector 匹配逻辑，但 ChatInput 目前没有把 capability suggestions 接进来。

## 推荐策略

### 默认推荐

这些应该进入“官方精选 / 推荐连接”第一屏，但不代表自动安装或自动启用：

| 项 | 类型 | 原因 | 默认动作 |
| --- | --- | --- | --- |
| `computer-use` | MCP + Skill | Alma app-bundled，code-agent 已有 CUA 迁移基础。高价值但高权限。 | 默认可见，默认 disabled，给权限/平台检查和显式启用。 |
| `context7` | MCP | Alma featured，低凭证负担，开发文档高频。 | 推荐安装；优先 remote 或 NPX；标注“和 native web/doc search 互补”。 |
| `playwright` | MCP | Alma featured，浏览器自动化和验收高频。 | 推荐安装；标注和 code-agent Browser/Computer 能力重叠，建议按任务选择。 |
| `token-counter` | Plugin | Alma featured，低风险 UI 类。code-agent 已有近似能力。 | 默认展示为参考/已覆盖，不作为立即安装项。 |

### 条件推荐

| 项 | 类型 | 条件 | 推荐动作 |
| --- | --- | --- | --- |
| `fetch` | MCP | 需要标准 MCP fetch server，或外部 MCP workflow 依赖它。 | 可安装，不默认启用；提示 code-agent native fetch 已覆盖普通读取。 |
| `firecrawl` | MCP | 批量抓取、站点 crawl、需要 Firecrawl API key。 | 推荐给研究/竞品/数据采集场景；凭证缺失时只展示配置。 |
| `github` | MCP | 用户有 GitHub token，并需要 MCP 统一工具面。 | 默认只读模板优先；写操作必须走权限确认。 |
| `openai-codex-auth` | Plugin provider | 用户要用 ChatGPT Plus/Pro OAuth 访问 Codex 模型。 | 做 provider 插件专项，不走现有 skill-plugin 安装链。 |
| `cursor-auth` | Plugin provider | 用户有 Cursor 订阅，并接受本地 OpenAI-compatible proxy。 | 做 provider 插件专项，显示 proxy 风险。 |
| `catppuccin-theme` | Plugin theme | code-agent theme plugin API 成熟后。 | 作为 theme plugin 验证样例。 |
| Alma 社交/媒体 bundled skills | Skill | 用户明确接 Telegram/Discord/Xiaohongshu、图片/音乐/视频/语音人格能力。 | 放到扩展推荐，不进入 coding 默认包。 |

### 不做默认推荐

| 项 | 类型 | 原因 |
| --- | --- | --- |
| `task_master` | MCP | 和 code-agent 自己的 planning/task/session 体系重叠，且 env keys 多，容易制造双任务源。只在已有 Task Master 项目里推荐。 |
| 全量 Alma bundled skills | Skill | 大量偏个人助理/社交/媒体/人格成长，不适合 code-agent 默认工作面。应按场景映射。 |
| Alma plugin registry 直接安装 | Plugin | schema 不兼容。当前 code-agent plugin marketplace 只能安装 skill plugin，不能安全表达 `ui/theme/provider`。 |

## P0 开发切片

### P0.1 官方 registry 归一化和本地 fallback

目标：把 Alma MCP registry 和 plugin registry 作为外部事实源接入，但输出到 code-agent 自己的安全 schema。

范围：

- 新增 MCP registry normalizer：读取 `servers[]`，保留 `id/name/description/category/tags/featured/verified/installations/required parameters`。
- 新增 plugin registry normalizer：读取 `plugins[]`，保留 `id/name/type/tags/featured/version/author/repository/path`，先只做展示和策略判断。
- 本地 fixture/fallback 固化 2026-06-13 核验结果，避免远端不可用时推荐页空白。
- 将 featured 与 code-agent curated catalog 合并时保留来源：`source: alma_featured | code_agent_curated | builtin`。

验收：

- 单测断言 MCP total 37、featured 6，plugin total 8、featured 4。
- 单测断言 default/builtin/isDefault 命中为空，不把 featured 错写成 default。
- 断网时 Settings Discover 仍能显示 fallback。

### P0.2 MCP Discover 重排：官方精选优先，但不丢本地 curated

目标：Settings MCP Discover 第一屏对齐 Alma featured，同时保住 code-agent 已有本机/国内/云端推荐。

范围：

- 在 `McpDiscoverTab` 顶部新增“官方精选”区：Context7、Playwright、Fetch、Firecrawl、GitHub、Task Master。
- 对每项显示 `featured`、`verified`、凭证需求、传输方式、风险提示。
- `computer-use` 独立为“本机能力”卡片，显示当前平台、CUA env gate、权限状态。
- 原 `按用途浏览` 保留，作为第二层分类，不再把 Exa/Tavily 这类老推荐压在官方项前面。

验收：

- 无凭证的 Context7/Playwright 可走一键连接或打开预填配置。
- Firecrawl/GitHub 不因缺 key 自动启用，只打开配置面板。
- Task Master 显示“项目内使用时推荐”，不在默认一键连接按钮上制造强引导。

### P0.3 会话页编排：Turn scope + MCP/Connector 推荐

目标：补齐 code-agent 和 Alma 的核心差距，让能力能从设置页进入本轮会话，并且让用户看得见本轮到底允许哪些能力参与。

范围：

- 在 ChatInput 建一个轻量 turn capability scope，至少表达 `auto`、`selectedSkills`、`selectedMcpServers`、`selectedConnectors`。
- Composer 工具栏增加“本轮工具”入口，汇总 MCP servers 和 native connectors 的 ready/needs-config/offline 状态。
- 用 scope chips 展示用户已选能力，例如 `Context7`、`Playwright`、`Calendar`；chip 可移除，避免一次选择变成隐形全局状态。
- 把 `buildCapabilitySemanticSuggestions()` 真接进 ChatInput，不再传空数组。
- 先排除高风险未配置 MCP，只推荐已 enabled/connected 或可安全配置的项。
- 点击 MCP 建议时打开 MCP Settings 对应条目或把已 connected server 加入本轮 selected scope；缺 key、未授权、server offline 时在会话页显示 blocked reason。
- 点击 Connector 建议时走已有 quick action：probe、repair permission、open settings。
- Slash picker 保持 command 型入口：plugin commands、诊断命令、显式 skill 调用继续放在 `/`，不挤到建议条里。

验收：

- 输入“查 GitHub PR”时，如果 GitHub MCP 已 connected，会出现 MCP 建议并能加入本轮。
- 输入“看日历”时，Calendar connector 出现建议；未授权时展示修复/检查动作。
- 当前 turn scope 里能看到 selected Skill/MCP/Connector，移除 chip 后本轮不再传入对应能力。
- Auto 模式下发送会包含已 enabled 且安全的 MCP/Connector；手动模式只传 selected scope。
- 缺 key 或权限失败时，会话内显示可理解的 blocked reason，并能定位回对应设置项。

### P0.4 Skills 推荐映射，避免全量照搬

目标：把 Alma bundled skills 转成 code-agent 可理解的默认/条件推荐表。

范围：

- 新增一份 mapping：Alma bundled skill -> code-agent builtin/native/marketplace recommendation。
- 对 `browser`、`computer-use`、`screenshot`、`web-search`、`web-fetch`、`file-manager`、`tasks`、`scheduler`、`memory-management`、`thread-management` 做默认可见映射。
- 对 `telegram`、`discord`、`xiaohongshu-cli`、`image-gen`、`music-gen`、`voice` 等做条件推荐。
- 不自动下载第三方 skill repo；只在 Settings/Chat recommendation 中解释来源和替代能力。

验收：

- Settings Skills Discover 能看到“Alma bundled 对标”分组。
- 已由 native 覆盖的项显示“已覆盖”，不会诱导重复安装。
- 会话关键词命中时仍走现有 mount/install 流程。

## P1 开发切片

### P1.1 Alma plugin registry schema adapter

目标：让 `ui/theme/provider` plugin 类型进入 code-agent 插件系统，避免塞进 skill marketplace。

范围：

- 扩展 plugin manifest schema，支持 `ui`、`theme`、`provider`、`command`、`skill`。
- provider 插件接入模型/provider 设置页，不直接进入普通 skill runtime。
- theme 插件接入 Appearance/Theme Config。
- ui 插件限定 status bar/sidebar/widget slot，并有权限声明。

验收：

- `token-counter` 可作为 UI 插件样例显示，但如果 native 已覆盖，标为已覆盖。
- `catppuccin-theme` 可作为 theme 插件样例加载/卸载。
- provider 插件必须有独立授权页、secret storage、撤销入口。

### P1.2 官方推荐策略服务

目标：把“featured、默认推荐、条件推荐、不推荐”做成策略层，不散落在 UI。

范围：

- 新增 recommendation policy：输入 registry item + 本机能力 + 用户配置，输出 `default_visible | conditional | not_default | unsupported`。
- policy 输出原因、风险、重复能力提示。
- Settings、ChatInput、Capability Center 复用同一份策略。

验收：

- Context7/Playwright 在新用户第一屏默认可见。
- Fetch 因 native web fetch 存在被标记为条件推荐。
- Task Master 不出现在默认一键连接区。

### P1.3 远端 registry 刷新、签名和审计

目标：解决供应链和漂移风险。

范围：

- registry 定时刷新，保留 last good snapshot。
- 对来源 URL、hash、reviewedAt、expiresAt 做审计记录。
- MCP install config 里的 command/env/header 过安全 normalizer。
- plugin provider 类必须有额外审批。

验收：

- registry 改动能在 Capability Center 看到 diff。
- 可回滚到 last good snapshot。
- 恶意 command 不会被一键安装。

## 实现计划

### 总体顺序

优先级按“用户能不能在会话里用起来”排序：

1. 先做会话页最小闭环：turn scope、scope chips、MCP/Connector suggestion、blocked reason。
2. 再做 Settings Discover 的官方精选：Alma MCP featured、`computer-use` 本机能力卡、重复能力提示。
3. 再做 Skills 映射：把 Alma bundled skills 对齐到 code-agent 已覆盖/可推荐/条件推荐。
4. 最后做 Plugin registry adapter：先开放 provider/theme/UI 受管资产安装，真实运行、授权、主题应用和 UI slot 仍由专门 surface 控制。

这样排的原因很直接：单纯把 featured 放进设置页，用户仍然不知道当前任务该不该用、用了哪些、哪里缺配置。会话页先跑通后，Settings 里的推荐才有真实落点。

### Phase 0：能力状态模型和 scope 契约

目标：先统一“能力是否可用于本轮”的表达，避免每个 UI 自己判断。

范围：

- 新增或整理共享类型：`CapabilitySource`、`CapabilityReadiness`、`TurnCapabilityScope`、`CapabilitySuggestion`。
- `TurnCapabilityScope` 至少包含：`mode: auto | manual`、`selectedSkills`、`selectedMcpServers`、`selectedConnectors`。
- readiness 统一成：`ready`、`needs_config`、`needs_permission`、`offline`、`unsupported`、`blocked_high_risk`。
- 把现有 enabled skills、MCP server status、native connector status 映射到同一份 view model。

建议文件：

- `src/shared/*`：放跨进程类型和 policy 输出。
- `src/renderer/components/features/chat/ChatInput/*`：消费 scope。
- `src/main/mcp/*`、`src/main/connectors/*`：提供状态映射所需字段，不改协议语义。

验收：

- 单测覆盖 MCP、Connector、Skill 三类 readiness。
- 没有 UI 时也能从 fixture 得到稳定的 `TurnCapabilityScope` 默认值。
- Auto 模式不会包含 `blocked_high_risk` 或 `needs_config` 能力。

### Phase 1：会话页编排 MVP

目标：让用户在 composer 上看到本轮能力，并能加入、移除、修复。

范围：

- 把 `buildCapabilitySemanticSuggestions()` 接入 `ChatInput`，替换当前空的 `capabilitySuggestions={[]}`。
- 在 composer 工具区加“本轮工具”入口，先覆盖 MCP servers 和 native connectors。
- 增加 scope chips：用户选择 Context7、Playwright、Calendar 后，composer 上能看到并移除。
- 点击 suggestion 的行为分三类：
  - `ready`：加入本轮 scope。
  - `needs_config` / `needs_permission`：打开对应设置项，并保留当前意图上下文。
  - `offline` / `unsupported`：在会话页显示原因，不静默失败。
- 发送消息时把 turn scope 传入现有 agent/tool 选择链路；如果底层暂时只支持 MCP servers，先只落 MCP，Connector 先保留 UI 和 blocked reason。

建议文件：

- `src/renderer/components/features/chat/ChatInput/index.tsx`
- `src/renderer/components/features/chat/ChatInput/CapabilitySuggestionStrip.tsx`
- `src/renderer/components/features/chat/ChatInput/useSkillRecommendations.ts`
- 可能新增 `useTurnCapabilityScope.ts` 或同级 store。

验收：

- 输入“查 GitHub PR”，GitHub MCP ready 时出现建议，点击后出现 chip，发送时 scope 包含 GitHub。
- 输入“看日历”，Calendar connector 未授权时出现修复入口，点击能定位到 connector 权限处理。
- 移除 chip 后重新发送，本轮不再带对应能力。
- Auto 模式和手动模式切换后，scope 行为可预测。

### Phase 2：Settings MCP 官方精选

目标：把 Alma 官方 featured 放进配置入口，但不让它们自动变成默认启用。

范围：

- 新增 MCP registry normalizer 和 2026-06-13 fallback fixture。
- 在 `McpDiscoverTab` 增加“官方精选”区：Context7、Playwright、Fetch、Firecrawl、GitHub、Task Master。
- `computer-use` 做独立“本机能力”卡，显示平台、权限、env gate、启用状态。
- 对重复能力加标签：
  - `fetch`：native web fetch 已覆盖普通读取。
  - `playwright`：和 Browser/Computer Use 有重叠，但适合标准 MCP workflow。
  - `github`：有 token 时推荐，只读优先。
  - `task_master`：项目检测到后再推荐。

建议文件：

- `src/shared/constants/mcpCatalog.ts`
- `src/renderer/components/features/settings/tabs/McpDiscoverTab.tsx`
- `src/renderer/components/features/settings/tabs/MCPSettings.tsx`
- 可新增 `src/shared/constants/almaMcpRegistryFallback.ts`

验收：

- 断网时也能展示 fallback 官方精选。
- Featured 显示为“官方精选”，不写成 default。
- 缺 key 的 Firecrawl/GitHub 只进入配置，不自动启用。
- `computer-use` 未满足平台或 env gate 时展示原因。

### Phase 3：设置页与会话页回跳闭环

目标：从聊天框发现缺能力后，用户能准确跳到配置位置，配置完能回到当前任务。

范围：

- 增加 settings deep link：`mcp:<id>`、`connector:<id>`、`skill:<id>`。
- suggestion 点击 `needs_config` 时打开对应配置项。
- 配置完成后刷新 readiness，并保留当前 input/context。
- 会话内 blocked reason 复用 readiness reason，避免 UI 和执行层说法不一致。

验收：

- GitHub MCP 缺 token 时，从会话页点击能到 GitHub MCP 配置区域。
- Calendar connector 缺权限时，从会话页点击能触发 probe/repair flow。
- 配置完成后回到会话页，suggestion 状态从 `needs_config` 变成 `ready`。

### Phase 4：Skills 映射与推荐收口

目标：把 Alma bundled skills 变成 code-agent 能用的推荐策略，不照搬成 33 个安装项。

范围：

- 建 Alma bundled skill mapping：
  - 已覆盖：`browser`、`web-fetch`、`web-search`、`screenshot`、`file-manager`、`tasks`、`thread-management`。
  - 默认可见：`computer-use`、`memory-management`、`scheduler`。
  - 条件推荐：`telegram`、`discord`、`xiaohongshu-cli`、`image-gen`、`music-gen`、`voice`。
- Settings Skills Discover 增加“Alma bundled 对标”分组。
- 会话页建议只在当前输入命中时出现，不做常驻列表。

验收：

- 已覆盖项显示“已覆盖/无需安装”。
- 条件推荐项只有明确场景命中才出现。
- 不自动下载或启用第三方 skill repo。

### Phase 5：Plugin registry adapter

目标：先解决 schema 和安全边界，再考虑安装。

范围：

- Plugin registry normalizer 读取 Alma registry，识别 `ui`、`theme`、`provider`。
- Settings 插件页展示 registry item、风险和可安装为受管资产的边界。
- `token-counter` 标为 UI 示例或已覆盖。
- `catppuccin-theme` 等 theme 插件等待 Appearance/Theme API。
- `openai-codex-auth`、`cursor-auth` 等 provider 插件进入单独 provider 专项，不能混进 skill marketplace。

验收：

- registry featured 4 个能展示类型和风险。
- provider 插件可以安装为受管资产；没有 secret storage 和撤销入口前不能完成 OAuth 授权或接入模型运行时。
- Slash picker 只接 command 型 plugin，不接 provider/theme。

### 推荐排期

| 顺序 | 交付 | 价值 | 风险 |
| --- | --- | --- | --- |
| 1 | Phase 0 + Phase 1 | 会话页能选择和解释本轮能力，补最大产品差距。 | 需要确认 send payload 支持范围。 |
| 2 | Phase 3 | 缺配置时能原地修复，降低断流。 | 需要 settings deep link 稳定。 |
| 3 | Phase 2 | Alma MCP featured 在 Settings 有官方精选入口。 | 远端 registry 漂移，需要 fallback。 |
| 4 | Phase 4 | Skills 推荐更完整，但不干扰 coding 主路径。 | 映射文案要避免过度承诺。 |
| 5 | Phase 5 | Plugins 进入正确架构。 | provider/theme/UI slot 边界不清时不要推进运行时执行和授权。 |

### 第一轮建议切到多小

第一轮实现只做：

- `TurnCapabilityScope` 类型和默认 reducer。
- ChatInput 接入 MCP/Connector semantic suggestions。
- 一个“本轮工具”popover。
- ready 能力可加入 chip，chip 可移除。
- needs_config 能跳到 Settings 对应项。
- 不接远端 registry，不做 plugin adapter，不做 Skills 全量映射。

第一轮做完后，产品上已经能验证核心假设：用户是否愿意在会话页选择本轮工具，以及 suggestion 是否真的减少找设置页的成本。

## 推荐完整实现目标

建议完整实现的目标是把 code-agent 的能力发现、配置、会话选择、执行和修复做成闭环。Alma 的列表只作为官方事实来源，不作为照搬清单。完整实现可以分成三档。

### 必须完整实现

这些目标建议做成正式产品能力，不停在研究态或半入口状态。

| 目标 | 完整实现标准 | 原因 |
| --- | --- | --- |
| 会话页 turn scope | Composer 可见本轮 Skills/MCP/Connectors；支持 auto/manual；scope chips 可加可删；发送 payload 真实生效。 | 这是 Alma 最值得借鉴的核心。没有它，Settings 推荐只是货架。 |
| MCP 官方精选 | Alma featured MCP + code-agent curated MCP 合并展示；区分 official featured、builtin、curated；安装和启用分离。 | MCP 是最接近 code-agent 主工作流的能力层，收益最高。 |
| Settings 到会话页回跳 | 会话页发现缺 key、缺权限、server offline 时，可定位到对应配置项；配置后 readiness 刷新。 | 用户不用在设置页里重新找能力，能把当前任务继续做完。 |
| `computer-use` 本机能力卡 | 平台、权限、env gate、启用状态、风险说明完整；默认可见，默认不强启。 | Alma 既有 bundled skill 又有 app-bundled MCP，code-agent 也需要把本机控制能力讲清楚。 |
| 能力推荐策略层 | `default_visible`、`conditional`、`not_default`、`unsupported` 由统一 policy 输出，Settings 和 ChatInput 共用。 | 避免同一个能力在设置页被推荐、会话页又被隐藏，或风险文案不一致。 |

完整实现后的用户路径应该是：

1. Settings Discover 看到官方精选和本机能力。
2. 用户连接或启用能力。
3. 会话输入触发高置信建议。
4. 用户把能力加入本轮 scope。
5. 发送时 scope 真实进入工具选择。
6. 缺配置或失败时，会话页给原因并能回跳设置项。

### 条件完整实现

这些目标有价值，但要按产品定位和安全边界推进。

| 目标 | 推进条件 | 完整实现标准 |
| --- | --- | --- |
| Alma bundled skills 映射 | 会话页 turn scope 已稳定，Settings Discover 已能表达“已覆盖/条件推荐”。 | 33 个 bundled skills 全部有映射结论：已覆盖、默认可见、条件推荐、暂不支持。 |
| Skills 会话选择器 | 现有 `useSkillRecommendations()` 和 mounted skill 逻辑已稳定。 | 用户能在 composer 里看已挂载 skills、自动推荐 skills、已安装未挂载 skills。 |
| Connector 纳入本轮工具 | MCP scope 已跑通，native connector readiness 能稳定返回权限和在线状态。 | Calendar/Mail/Reminders/Photos 可作为本轮能力被建议、加入、移除、修复权限。 |
| Plugin commands 进 slash | 插件命令已有稳定 command manifest 和权限声明。 | command 型插件可在 `/` 搜索和执行；执行失败能显示来源和修复入口。 |

### 暂缓完整实现

这些不要在第一波完整实现里硬做，否则容易把安全、账号和插件架构一起搅乱。

| 目标 | 暂缓原因 | 当前建议 |
| --- | --- | --- |
| Alma plugin registry 直接执行 | `ui/theme/provider` runtime、secret storage、theme injection 和 UI slot 生命周期还需要专门权限模型。 | 可以安装为受管资产；不自动执行第三方代码、不自动应用主题、不自动 OAuth 授权。 |
| provider 插件安装 | 涉及 OAuth、secret storage、quota、撤销和本地 proxy。 | 单独做 provider 插件专项，不能跟普通 skill/plugin 安装混跑。 |
| theme/UI 插件通用 slot | code-agent 需要先定义 Appearance、status bar、sidebar/widget slot 生命周期。 | 先用 `token-counter`、`catppuccin-theme` 做设计样例。 |
| `task_master` 默认推荐 | 容易和 code-agent 自己的 planning/task/session 体系冲突。 | 只在项目检测到 Task Master 配置时推荐。 |
| 全量 Alma social/media skills | 偏个人助理和社交媒体场景，偏离 code-agent 主路径。 | 条件推荐，按输入意图或用户启用对应生态后出现。 |

### 完整实现的边界

完整实现不等于默认启用，也不等于自动安装：

- Official featured 只代表“官方精选”，不能写成 default。
- 高权限能力默认不进 auto scope，必须用户显式选择。
- 缺 key、缺权限、server offline 的能力可以推荐配置，不能静默加入本轮。
- 已被 native 覆盖的能力要显示“已覆盖/互补”，避免重复安装。
- Plugin provider/theme/UI 可以进入 marketplace 安装记录和资产目录；真实运行能力需要专门 schema、权限模型和对应 surface，不能当作 skill 直接暴露。

### 推荐完整实现路线

| 阶段 | 要完整做到什么 | 可以暂时不做 |
| --- | --- | --- |
| 第一阶段 | Turn scope + 会话页本轮工具 + MCP/Connector suggestion + 设置页回跳。 | 远端 registry 刷新、plugin adapter、Skills 全量映射。 |
| 第二阶段 | MCP 官方精选 + `computer-use` 本机能力卡 + fallback fixture + policy 共用。 | Plugin provider 安装、theme/UI slot。 |
| 第三阶段 | Alma bundled skills 映射 + Skills composer selector。 | 社交/媒体 skills 的自动安装。 |
| 第四阶段 | Plugin registry 展示 + schema adapter 设计 + command 型插件 slash 接入。 | provider 插件真实授权安装。 |
| 第五阶段 | Provider/theme/UI 插件专项，补 secret storage、撤销、slot 生命周期。 | 无明确权限模型的第三方插件安装。 |

最终推荐：完整实现会话页编排和 MCP 推荐闭环；Skills 做完整映射但克制安装；Plugins 做完整 schema 设计，安装能力分阶段开放。

## 本轮实现落点

本轮已把推荐策略推进到会话页和设置页的闭环，但仍遵守“不默认启用、不自动安装”的边界。

| 阶段 | 已实现 | 验收点 |
| --- | --- | --- |
| Phase 0：能力状态模型 | `ConversationEnvelopeContext`、message metadata、turn timeline 增加 `turnCapabilityScopeMode`；workbench registry 增加统一 `turnReadiness`：`ready`、`needs_config`、`needs_permission`、`offline`、`unsupported`、`blocked_high_risk`；每个能力项补 `autoAllowed`。 | registry、scope inspector、current turn scope、turn clarity 测试覆盖 Skill/MCP/Connector 三类状态；高风险 MCP 即使 connected 也不会进入 auto allowed。 |
| Phase 1：会话页编排 | `CapabilitySuggestionStrip` 接入 Skill / MCP / Connector 的语义建议；点击 ready 能力加入本轮 scope；缺配置、缺权限或离线时显示原因并回跳设置页；`InlineWorkbenchBar` 增加 Auto/Manual 和 scope chips。 | ChatInput、InlineWorkbenchBar、composerStore、workbenchToolScope 测试确认建议、选择、移除、发送 metadata 和 toolScope 都生效。 |
| Phase 2：MCP 官方精选 | 新增 Alma MCP registry normalizer 和 2026-06-13 fallback；`McpDiscoverTab` 增加 Alma 官方精选区，覆盖 `context7`、`fetch`、`firecrawl`、`github`、`playwright`、`task_master`；`computer-use` 以本机高权限能力卡展示，对齐 `cua-driver`。 | MCP catalog 测试确认 featured 只作为 official featured，不被写成 default；远端 payload 无效时使用本地 snapshot。 |
| Phase 3：设置页回跳 | `appStore` 增加 `openCapabilitySettingsTarget()` 和 typed focus；会话页可把 `skill:<id>`、`mcp:<id>`、`connector:<id>` 打开到 Skills/MCP 设置页；设置页显示来自会话页的定位提示。 | appStore、MCPSettings、SkillsSettings 相关测试确认 tab 和 focus 状态正确。 |
| Phase 4：Skills 映射 | `skillCatalog` 增加 33 个 Alma bundled skills 的映射结论；`SkillsDiscoverTab` 增加“Alma bundled skills 对标”分组，区分已覆盖、默认可见、条件推荐、暂不支持。 | recommendedSkillCatalog 测试确认 33 个 bundled skills 全量有映射，且不触发自动下载。 |
| Phase 5：Plugin registry adapter | 新增 Alma plugin registry normalizer，支持 `ui`、`theme`、`provider`、`command`；`PluginsSettings` 展示 4 个 featured plugin 的类型、策略和风险；code-agent marketplace schema 现在支持 `types`、`commands`、`repository/path`，安装时会复制插件资产到用户级或项目级 `plugins/<spec>/`；command 型插件启用后会把 `.md` command 文件复制到现有 prompt command 目录。 | pluginsSettings 测试确认当前 `ui/theme/provider` featured 可安装为受管资产但不进入 slash picker；marketplace installService 测试确认 provider 插件安装后默认不可见，启用只切生命周期状态，不暴露 skill/command，卸载会移除资产目录；command 插件安装后默认不可见，启用后进入 `/` prompt command，禁用后移除。 |

本轮已放开 provider/theme/UI 插件的真实安装，但安装语义限定为“受管资产安装”：复制插件文件、记录类型、支持启用/禁用/卸载、显示资产目录。仍没有把 provider OAuth、theme 应用、UI slot 执行或第三方 JS runtime 一并放开，这些必须继续走各自 surface 的权限和审计。

## 剩余专项实现落点

用户继续要求推进“剩下没完成的几个专项”后，本轮把 P1 专项推进到安全可审计边界：

| 专项 | 已实现 | 仍不开放 |
| --- | --- | --- |
| 官方推荐策略服务 | 新增 `almaRecommendationPolicy`，统一输出 `default_visible`、`conditional`、`not_default`、`unsupported`，并给 MCP、Skill、Plugin 三类返回 action、reason、risk。MCP Discover、Skills Discover、Plugins Settings 已改为消费共享策略。 | 不把 featured 解释为自动启用；不让 UI 自己重新定义推荐等级。 |
| Registry 审计与漂移 | 新增 `almaRegistryAudit`，固化 MCP/Plugin registry source URL、reviewedAt、version、total、featuredIds、defaultFlagMatches、fingerprint，并提供 live-shaped payload audit 和 drift report；主进程新增 `refreshAlmaRegistryAudit()` 和 `alma-registry:audit-refresh` IPC，MCP/Plugins 设置页可手动刷新并看到漂移摘要。 | 暂不做后台定时远端刷新、签名校验和自动安装更新；远端变化只进入审计/差异判断。 |
| Plugin schema adapter | `almaPluginRegistry` 新增 code-agent adapter spec：`ui -> status_bar`、`theme -> theme`、`provider -> provider`、`command -> slash_command`，每项输出 installability、canInstall、canExposeInSlash、requiredRuntimeCapabilities 和 unsupportedReason。Plugins Settings 展示 adapter 结果；code-agent marketplace 新增 `types`、`repository/path` 和受管资产安装目录，启用时 command 复制到用户级或项目级 `commands` 目录，禁用/卸载时移除，目标已有同名 command 时拒绝覆盖。 | provider/theme/UI 插件可安装、启停和卸载；仍不自动执行任意 JS、不自动应用 theme、不自动完成 provider OAuth 或启动本地 proxy。 |

这三个专项的目标不是“把所有 Alma plugin 装起来”，而是先把推荐、审计、适配边界做成共享事实。这样后续真做 provider OAuth、theme API、UI slot 或 registry 后台刷新时，不需要再从页面文案里反推策略。

本轮已跑过的核心验证：

- `npx vitest run tests/renderer/stores/appStore.test.ts tests/renderer/components/mcpSettings.status.test.ts tests/unit/app/agentAppService.lifecycle.test.ts tests/renderer/components/capabilitySuggestionStrip.test.ts tests/renderer/components/inlineWorkbenchBar.preview.test.ts tests/renderer/stores/composerStore.test.ts tests/renderer/utils/workbenchCapabilityRegistry.test.ts tests/renderer/utils/workbenchScopeInspector.test.ts tests/unit/app/workbenchTurnContext.test.ts tests/unit/tools/workbenchToolScope.test.ts tests/unit/services/mcp/mcpCatalog.test.ts tests/renderer/components/pluginsSettings.test.ts tests/unit/services/skills/recommendedSkillCatalog.test.ts tests/renderer/hooks/useCurrentTurnCapabilityScope.test.ts tests/renderer/hooks/useTurnExecutionClarity.test.ts tests/renderer/components/traceNodeRenderer.launchRequest.test.ts tests/renderer/components/taskPanel.taskMonitor.scopeInspector.test.ts tests/renderer/utils/runWorkbenchProjection.test.ts`
- 结果：18 files / 158 tests passed。
- `npx vitest run tests/unit/shared/workbenchPreset.test.ts tests/renderer/stores/workbenchPresetStore.test.ts tests/unit/shared/sessionWorkspace.test.ts tests/renderer/components/chatView.sessionWorkspace.test.ts tests/renderer/components/sessionWorkspaceBar.test.ts tests/renderer/components/chatView.sessionWorkspace.actions.test.ts`
- 结果：6 files / 21 tests passed。
- `npx vitest run tests/unit/shared/almaRecommendationPolicy.test.ts tests/unit/shared/almaRegistryAudit.test.ts tests/renderer/components/pluginsSettings.test.ts tests/unit/services/mcp/mcpCatalog.test.ts tests/unit/services/skills/recommendedSkillCatalog.test.ts tests/renderer/components/mcpSettings.status.test.ts`
- 结果：6 files / 45 tests passed。
- `npx vitest run tests/renderer/stores/appStore.test.ts tests/renderer/components/mcpSettings.status.test.ts tests/unit/app/agentAppService.lifecycle.test.ts tests/renderer/components/capabilitySuggestionStrip.test.ts tests/renderer/components/inlineWorkbenchBar.preview.test.ts tests/renderer/stores/composerStore.test.ts tests/renderer/utils/workbenchCapabilityRegistry.test.ts tests/renderer/utils/workbenchScopeInspector.test.ts tests/unit/app/workbenchTurnContext.test.ts tests/unit/tools/workbenchToolScope.test.ts tests/unit/services/mcp/mcpCatalog.test.ts tests/renderer/components/pluginsSettings.test.ts tests/unit/services/skills/recommendedSkillCatalog.test.ts tests/renderer/hooks/useCurrentTurnCapabilityScope.test.ts tests/renderer/hooks/useTurnExecutionClarity.test.ts tests/renderer/components/traceNodeRenderer.launchRequest.test.ts tests/renderer/components/taskPanel.taskMonitor.scopeInspector.test.ts tests/renderer/utils/runWorkbenchProjection.test.ts tests/unit/services/almaRegistryAuditService.test.ts tests/unit/shared/almaRegistryAudit.test.ts tests/unit/shared/almaRecommendationPolicy.test.ts tests/unit/skills/marketplace/installService.test.ts tests/unit/skills/marketplace/marketplaceService.test.ts`
- 结果：23 files / 171 tests passed。
- `npm run typecheck` 通过。
- `git diff --check` 通过。

## 风险

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| featured 被误解成 default | 用户以为官方要求默认启用 | UI 文案明确“官方精选”，安装/启用分离。 |
| native 能力和 MCP 重复 | 工具变多、模型选择混乱 | 推荐策略里显示“已覆盖/互补/重复”。 |
| MCP 安装 config 启动本地命令 | 供应链和本机权限风险 | stdio command 白名单/黑名单、默认 disabled、审批启动。 |
| GitHub/Firecrawl/provider secrets | token 泄露或权限过大 | Secret storage、read-only 模板、权限说明、撤销入口。 |
| Plugin runtime 不兼容 | 安装后误以为已授权或已运行 | 安装只落受管资产；provider/theme/UI 执行必须另走授权、预览、回滚和 slot 权限。 |
| registry 远端漂移 | featured 列表变化导致 UI 不稳定 | 快照、hash、reviewedAt、last good fallback。 |
| Task Master 双任务源 | 与 code-agent 计划/任务体系冲突 | 仅项目检测到 Task Master 时推荐。 |
| 会话页能力提示过多 | 用户在输入时被 marketplace 噪音打断 | 会话页只放当前输入可解释的建议，完整货架留在 Settings/Discover。 |

## 结论

建议采用“两层推荐 + 一层会话编排”：

1. 官方事实层：完整保留 Alma bundled skills、MCP featured、plugin featured 的来源、字段和核验时间。
2. code-agent 策略层：基于本机已有能力、权限风险、凭证需求和产品定位，决定默认可见、条件推荐、只作参考或暂不支持。
3. 会话编排层：把已安装/已连接能力转成当前 turn scope，让用户在 composer 上看到本轮用什么、为什么推荐、缺什么配置、如何修复。

短期最值得做的是 MCP 和会话页编排一起做：Settings Discover 用 Alma featured 做第一屏，会话页用 turn scope、Tools popover、scope chips 和高置信 suggestion 把已配置/可用 MCP 接进当前任务。Skills 只做映射，不全量照搬。Plugins 可以安装 Alma registry 的 provider/theme/UI 为受管资产；command 进 slash；provider OAuth、theme 应用、UI slot 执行继续等对应 surface 的授权边界做清楚。
