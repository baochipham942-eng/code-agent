# Code Agent Skill / MCP / Tool / Channel 能力中心研究：对标 Memoh Supermarket

日期：2026-05-14
范围：只研究和写文档，不改产品代码，不执行远程安装，不绕过现有权限模型，不启用未经审计的外部模板。

## 判断

Code Agent 需要一个能力中心，但第一版应定位为本地可审计的 Capability Center，远程市场放到后面。

原因很直接：当前能力已经分散在工具 registry、ToolSearch、Agent Skills、light memory skill、MCP 配置文件、native connectors、Channels Settings、旧 marketplace / extension facade 里。用户看到的是一堆文件、命令、隐藏配置和若干设置页，产品语义没有汇总成“这项能力能做什么、来自哪里、要什么权限、缺什么配置、是否启用、怎么回滚”。

Memoh Supermarket 给了可借鉴的产品骨架：搜索、标签、卡片、按 bot 安装、Skill/MCP 两类目录、MCP 安装前先进入配置草稿。但 Code Agent 的风险面更大：本地文件、shell、desktop/computer、MCP stdio、channels/webhook、native app connector 都可能触及用户机器和账号。P0 应先做本地 curated registry 和已发现能力的审计视图，让能力从“能不能被模型摸到”变成“用户能不能理解并控制”。

## 研究证据

- Memoh App 本地目录：`/tmp/memoh-study`，当前 remote 为 `https://github.com/memohai/Memoh.git`。
- Memoh Supermarket registry：已克隆到 `/tmp/memoh-supermarket`，remote 为 `https://github.com/memohai/supermarket.git`，仓库结构含 `mcps/`、`skills/`、Nitro API 和 Vue 前端。
- Code Agent 必读文件已覆盖：tool search、tool definitions、light memory skill、MemoryWrite、Channels Settings、channel contract、tool-system 文档、identity customization 文档、`package.json`。
- 额外补读：Agent Skills discovery/parser/loader/executor、Skill repository UI 和服务、MCP config/default servers、ToolSearchService、connector/channel runtime、marketplace/extension facade、workbench capability registry。

## Code Agent 当前能力安装、发现、启用链路

| 能力 | 来源 | 发现方式 | 启用方式 | 执行与权限 | 主要缺口 |
|---|---|---|---|---|---|
| Built-in tools | `src/main/tools/modules/*` 注册到 protocol registry；核心名单在 `src/main/services/toolSearch/deferredTools.ts` | 核心工具每轮进模型；延迟工具靠 `ToolSearch` 命中后进入 loaded definitions；`toolDefinitions.ts` 还会合并 MCP tool definitions | 核心工具无启停；延迟工具按会话由 ToolSearch 加载 | `ToolExecutor` 是顶层审批入口；schema 的 permissionLevel 进入统一权限模型 | 有工具名、描述、权限等级，但没有产品卡片、来源版本、风险说明、依赖说明和用户级禁用入口 |
| Agent Skills | builtin/cloud；`~/.code-agent/skills`；项目 `.code-agent/skills`；library 目录；可选 Claude legacy；旧 marketplace 安装也复制到 skills 目录 | `SkillDiscoveryService` 扫描 `SKILL.md`，解析 frontmatter，注册为 ToolSearch 虚拟项 `skill:<name>` | 会话级 mount 在 `SessionSkillService`；Settings 里还有 library skill enable/disable，但 discovery 仍会看到已下载 skill | `Skill` tool 执行；user/project/library skill 的 `allowed-tools` 不会自动变 runtime preapproval，builtin/plugin 才能走自动扩权 | “安装、全局启用、会话挂载、可被 ToolSearch 找到”四层语义混在一起，用户很难判断本轮是否会用、能用哪些工具、依赖是否满足 |
| Light Memory skill | `~/.code-agent/memory/skill_*.md`，由 `MemoryWrite(type=skill)` 写入 | `src/main/lightMemory/skillLoader.ts` 用 token overlap 选 top N 注入 prompt | 没有显式启停，按查询相关性进入 dynamic section | `MemoryWrite` 有权限检查、敏感文本 guard、文件名 basename 防穿越 | 名字叫 skill，但它属于 procedural memory，和 Agent Skills 标准分层不同；能力中心里应单独归为 workflow recipe / memory procedure |
| MCP servers / MCP tools | builtin/cloud default；`~/.code-agent/mcp.json`；项目 `.code-agent/mcp.json`；项目 local `.code-agent/mcp.local.json`；runtime add；in-process memoryKV/codeIndex | 启动时 `initMCPClient` 按 builtin/cloud < user < project < local < runtime 加载；MCP tools 注册进 ToolSearch | `enabled` 控制连接；MCP Settings 可启用、禁用、添加、重连；当前项目 `.code-agent/mcp.json` 有 `codex` 和 `filesystem` | 动态工具名 `mcp__<server>__<tool>` 由 ToolResolver 解析到 MCPClient；MCP annotations 映射到统一 permission model | 已有连接状态页，但缺模板目录、配置项解释、secret/env 检查、命令来源审计、风险分层和回滚 |
| Native connectors | Calendar / Mail / Reminders | `ConnectorRegistry` 只知道 `NATIVE_CONNECTOR_IDS`；Settings / workbench capability registry 读取状态 | settings 写入 `connectors.enabledNative` 后 registry configure；可 retry/probe/disconnect/remove/repair permission | connector 自己实现 status/readiness/actions/capabilities；操作走 connector IPC 和相关工具模块 | 它是本地 app/系统权限能力，应作为能力卡片展示授权状态和修复动作，但不适合 P0 做外部安装 |
| Channels | 内置 HTTP API、Feishu、Telegram；contract 预留 Slack/Discord/WeChat 类型 | `ChannelManager` 构造时注册 builtin plugins；`ChannelsSettings` 从 IPC 取可用 channel types | 添加 account，保存到 secure storage；connect/disconnect；启动时 connectAllEnabled | channel config 含 token/secret/webhook/隐私策略；运行时收发消息并进入 inbox/outbox | 有 plugin interface，但没有 adapter template registry；channel 涉及 webhook、secret、外部平台权限，应先做内置模板和审计，不应直接安装第三方 adapter |
| JS plugins / extension facade | `~/Library/Application Support/code-agent/plugins`；`ExtensionOpsService` 合并 JS plugins、marketplace skills、MCP active entries | plugin loader 扫描 `plugin.json`/`package.json`，dynamic import entry；extension facade list 合并多类 | plugin registry 激活/停用；extension facade 能 install marketplace skill、enable/disable | manifest 有 permissions/capabilities，validator 做结构校验；当前 registry 激活时没有把 manifest permissions 当硬闸 | 这条可作为 P2 tool bundle / executable plugin 的基础，但在安全模型完善前不应作为能力中心首批安装入口 |
| 旧 Skill marketplace / SkillsMP | `src/main/skills/marketplace/*` 和 `SkillsSettings`；支持 GitHub/url/dir source，SkillsMP 搜索 | marketplace manifest `.code-agent-plugin/marketplace.json`；SkillsMP 通过 API 搜索 | installPlugin 默认 `isEnabled: true`；SkillRepositoryService 启动会后台 preload 推荐仓库 | 复制 skills/commands 到 user/project config；enable/disable 只改 installed record 并 reload discovery | 这条已经具备远程下载能力，但与本次边界相冲突。P0 应把它降为“已有能力来源”，不把它包装成可信 marketplace |

### 当前本地库存快照

- 项目 `.code-agent/skills` 里有 `code-review`、`cover-image`、`infographic`、`knowledge-comic`、`qiaomu-mondo-poster`、`research`、`slidev`、`two-step-translate`、`video-storyboard`、`xhs-card`、`youtube-to-ebook`。
- `.agents/skills` 里有 `docx`、`excel`、`frontend-slides`、`ppt`、`pr`，这是当前 agent 环境可见的技能目录，但 Code Agent 产品的 `SkillDiscoveryService` 默认扫描 `.code-agent/skills`，不扫描 `.agents/skills`。
- 项目 `.code-agent/mcp.json` 当前包含 `codex` stdio server 和 `filesystem` server，二者 enabled；`codex` 标记 `lazyLoad: true`。

## Memoh Supermarket 产品模型

Memoh 的 Supermarket 是“远程 curated registry + bot 级安装入口”。

前端页面 `apps/web/src/pages/supermarket/index.vue` 的交互很克制：

- 顶部标题和 GitHub submit 按钮，指向 `https://github.com/memohai/supermarket`。
- 一个搜索框，一个当前 tag filter。
- 两个 tab：Skills 和 MCP。
- Skills/MCP 都走同样的 list API，query 是 `q`、`tag`、`limit`。
- 卡片列表里点击 tag 会反向筛选，点击 install 进入对应安装 dialog。

Skill card 展示：

- icon，名称，homepage 外链，作者。
- 两行描述。
- 最多三个 tags。
- install 按钮。

MCP card 展示：

- icon 或默认 plug。
- 名称，homepage 外链。
- transport badge。
- 作者。
- 两行描述。
- 最多三个 tags。
- install 按钮。

安装模型：

- Skill 安装先选 bot，再调用 `/bots/:bot_id/supermarket/install-skill`，服务端从 registry 下载 tar.gz，写入 bot container 的 `/data/skills/<skillID>`。
- MCP 安装在前端先停在配置草稿。dialog 选择 bot 后把 supermarket MCP 存成 pending draft，再跳到 bot detail 的 MCP tab 让用户补配置。
- Bot 本地 skills 管理还有 adopt / disable / enable。`internal/skills` 用 `/data/skills` 作为 managed dir，用 `/data/.memoh/skills/index.json` 记录 index、hash、disabled override、shadowing。

这个模型有两个值得借的点：

- MCP 更像模板，先进入配置草稿，再由用户确认连接。
- Skills 有 managed dir、index、shadowed/disabled 状态，解决了同名 skill、外部兼容 roots 和本地采纳的问题。

## memohai/supermarket 数据模型

Registry repo 的结构是静态目录：

```text
supermarket/
  mcps/<mcp-id>/mcp.yaml
  skills/<skill-id>/SKILL.md
  server/api/*
  server/utils/*
  src/*
```

MCP 数据模型：

- `id` 来自目录名。
- `name`、`description`、`author`、`icon`、`homepage`、`tags`。
- transport 分三类：`sse`、`http`、`stdio`。
- `sse/http` 有 `url` 和可选 `headers`。
- `stdio` 有 `command` 和 `args`。
- 所有 transport 可声明 `env`，每项是 `key`、`description`、`defaultValue`。

Skill 数据模型：

- `id` 来自目录名。
- `SKILL.md` frontmatter 提供 `name`、`description`、`metadata.author`、`metadata.tags`、`metadata.homepage`。
- 目录内文件被聚合成 `files`。
- API detail 返回 content 和 files；download 返回 skill 目录 tar.gz。

API：

- `/api/mcps`、`/api/mcps/:id`、`/api/mcps/:id/download?format=yaml|json`
- `/api/skills`、`/api/skills/:id`、`/api/skills/:id/download`
- `/api/tags`

搜索逻辑很轻：name、description、tags、transport/tag 过滤，分页返回。

## 什么适合进 Code Agent marketplace

这里的 marketplace 更准确叫 Capability Registry。P0 可以叫“能力中心”，等远程供给成熟后再叫 marketplace。

| 类型 | 是否适合 | 阶段 | 原因 |
|---|---|---|---|
| Skill | 适合 | P0 | Agent Skills 已经有标准 frontmatter、依赖字段、source、ToolSearch 接线和 Skill tool 执行模型。P0 做本地 curated + 已安装视图最划算。 |
| MCP template | 适合 | P0/P1 | MCP 本质上很适合模板化：transport、command/url、env、headers、requiredEnvVars、风险说明。安装动作应是生成 disabled draft 或 config preview，由用户启用。 |
| Tool bundle | 部分适合 | P1/P2 | 现有 native ToolModule 可被组织成浏览卡片和 bundle，比如 Office、Browser/Computer、Media、Connectors。动态安装可执行 tool bundle 要等 plugin sandbox、manifest permission enforcement、rollback 到位。 |
| Channel adapter | 适合但要谨慎 | P1/P2 | Channel 已有 plugin interface 和 config union，但涉及 bot token、webhook、外部平台权限、隐私策略。P1 可做内置 adapter templates，第三方 adapter 安装放 P2。 |
| Workflow recipe | 适合 | P0/P1 | light memory skill、combo skill、prompt recipe、skill+tool+MCP 组合都可以归到 recipe。它应生成计划/配置草稿，不直接增加执行权限。 |
| Identity/profile template | 暂缓 | P2 | `SOUL.md` / `PROFILE.md` 是人格和项目约束层，价值很大，但和工具能力权限不同。放进同一个 marketplace 会让用户误以为这是普通可启停能力，P0 先保持独立。 |

## 卡片信息结构

能力卡片要回答用户真正关心的八个问题：做什么、怎么用、从哪来、要什么、缺什么、会碰什么数据、现在能不能用、出了事怎么退。

建议统一 schema：

| 字段组 | 字段 |
|---|---|
| 身份 | `id`、`type`、`name`、`summary`、`description`、`tags`、`icon` |
| 来源 | `sourceKind`：builtin / local / project / team / remote；`sourcePath` / `sourceUrl`；`author`；`version`；`commit`；`contentHash`；`lastReviewedAt` |
| 用途 | `useCases`、`examplePrompts`、`canonicalInvocation`、`relatedCapabilities` |
| 状态 | `installState`：available / installed / missing / draft；`enableState`：enabled / disabled；`runtimeState`：connected / lazy / error / blocked；`mountState`：mounted / unmounted / not_applicable |
| 权限 | `toolPermissions`、`mcpAnnotations`、`filesystemScope`、`networkScope`、`secretScope`、`desktopScope`、`approvalBehavior` |
| 配置 | `requiredEnvVars`、`secrets`、`headers`、`ports`、`paths`、`oauth`、`webhook`、`privacyMode`、`validationChecks` |
| 依赖 | `bins`、`npmPackages`、`nativeApps`、`mcpServers`、`connectorIds`、`channelTypes`、`referenceFiles` |
| 风险 | `riskTier`：low / medium / high；`riskReasons`；`dataTouched`；`executionSurface` |
| 审计 | `installedFiles`、`configFilesChanged`、`auditLogRefs`、`lastSmokeStatus`、`rollbackSnapshot`、`changelog` |

不同类型可以复用同一个 card 骨架，细节面板按类型展开：

- Skill：展示 `allowed-tools`、execution context、model override、deps、references、source priority、是否可自动扩权。
- MCP template：展示 transport、command/url、args、env/headers、工具数量、annotation 风险、是否 lazy。
- Tool bundle：展示包含哪些 native tools、权限等级、是否 core/deferred、能否禁用。
- Channel adapter：展示 secrets、webhook、隐私策略、入站数据处理、账号状态。
- Workflow recipe：展示会挂载哪些 skills、建议启用哪些 MCP/connector、会生成什么配置草稿。

## 安装安全模型

P0 安全原则：安装是文件落地，启用是能力进入运行时，连接是外部服务可达，调用是触发真实动作。这四件事要分开。

1. 本地 registry 优先
   先做 app bundled registry + project registry，例如 `resources/capabilities/registry.json` 和 `.code-agent/capabilities/*.yaml`。远程来源只允许导入为 disabled draft。

2. 来源分级
   `builtin` 最高，`project` 可随仓库审计，`team` 来自团队 registry，`remote` 默认未审计。卡片必须展示 source、commit/hash、review 时间。

3. Dry-run install plan
   安装前先展示将写入哪些文件、会新增哪些 config、要哪些 env/secret、会不会开端口、会不会启动 stdio/server。用户确认后才落地。

4. 启用前权限确认
   Skill 的 `allowed-tools` 延续现有规则：user/project/library skill 不因声明 `allowed-tools` 获得自动 runtime preapproval。MCP template 也只写 config，不直接调用工具。

5. 配置草稿优先
   MCP 和 Channel 都先进入 draft：补全 env/secrets/ports/webhook/privacyMode 后才能 enable/connect。

6. 回滚与禁停
   每次 install/update 记录 manifest、文件列表、content hash、旧文件 snapshot。先 disable，再 uninstall。失败时能回到上一版。

7. 审计日志
   记录 install/update/enable/disable/connect/call 的 actor、time、source、diff summary、permission prompt、result。这个日志给设置页、review queue、debug 都能用。

8. 依赖检查
   Skill 已有 bins/env-vars/references；MCP template 要补 command availability、env missing、port conflict、secret placeholder；Channel 要补 webhook reachability 和 token presence。

9. 可执行插件暂不上主路径
   当前 JS plugin 可以注册 tools/hooks，但 manifest permission 还更偏声明和校验。P0 能展示和审计 local plugin，暂不提供第三方 executable plugin 安装按钮。

## 三套方向

### 方向一：本地 curated registry

产品形态：

- Settings 或 Workbench 里新增 Capability Center。
- 读取 app bundled registry、项目 `.code-agent`、当前 runtime inventory。
- 默认只展示已内置、已安装、项目内声明的能力。
- 安装动作只支持本地 curated 条目，远程条目只能作为 draft import。

优点：

- 和当前权限模型贴得最紧。
- 可以最快把 tools / skills / MCP / connectors / channels 的状态打通。
- 不需要先解决 public review、签名服务、远程分发治理。

代价：

- 供给规模小，更多像“能力资产目录”。
- 团队共享需要额外 registry 同步。

适用阶段：P0。

### 方向二：团队共享 registry

产品形态：

- 支持一个受控 Git repo 或内部 URL，里面放 capability manifests。
- 团队可以共享 MCP templates、project skills、workflow recipes、channel setup docs。
- 导入后默认 disabled，需要本地审计和用户启用。

优点：

- 比 public marketplace 更符合工作场景。
- 能把团队里的最佳实践沉淀为可安装/可配置资产。
- 可以复用 Git commit、code review、签名/哈希做来源审计。

代价：

- 要处理 registry version、团队信任根、冲突、撤回、回滚。
- UI 要明确团队模板与本机运行权限的边界。

适用阶段：P1。

### 方向三：远程 marketplace

产品形态：

- 类似 Memoh Supermarket，有 public API、搜索、标签、详情、下载。
- 支持提交、审核、签名、评分/使用量、版本历史。
- App 内只把远程模板作为可导入草稿。

优点：

- 供给规模最大。
- 适合生态化 skills、MCP templates、workflow recipes。

代价：

- 安全治理成本最高。
- 一旦支持可执行 tool bundle/channel adapter，需要沙箱、权限强制、签名、撤回、恶意模板响应机制。

适用阶段：P2。

## 推荐路线

### P0：Capability Center Lite，本地审计视图 + curated 模板

目标：让用户能浏览、理解、启停、配置当前能力。

建议做：

- 建一个统一 capability inventory service，只读汇总当前 runtime：
  - tools：core/deferred、permissionLevel、source、canonical invocation。
  - skills：builtin/cloud/user/project/library、deps、allowed-tools、mount/install/source 状态。
  - MCP：server state、transport、enabled、toolCount/resourceCount、config scope、lazy/error。
  - connectors：calendar/mail/reminders 的 enabled/readiness/actions。
  - channels：HTTP/Feishu/Telegram 的 account/config/privacy/status。
  - existing marketplace/plugin：只作为来源和审计项，不做远程安装主入口。
- 增加本地 curated registry schema，先收 app 内置模板和项目模板。
- MCP template 安装只生成 disabled draft，进入 MCP Settings editor。
- Channel template 只复用内置类型，生成 account draft，不自动 connect。
- Skill card 展示 `allowed-tools` 和“是否会自动扩权”。user/project/library 明确不会自动扩权。
- 给每张卡片补风险 tier、缺失依赖、配置缺口、来源。
- 复用 `WorkbenchCapabilitySheetLite` 的状态表达，但把它从“本轮能力解释”扩展为“全局能力目录”。

P0 不建议做：

- 不开放远程 marketplace 一键安装。
- 不让 remote skill 默认 enabled。
- 不把 JS executable plugin 放进安装主路径。
- 不把 identity/profile 模板混进工具能力中心。

### P1：项目/团队 registry + 安装计划 + 回滚

目标：让可信团队模板能被导入、配置、启用、回滚。

建议做：

- 支持 `.code-agent/capabilities/*.yaml` 或 `.code-agent/capabilities/registry.json`。
- 支持 team registry，来源可以是本地目录或内部 Git checkout。
- 引入 install plan：写入文件、配置修改、权限提示、缺失依赖、回滚 snapshot。
- Skill install 进入 user/project scope 前先预览 `SKILL.md`、deps、allowed-tools、references。
- MCP template 支持 secret placeholder 校验和 command/path 检查。
- Workflow recipe 可以“一次性建议”挂载 skill、启用 MCP draft、打开 connector 检查，但每项仍需单独确认。
- 审计日志接入 review queue / capability health。

### P2：远程 marketplace 和可执行扩展生态

目标：支持更大规模供给，但默认按未审计远程来源处理。

建议做：

- Remote registry API 可参考 memohai/supermarket：静态 repo + API + tags + download。
- 增加签名、review 状态、hash pinning、撤回列表。
- 远程条目默认导入为 disabled draft。
- 可执行 tool bundle / channel adapter 必须先有插件权限硬闸、沙箱或隔离 worker、manifest permission enforcement、最小权限 API。
- Remote marketplace 排在团队 registry 之后，不作为主路径。

## 可复用的 Memoh 设计

可以直接借：

- 搜索 + tag + type tab。
- Skill/MCP 分开建模，避免卡片塞太满。
- MCP 安装进入配置草稿。
- managed dir + index + disabled/shadowed 状态。
- Skill download 保留目录文件，支持 assets/references/scripts。

需要改造后再借：

- Memoh 是 bot/container 场景，Code Agent 是本机长驻桌面/CLI/workbench 场景，风险更接近本地执行环境。
- Memoh Skill card 信息偏轻，Code Agent 卡片必须补 permissions、deps、risk、source、audit。
- Memoh MCP template 的 env/headers 字段可借，但 Code Agent 要加 command provenance、stdio 风险、secret handling、scope 层级。

## 主要产品口径

能力中心的核心是让现有能力可被用户理解和控制，模板数量只是副产品。

第一版的成功标准：

- 用户能看到：我现在有哪些 skills、MCP、connectors、channels、tool bundles。
- 用户能分清：已安装、已启用、已连接、已挂载、本轮被选中、当前被阻塞。
- 用户能知道：这项能力会碰文件、网络、shell、桌面、secret、外部账号中的哪一类。
- 用户能操作：配置、启用、禁用、重连、挂载、卸载、回滚。
- 用户能审计：来源、版本、安装文件、配置变更、上次运行错误。

P0 推荐名称：Capability Center 或 能力中心。
P1 以后可以把 curated/team registry 叫 Marketplace。
远程公共 marketplace 放 P2，不参与当前产品主线。
