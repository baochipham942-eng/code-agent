# Alma Composer Entry 对标研究

## 结论

Alma 0.0.805 到 0.0.823 里，和会话页交付质量最相关的一次输入层迭代是 0.0.821：slash command menu 被并入 chat composer，并补齐 New Chat 页 composer 缺口。它的产品含义很直接：设置页负责安装、配置和默认值，composer 负责在当前这一轮把能力变成可发现、可搜索、可选择、可进入上下文的动作入口。

对 `code-agent` 来说，短板不在能力数量。当前已经有 `/schedule`、`/loop`、`/goal`、`/agent`、prompt command、skill 推荐、会话级 mounted skills、turn 级 `selectedSkillIds` 和 workbench context。真正的问题是入口分裂：slash 弹层、`+` 菜单、语义推荐条、agent 补全、设置页和 workbench bar 各管一段，用户在 composer 里无法一次性看见“本轮可以调用什么”。下一步应该围绕 composer 做入口收拢，避免继续堆设置页。

建议 P0 先做一个最小的 composer-native capability picker：输入框任意位置的尾部 `/query` 触发，同一列表搜索内置命令、prompt command、agent command、已安装或已挂载 skill；选择 skill 后写入本轮 `selectedSkillIds`，并给用户一个可见 token 或 chip。P1 再做排名、参数提示、plugin/connector/MCP 扩展和更完整的新会话验收。

## 本轮范围

只研究和拆方案，不做产品功能开发。本文新增在 `docs/research/alma-composer-entry.md`。

资料来源：

- Alma release notes：`/tmp/alma-update-20260613/release-notes-805-823.md`
- Alma 旧 renderer：`/tmp/alma-update-20260613/old/extract/renderer-assets/index-DZO6LH4W.js`
- Alma 新 renderer：`/tmp/alma-update-20260613/new/extract/renderer-assets/index-lrtJ1hZ1.js`
- Alma 旧 main：`/tmp/alma-update-20260613/old/extract/index.js`
- Alma 新 main：`/tmp/alma-update-20260613/new/extract/index.js`
- `code-agent` 当前 composer、command、prompt、skill 相关实现

## Alma 输入层迭代证据

### 1. Release note 直接指向 composer，而非设置页

0.0.821 的 release notes 写了两点：

- `Integrated the slash command menu directly into the chat composer`，位置：`release-notes-805-823.md:16-20`
- 修复 New Chat 页 composer 没有 slash menu，位置：`release-notes-805-823.md:21-23`

这说明 Alma 这轮关注的是输入入口一致性。它没有把能力继续藏到设置页里，而是把用户写消息时的能力发现路径放进 composer。

### 2. 旧版 ChatComposer 没有 slashPicker，已有会话自己塞 PromptsPicker

旧 renderer 里 `ChatComposer` 的 props 从 `input` 到 `formClassName`，没有 `slashPicker`，textarea 的 `onChange` 也只是直传 `onInputChange`：`old renderer:4427-4510`。

旧版虽然已经有 `PromptsPicker`，并且已有会话页面把它作为 `ChatComposer` 的 `children` 传进去：`old renderer:25490-25502`。这个结构的问题是 picker 由页面层自己管理，composer 不是统一入口。New Chat 页如果没有同样接线，就会出现 release note 里修掉的缺口。

### 3. 新版把 picker 收进 ChatComposer

新 renderer 里 `ChatComposer` 增加了 `slashPicker` prop：`new renderer:4629-4672`。组件内部新增：

- `slashPickerOpen` 和 `slashSearchValue` 状态：`new renderer:4681-4682`
- `handleInputChange` 用 `/(?:^|\s)\/(\S*)$/` 监听尾部 slash token：`new renderer:4686-4700`
- `handleSlashSelect` 统一处理 prompt、plugin command、built-in command、ACP command、skill：`new renderer:4702-4734`
- `PromptsPicker` 直接渲染在 `ChatComposer` 内部：`new renderer:4837-4848`

这个变化比“加一个弹窗”更关键：composer 成了输入层能力入口的边界，页面只需要提供 `slashPicker` 能力和选择回调。

### 4. slash 搜索范围覆盖 prompt、命令和 skill

新版 `PromptsPicker` 的候选合并顺序是：

- built-in commands
- prompts
- ACP commands
- plugin commands
- skills

对应代码：`new renderer:4437-4448`。搜索字段也不只看命令 id，prompt 会搜 name/content，plugin command 会搜 id/title/description，skill 会搜 name/description 以及 `skills:name`。

这让用户不用知道能力放在哪个设置页，只要在 composer 里输入 `/` 和关键词，就能看到本轮可用动作。

### 5. skill 选择进入本轮输入和 selected skills

新版 New Chat 的 `slashPicker.onSkillSelect` 会把 skill id 写进 `selectedSkillIds`：`new renderer:5215-5229`。

新版已有会话页的 `onSkillSelect` 更完整：它会根据当前 thread skillIds 切换选中状态，并把 `<skill.name>` 这样的可见 token 插回输入框；最后更新光标位置：`new renderer:24345-24406`。

这个设计让“选择某个 skill”同时变成两件事：

- 状态层：本轮或当前 thread 的 skill 选择发生变化
- 可见层：用户在 composer 里能看到自己选了哪个 skill

这正是设置页能力提高会话页表现的连接点。

## code-agent 当前实现盘点

### 1. 会话页只有一个 ChatInput，具备统一入口基础

`ChatView` 只渲染一个 `ChatInput`：`src/renderer/components/ChatView.tsx:577-588`。`ChatInput` 自己通过 `useChatInputSessionScope` 获取 `currentSessionId` 和 engine kind，并在 session 切换时清空草稿与附件。

这比 Alma 旧版更容易做 New Chat 一致性，因为当前主要 composer 是同一个组件。但仍要验收“新建会话后的空状态”和“切换会话后 slash 能力仍可用”，不能只测已有消息会话。

### 2. SlashCommandPopover 已存在，但入口和搜索范围偏窄

`ChatInput` 维护 `showSlashPopover` 和 `slashFilter`：`src/renderer/components/features/chat/ChatInput/index.tsx:148-150`。

触发逻辑只在输入值 `startsWith('/')` 时打开：`src/renderer/components/features/chat/ChatInput/index.tsx:399-414`。这意味着 `请帮我 /goal`、`先看这个 /` 这类尾部 slash token 不会触发。Alma 新版用的是尾部 token 正则，支持在已有输入后继续唤起能力。

`+` 菜单也能打开 slash 面板：`src/renderer/components/features/chat/ChatInput/index.tsx:1165-1170`。这提升了发现性，但也造成两个心智：用户可以点 `+` 找命令，也可以在开头输入 `/` 找命令。

`SlashCommandPopover` 会拉取 prompt commands：`src/renderer/components/features/chat/ChatInput/SlashCommandPopover.tsx:83-100`，并合并 GUI-only commands、shared command registry、prompt commands：`src/renderer/components/features/chat/ChatInput/SlashCommandPopover.tsx:580-648`。过滤只看 `id` 和 `label`：`src/renderer/components/features/chat/ChatInput/SlashCommandPopover.tsx:651-656`，没有看 description、prompt 内容、skill 描述或 agent 描述。

### 3. Slash 选择动作已经很丰富，但散在 submit path

当前 `handleSubmit` 已经拦截：

- `/schedule`：自然语言生成定时任务，空描述时打开对话式创建卡片
- `/loop`：启动会话内循环
- `/goal`：启动目标模式并写入 goal options
- `/agent`：切换本轮 preferred agent 或恢复自动 agent

对应代码：`src/renderer/components/features/chat/ChatInput/index.tsx:568-690`。

这说明 command 执行能力已经有了。差距在“输入前发现”和“选择后可见”。很多命令只有知道命令名的人能用，新用户或低频用户需要靠记忆。

### 4. skill 现在有推荐和挂载，但没有统一进入 slash 搜索

`useSkillRecommendations` 会在普通输入超过 4 个字符时按当前 session 拉推荐，且跳过 `/` 和 `@` 开头：`src/renderer/components/features/chat/ChatInput/useSkillRecommendations.ts:41-80`。

推荐结果显示在 composer 上方的 `CapabilitySuggestionStrip`，可挂载或安装 skill：`src/renderer/components/features/chat/ChatInput/index.tsx:968-976`。

这条链路适合“用户不知道该用哪个 skill，但自然语言命中了关键词”的场景；不适合“用户主动想找某个 skill”的场景。主动查找应该进入 slash picker。

### 5. turn 级 selectedSkillIds 已经能进入上下文

`composerStore.buildContext()` 会把 `selectedSkillIds` 写进 `ConversationEnvelopeContext`：`src/renderer/stores/composerStore.ts:203-205`。

主进程 `buildWorkbenchTurnSystemContext()` 会把它渲染成“优先考虑这些已挂载 skills”的 turn context：`src/main/app/workbenchTurnContext.ts:55-56`。

这条链路已经能支撑 Alma 式“从 composer 选择 skill，提高本轮交付质量”。目前缺的是：slash picker 选择 skill 后如何写入 `selectedSkillIds`，以及用户在输入框里如何看见这次选择。

## 差异判断

| 维度 | Alma 0.0.821 后 | code-agent 当前 | 差距 |
|---|---|---|---|
| 入口统一性 | `ChatComposer` 内部处理 slash 输入、搜索和选择 | `ChatInput` 有 slash 弹层，但只在开头 `/` 触发；`+` 菜单、推荐条、agent 补全各走一套 | 需要把 composer 作为本轮能力入口，统一候选模型和触发方式 |
| New Chat 一致性 | release note 明确修复 New Chat composer 缺 slash menu | 当前只有一个 `ChatInput`，具备一致性基础 | 仍需 e2e 覆盖新建会话、空会话、切换会话后的 slash 行为 |
| slash 搜索范围 | prompt、built-in、ACP、plugin command、skill | GUI-only command、shared registry、prompt command；skill 和 agent 不在同一搜索面 | P0 应把 skill 和 agent 纳入同一 picker；P1 再扩 plugin/connector/MCP |
| 搜索字段 | id/name/title/description/content 等 | 主要 id/label | 需要搜 description、prompt 内容、skill 描述、agent 描述，并做精确匹配优先 |
| 会话级能力选择 | skill 选择会写 selected skills，并可插入 `<skill>` token | skill 推荐只挂载；turn 级 `selectedSkillIds` 有链路但缺 composer slash 入口 | 选择 skill 后要同时更新状态和可见输入 |
| 快捷提示可发现性 | slash 列表展示 `/prompts:name`、`/skills:name` 等 namespace | `+` 菜单展示“/ 命令面板”，slash 列表展示命令和 prompt | 需要把 namespace、类别和选择后效果讲清楚，减少“点了以后发生什么”的不确定 |
| 交付质量连接 | composer 选择直接影响本轮 prompt、command、skill | 设置页和面板能配置能力，但本轮选择弱可见 | 让每次选择可见、可撤销、可进入 metadata/context，是质量提升的关键 |

## P0 开发切片

### P0.1 尾部 slash token 触发，保留现有输入

目标：让 `帮我 /`、`先用 /doc` 这类输入能打开 picker，不局限于开头 `/`。

实现建议：

- 在 `ChatInput` 中把 `newValue.startsWith('/')` 改为尾部 token 检测，参考 Alma 的 `/(?:^|\s)\/(\S*)$/`
- 计算 `baseInput` 和 `query`，picker 关闭时保留原输入，不要默认 `setValue('')`
- `onSelect` 时只替换尾部 slash token，不吞掉前面的自然语言
- 保持 `/agent ` 的专属补全不被破坏

验收：

- 输入 `请帮我 /` 后弹出 picker，Esc 后输入仍是 `请帮我 /`
- 输入 `请帮我 /go`，能搜到 `/goal`，选择后变成 `请帮我 /goal `
- 输入 `/agent ` 仍打开 agent 补全，不被通用 picker 抢走
- 回归 `tests/renderer/components/chatInput.agentCommand.test.ts` 和 slash 相关组件测试

风险：

- URL、路径或 Markdown 里的 `/` 可能误触发。只匹配“空白后 slash 且位于输入末尾”的 token，可以控制误触发。
- 当前 `SlashCommandPopover.onClose` 会清空输入，需要先改掉这个行为，否则会造成草稿丢失。

### P0.2 统一 composer action candidate 模型

目标：把当前散落的命令、prompt、agent、skill 先合成一个候选结构，UI 可以继续复用 `SlashCommandPopover`。

候选类型建议：

- `command`: GUI-only command 和 shared command registry
- `prompt`: file/MCP prompt command
- `agent`: default 和已注册 agent
- `skill`: 已挂载 skill、已安装未挂载 skill

字段建议：`id`、`kind`、`label`、`description`、`namespace`、`source`、`searchText`、`actionKind`。

验收：

- 输入 `/go` 能找到 goal
- 输入 `/review` 能找到名称或描述含 review 的 skill/prompt/agent
- prompt 搜索能命中 description，后续再扩 content
- 列表里有明确类别标签，例如 Command、Prompt、Agent、Skill

风险：

- 命令名冲突。保持 namespace 展示，例如 `/goal`、`/prompts:name`、`/skills:name`，但搜索时允许用户只输入 `name`。
- 异步候选源会抖动。P0 可以先用已在前端 store 中可读的数据，prompt command 继续按打开时拉取。

### P0.3 skill 选择写入本轮 selectedSkillIds，并可见

目标：用户从 slash 选 skill 后，本轮发送一定能带上 skill 偏好，并且用户能在 composer 里看到。

实现建议：

- 已挂载或已安装 skill：选择后调用 `useComposerStore.setSelectedSkillIds([...])`
- 已安装未挂载 skill：P0 可先提示“先挂载”，或复用现有 `SESSION_MOUNT` 后再 set selected
- 输入框可见层先用文本 token，比如 `<skill-name>`；后续 P1 再升级成 chip
- 发送后通过 `buildContext().selectedSkillIds` 进入 `ConversationEnvelopeContext`

验收：

- 选择 skill 后输入框出现 `<skill-name>` 或同等可见标记
- `useComposerStore.getState().buildContext()?.selectedSkillIds` 包含该 skill
- 发送后主进程 `buildWorkbenchTurnSystemContext()` 能产出 selected skill 提示
- message metadata 或 turn timeline 中能看到 selectedSkillIds

风险：

- skill name 和 skill id 不一定一致。状态层应使用稳定 id 或当前后端约定的 skillName，展示层可以用 name。
- mounted skill 和 selected skill 的关系要清楚。mounted 表示可用，selected 表示本轮优先考虑，不能混成一个概念。

### P0.4 New Chat 和会话切换一致性验收

目标：把 Alma 0.0.821 修复过的坑在 `code-agent` 里变成验收项。

验收：

- 新建会话后，空 composer 输入 `/` 能打开 picker
- 已有消息会话输入 `/` 能打开 picker
- 切换会话后输入 `/` 仍可用，旧会话草稿不会污染新会话
- 没有 currentSessionId 时，command/prompt 可显示；需要 session 的 skill mount 操作要给出明确不可用状态

风险：

- 当前 skill 推荐依赖 `currentSessionId`，新会话创建前不能直接 mount。picker 应区分“可搜索”和“可执行”，避免用户点了没反应。

## P1 开发切片

### P1.1 搜索排序和分组

目标：让 slash 搜索能稳定把用户真正想要的结果排前面。

建议：

- 精确 id/name 匹配优先
- prefix 匹配优先于 contains
- 当前会话相关能力优先，例如 mounted skill、最近用过的 prompt、当前 engine 可用命令
- 命令、skill、prompt 分组展示，空 query 时只展示高频项，避免列表过长

验收：

- `/low` 不会被 `workflow` 这类 contains 命中抢到前面
- 搜索 skill 描述能命中，但精确命令仍排前
- 空 query 不展示过多低频 diagnostic 命令

### P1.2 Prompt command 参数体验

目标：选择 prompt command 后，不只是预填 `/{name} `，还要让参数 hint 和内容预览有用。

建议：

- 有 hints 时预填 `/{name} ` 并显示参数占位
- 无参数且明确可直接执行的 prompt，可以选择后直接 submit 或给二次确认
- 列表展示 prompt description 和来源 file/MCP
- 支持按 prompt content 搜索，但对超长 content 做本地截断索引

验收：

- 用户能看到 prompt 来源和参数要求
- 有参数 prompt 不会被误直接发送
- prompt command 与 built-in command 同名时，冲突规则可解释

### P1.3 Agent 和工作流入口进入同一 picker

目标：让 `/agent`、持久角色、workflow 这类会话能力选择不再单独散在补全和菜单里。

建议：

- 空 query 展示“选择 Agent”“新建角色”“编排工作流”等高频项
- `/agent query` 保留专属深度补全，但同一候选模型也能提供 agent 类型结果
- 选择 agent 后显示本轮 agent chip，并写入 `preferredAgentId`

验收：

- 搜 agent 名称或描述能命中
- 选择 agent 后，本轮 envelope metadata 带 `preferredAgentId`
- 发送后 UI 能解释这轮交给了哪个 agent

### P1.4 把 capability suggestion strip 和 slash picker 合流

目标：保留语义推荐的主动性，同时让推荐结果能被用户在同一个入口里理解。

建议：

- 用户自然语言输入时仍显示轻量推荐条
- 用户输入 `/` 时，推荐条不另开一套 UI，而是作为 picker 的 Suggested 分组
- 能力缺失时提供安装、挂载、选择三段状态

验收：

- 普通输入命中 skill 关键词仍给推荐
- `/skill-name` 主动搜索同一 skill 也能找到
- 安装或挂载成功后，用户能立刻把它选入本轮

### P1.5 交付质量可观测

目标：证明 composer 选择真的改善了模型行为，而非只改善 UI。

建议记录：

- 每轮是否有 selectedSkillIds、selected prompt、selected agent
- 选择来源：typed slash、plus menu、semantic recommendation、manual chip
- 模型最终是否调用了对应 skill/tool 或遵循了 prompt

验收：

- turn timeline 能显示本轮选择过的 skill/prompt/agent
- review 时能看到“用户显式选择了什么”和“agent 实际用了什么”
- 至少覆盖一个 skill 显式选择后模型优先使用的 smoke

## 风险

1. 能力概念混淆：mounted skill、selected skill、prompt command、agent、plugin command 都容易被用户理解成“我点了就会用”。UI 必须区分“已启用”“本轮优先”“立即执行”“预填后发送”。
2. Slash 误触发：路径、URL、Markdown 内容会包含 `/`。P0 只做尾部 token 触发，先不要做全文任意位置。
3. Enter 事件冲突：当前 popover 用捕获阶段拦截 Enter，textarea 也会提交。改触发范围后要补键盘测试，避免命令还没选中就发出消息。
4. 异步候选源性能：prompt commands、skill list、agent list、插件命令可能来自不同 store 或 IPC。P0 先用缓存和打开时拉取，P1 再做索引和 debounce。
5. New Chat 无 session：skill mount 需要 sessionId；空会话下可以先展示 skill，但执行时要创建会话或提示不可用，不能静默失败。
6. 与现有 `+` 菜单的关系：`+` 可以保留为 discoverability 入口，但它打开的必须是同一个 picker，不再维护另一套命令理解。

## 建议验收方式

单元测试：

- slash token 解析：开头 `/`、尾部 ` /`、普通路径、URL、Esc 保留草稿
- candidate builder：command/prompt/agent/skill 合并、冲突去重、精确匹配排序
- skill selection：选择后更新 `selectedSkillIds`，再次选择能撤销或保持幂等

组件测试：

- `ChatInput` 输入 `帮我 /go` 后出现 picker，选择 goal 后保留 base input
- 选择 prompt command 后预填 `/{name} `
- 选择 skill 后显示 token/chip，并聚焦 textarea

端到端或 smoke：

- 新建会话空 composer 输入 `/`，picker 可用
- 已有会话输入 `/`，picker 可用
- 切换会话后 picker 可用且草稿隔离
- 发送带 selectedSkillIds 的一轮，message metadata 和 turn context 都能看到这次选择

人工验收：

- 用一个真实 skill 做任务，例如 Excel、docx 或浏览器相关 skill。对比未选择 skill 与显式选择 skill 的回复，重点看模型是否更快进入正确工具链、是否少问无效问题、是否把交付格式说清楚。
