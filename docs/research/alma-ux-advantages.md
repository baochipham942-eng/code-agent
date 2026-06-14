# Alma 用户体验层面对 Neo 的优势分析

日期：2026-06-14

范围：分析 Alma 0.0.805 到 0.0.823 相关证据里体现出来的用户体验优势，并对照 Neo/code-agent 当前会话页、设置页、能力选择、产物展示和通道连续性。本文先记录研究和方案；后续追加的“当前实现覆盖审计”记录本分支按方案推进的 MVP 覆盖与验收证据。

## 证据边界

- 确证：当前安装的 `/Applications/Alma.app` 为 0.0.823，已重新抽取到 `/tmp/alma-ux-research-extract`。核心证据来自 `out/renderer/assets/index-lrtJ1hZ1.js`、`out/main/index.js`、`out/renderer/assets/gallery-DD4Sng8t.js`、`out/renderer/assets/share-D98vJKtF.js`。
- 二级证据：用户给的 `/tmp/alma-update-20260613/release-notes-805-823.md`、旧 renderer、旧 main 在当前 worktree 和 `/tmp` 已缺失。本研究对 release note 增量的引用，来自同批专项留下的 `/Users/linchen/.codex/worktrees/28f3/code-agent/docs/research/alma-model-strategy.md`，只作为二级证据使用。
- 推断：涉及 New Chat 一致性、设置推荐如何落到会话页、长回复修复对用户信任的影响时，标为推断；这些判断来自当前 bundle 命名、二级 release note 摘要和 Neo 现有代码对照，不能当成已完整复现过的 Alma 行为。

## 核心判断

Alma 对 Neo 更值得借鉴的地方，在于它把“配置能力”压进了用户做事的主路径：用户在设置页解决 provider、MCP、plugin、shortcut、channel 这些前置问题后，回到会话页能更自然地看到可用能力、当前选择、执行过程、错误原因和产物归属。

Neo/code-agent 的底层能力并不弱。当前仓库已经有 grouped settings、slash command、能力推荐、InlineWorkbenchBar、workspace preview、RouteTraceChip、FallbackBanner、voice input、channels、hooks、skills/MCP/plugins 等基础。但用户感知上容易分散：设置能配、composer 能带、runtime 能执行、preview 能看、trace 能查，可一轮任务回放时，用户还要在多个 chip、工具行、预览面板、设置页和日志之间自己拼因果。

所以这条线的借鉴重点应放在会话页质量和信任感：把“本轮用了什么、为什么这么跑、出了什么问题、交付物在哪、还能怎么接着做”做成用户能扫读的一层，而不是继续堆设置项。

## 用户路径差异

| 阶段 | Alma 少走的弯路 | Neo 当前摩擦 | 判断 |
| --- | --- | --- | --- |
| 想做事 | slash picker 同时覆盖 built-in commands、ACP commands、plugin commands、skills、prompts；设置侧还有 provider/setup/channel/hotkey 入口 | SlashCommandPopover 主要覆盖命令和 prompt，skills/MCP 更像另一个能力面板；用户要知道该去哪里找 | Neo 有能力，但发现路径分裂 |
| 发起任务 | composer 层直接带 selected skills、MCP servers、artifact mode、tool selector、voice/hotkey 状态 | ChatInput、AbilityMenu、InlineWorkbenchBar、CapabilitySuggestionStrip 分工较多；用户理解成本更高 | 需要把“当前任务配置”聚合成一块 |
| 看到过程 | Alma 有 turnEndReason、providerResponseId、fallbackReason、recordStep、savedTokens、MCP status 等线索，release note 二级证据还提到 clean conversation text 和 terminal clutter 清理 | Neo 有 RouteTraceChip、FallbackBanner、tool display collapse、turn timeline，但表达还偏工程事件和 ID | Neo 需要更可读的解释层 |
| 拿到交付物 | ArtifactPanel、ArtifactMode、inline artifact placeholder、preview/code/copy/download/fullscreen 让产物像一等对象 | Neo 有 WorkspacePreviewPanel 和更复杂的 workspace assets，但聊天流里“哪段回答生成了哪个产物”不够显性 | 产物归属应进入 transcript |
| 继续推进 | channel mapping、voice transcription、image placeholder、New Chat 相关能力让外部渠道更像正常会话的一部分 | Neo 有 Telegram/Feishu/Slack/Discord/Wechat contract 和 settings，但外部渠道是否复用同一套会话解释，需要产品层显性验证 | 连续性要看同一 envelope 和同一解释 UI |

## Alma 做得好的体验类目

### 可发现性

Alma renderer 里 `PromptsPicker` 同时合并 `acpCommands`、`pluginCommands`、`builtInCommands`、`skills` 和 prompts，说明 `/` 已经接近“我要做事时可调用能力”的统一入口。`Composer` 同时持有 `selectedMCPServers`、`selectedSkillIds`、`enableArtifacts`、`slashPicker` 等状态，这让能力发现和任务发起贴在同一个动作里。

Neo 已经有 `SlashCommandPopover.tsx`、`CapabilitySuggestionStrip`、`InlineWorkbenchBar.tsx` 和 `useWorkbenchCapabilities`。问题是这些东西分散在不同心智模型里：slash 像命令系统，InlineWorkbenchBar 像能力开关，SuggestionStrip 像推荐，设置页像配置中心。用户不一定知道先敲 `/`、先点能力、还是先去设置。

### 低噪音

Alma 的二级 release note 证据提到 clean conversation text、移除 terminal footer/interface clutter、长回复截断修复。当前 main bundle 也能看到 `stream-json`、`include-partial-messages`、`strict-mcp-config`、`allowedTools`、`truncated` 等处理路径。这里的体验重点是：过程可以很复杂，但 transcript 不能像调试控制台。

Neo 的 `ToolCallDisplay` 已经把成功工具调用折叠，pending/error 有不同展开策略，也有 semantic tool UI 的设计方向。短板是错误和过程说明还没有形成统一叙事：有时是模型 fallback banner，有时是工具错误，有时是日志式输出，有时是 trace chip。用户要判断“是不是坏了”，还需要自己读很多工程细节。

### 可解释性

Alma 有明确的可解释性埋点：renderer/main 里出现 `turnEndReason`、`turnEndReasonNormalized`、`turnEndReasonSource`、`providerResponseId`、`fallbackReason`、`recordStep`、`savedTokens`、MCP status icon。二级 release note 里还提到 main chat model 改为 main task model、Claude subscription official CLI interactive mode、saved token display。这些都让“为什么选这个模型/为什么结束/省了多少上下文/工具状态怎样”更容易成为产品表达。

Neo 也有 `RouteTraceChip.tsx`、`FallbackBanner.tsx`、`modelDecision`、context usage pill 和 workbench metadata。差距在表达粒度：Neo 常能证明系统做过判断，但会话页给用户看的解释还偏碎片。`TraceNodeRenderer.tsx` 的 workbench summary 能显示 selected skills/connectors/MCP，但目前仍容易落成 ID 和技术名，不够像“本轮任务策略”。

### 交付物感

Alma 的 `ArtifactPanel`、`ArtifactTabs`、`ArtifactIndicator`、`TextWithArtifacts`、`ArtifactWorkspaceProvider` 说明它把 artifact 做成会话内对象：回答正文可以插入 `<!--artifact:id-->`，聊天流里出现可点击 indicator，旁边 panel 支持 code/preview、copy、download、fullscreen。这比“某处生成了文件，用户再去侧栏找”更像正常交付。

Neo 的 `WorkspacePreviewPanel` 和 workspace assets 方向更重，甚至更适合复杂交付。但当前体验风险是产物和回答之间的归属关系不够强：预览面板能看，消息里也有 blocks，但用户回看 transcript 时，未必一眼知道某个 panel 里的产物来自哪一轮、哪句话、哪个 tool。

### 连续性

Alma main bundle 有 `channel_mappings`，并出现 telegram、discord、lark、weixin 等通道相关逻辑；同时有 `whisper-transcribe` IPC、global shortcut、prompt app shortcut、图片 placeholder 等能力。体验含义是：外部渠道、语音、图片不只是输入方式，它们应当进入同一条会话语义链。

Neo 已经有 `ChannelsSettings.tsx`、`channelAgentBridge.ts`、`TelegramChannel`、`FeishuChannel`、`useVoiceInput`、speech IPC、attachment/image 相关能力。差距更像“同一性验证”：Telegram/Feishu 发来的任务、语音转写来的任务、New Chat 发起的任务，是否都能看到同样的能力状态、模型策略、artifact 归属和错误摘要。

### 可靠性

二级 release note 证据提到长回复截断/重组、truncated tool output 保存到文件、主进程/database 性能优化、base64 heavy path 全局卡顿修复。当前 bundle 里也能看到 truncated、streaming、trace step、partial messages 等处理点。可靠性的 UX 重点不在让用户知道内部修了什么；它要表现为长任务结束后 transcript 不断裂、产物不丢、错误短而准、UI 不被大图片或大输出拖住。

Neo 有不少可靠性基础，包括 timeline、transcript/export、tool result summary、preview panel 和 channels service。但这些可靠性需要更明确地反馈给用户：例如“长输出已保存为附件”“本轮 trace 已归档”“图片已用 placeholder 占位并归属到本轮”，比静默处理更能建立信任。

## UX 对标矩阵

| Alma 体验点 | 用户感知 | Neo/code-agent 现状 | 差距类型 | 借鉴优先级 | 开发/设计建议 |
| --- | --- | --- | --- | --- | --- |
| [确证] `/` 合并 commands、plugin commands、ACP commands、skills、prompts | 想做事时先搜一个入口，不用先判断功能属于哪类 | SlashCommandPopover 有 GUI/registry/prompt commands，skills/MCP 推荐和选择在其他入口 | IA / 默认发现路径 | P0 | 把 slash 改成任务能力搜索：命令、prompt、skill、MCP server/tool、workbench preset 都能搜到，并在 New Chat 保持一致 |
| [确证] Composer 直接持有 selected skills、selected MCP、Artifact Mode、tool selector | 发任务前知道这轮会带哪些能力 | Composer store 已有 selectedSkillIds / selectedMcpServerIds，InlineWorkbenchBar 可切换，但表达分散 | 会话页串联不足 | P0 | 做一块“本轮任务配置”摘要，发送前和发送后都可见，显示名称、状态和来源 |
| [二级证据] provider setup banner、main task model、provider favorite/custom icon | 设置页帮助用户完成任务前置条件，不像配置仓库 | SettingsModal 分组强，model/settings 能配，但任务模型和推荐默认在会话页存在感弱 | 推荐 / 文案 / 状态回流 | P1 | 设置页给出“会影响会话页的推荐项”，会话页显示当前主任务模型及原因 |
| [确证] MCP status icon、MCP tools key、strict MCP config | 用户知道工具连接是否可用 | Neo 有 MCP settings、capability center、selected MCP metadata | 状态表达 | P1 | MCP/connector/skill 用统一 status pill：可用、需登录、未授权、失败、被本轮禁用 |
| [确证] turnEndReason、fallbackReason、providerResponseId、recordStep | 任务为什么结束、为什么降级、哪一步出错更清楚 | RouteTraceChip 和 FallbackBanner 存在，但较薄；部分信息仍在 trace/log | 可解释性 | P0 | 把模型策略、fallback、finish reason、关键 tool step 合成“本轮解释”popover |
| [确证] savedTokens / totalSavedTokens | 用户能看到系统帮自己省了上下文和费用 | Neo 有 context usage pill 和压缩/summary 相关能力 | 可解释性文案 | P1 | context pill 增加“本轮使用/节省/压缩来源”短说明，避免只显示数字 |
| [二级证据] clean conversation text、移除 terminal footer/interface clutter | transcript 像会话，不像终端 dump | ToolCallDisplay 有折叠策略，成功工具低噪；错误和长输出仍可能像日志 | 低噪音 | P1 | 建立 transcript clean mode：默认只显示短摘要、关键文件、错误行动建议；细节进展开层 |
| [确证/二级证据] truncated output 处理和保存 | 长输出不会把页面冲垮，也不会丢结果 | Neo 有 tool result summary 和 transcript/export 基础 | 可靠性反馈 | P1 | 对超长输出统一显示“已截断，完整输出已保存”，并提供一键打开 |
| [确证] ArtifactPanel 支持 preview/code/copy/download/fullscreen | 交付物像正式产物，可扫读、可打开、可复制 | WorkspacePreviewPanel 强，但聊天流里的 artifact 归属不够显性 | 交付物感 | P0 | 给每个 artifact 一个 transcript inline card/chip，标明来源 turn/tool，panel 和消息双向联动 |
| [确证] TextWithArtifacts 解析 `<!--artifact:id-->` | 产物出现在回答该出现的位置 | Neo 有 message blocks 和 preview panel，但缺少同等强度的 inline placeholder 语义 | 会话页串联不足 | P0 | 回答正文支持 artifact reference token，渲染为可点击小卡，打开对应 preview |
| [确证] image placeholder / LazyImage | 图片加载、分享、预览时页面不跳、不空白 | Neo 有附件和 preview 能力，但图片归属与加载状态需要逐场景验证 | 交付 polish | P1 | 图片生成/上传/分享统一 placeholder，显示所属 turn 和加载/失败状态 |
| [确证] channel_mappings 覆盖 telegram/discord/lark/weixin | 外部渠道像普通会话延伸 | Neo 有 ChannelsSettings、channelAgentBridge、Telegram/Feishu 等服务 | 连续性验证 | P1 | 外部渠道消息进入同一 ConversationEnvelope，回到桌面能看到来源、能力、产物和错误摘要 |
| [确证] whisper-transcribe、global shortcut、prompt app shortcut | 语音和快捷键是可发现的输入方式 | Neo 有 VoiceInputButton/useVoiceInput/speech IPC，快捷键发现需再查 UI 表达 | 可发现性 | P1 | 在 composer 和设置页同时显示当前语音快捷键、权限状态、转写 provider |
| [二级证据] 长回复修复、streaming、性能优化、base64 heavy path 修复 | 长任务更稳，页面不容易卡 | Neo 有 streaming/timeline/preview，但需要场景化验收 | 可靠性 | P1 | 建立长回复、长 tool 输出、大图、channel stream 的稳定性回归场景 |
| [推断] New Chat 与既有会话共用发现路径 | 用户新开任务时不会丢掉熟悉入口 | Neo 有 New Chat、composer store reset 和 workbench preset，但一致性要看实际 UI | 连续性 / 默认值 | P0 | New Chat、项目会话、渠道会话统一使用同一套 slash、workbench summary、artifact reference |

## 借鉴取舍

Neo 需要借鉴的，是 Alma 把能力变成会话页可见秩序的方式。Neo 没必要照搬的，是 Alma 为了降低复杂度做出的轻量化产品边界。Neo 的产品体量更重，正确动作应是把已有能力讲清楚、串起来、降噪，而不是把 Neo 改成另一个 Alma。

| 取舍 | Alma 做法 | Neo 是否需要 | 判断原因 | Neo 建议 |
| --- | --- | --- | --- | --- |
| 必须借鉴 | slash 统一搜索 commands、prompts、skills、plugin commands、ACP commands | 需要 | Neo 的能力入口太多，用户要先判断能力类型，影响发起任务速度 | 把 `/` 做成任务能力搜索，结果按可执行动作呈现，保留来源和状态 |
| 必须借鉴 | 发送前后显示 selected skills、selected MCP、tool/artifact 状态 | 需要 | Neo 已有 composer metadata 和 workbench 能力，但会话页表达分散 | 做“本轮任务状态条”，发送前显示将使用，发送后显示本轮使用和实际结果 |
| 必须借鉴 | turnEndReason、fallbackReason、recordStep 等解释线索产品化 | 需要 | Neo 能记录路由和 fallback，但用户看到的解释不够完整 | 合并 RouteTrace、Fallback、finish reason、关键 tool step，默认给短判断，展开看证据 |
| 必须借鉴 | artifact inline placeholder 和 ArtifactPanel 联动 | 需要 | Neo 的 WorkspacePreviewPanel 更强，但产物归属没有成为 transcript 主信息 | 每个 artifact 在聊天流里有可点击引用，并能和 preview panel 双向定位 |
| 必须借鉴 | clean transcript、短错误摘要、长输出截断保护 | 需要 | Neo 工具链强，噪音也更容易多；信任感会被 raw log 和长输出吃掉 | 默认显示短摘要和下一步动作，完整日志放进展开层或 trace |
| 选择性借鉴 | provider setup banner、provider favorite、自定义 icon | 部分需要 | Neo 设置页已经有分组和能力中心，不缺入口，缺的是任务导向推荐 | 只借鉴 setup banner 的任务语义：缺什么会影响哪类任务，别复制一套 provider 装饰层 |
| 选择性借鉴 | savedTokens / totalSavedTokens 展示 | 部分需要 | 数字本身不一定帮用户决策，展示过多会变成新噪音 | 只在 context pill 或 compact summary 里显示可解释信息，例如“已压缩旧上下文，保留关键文件” |
| 选择性借鉴 | MCP status icon | 需要，但不必照 UI | Neo 的 MCP/connector/skill 状态比 Alma 更复杂，需要统一状态语言 | 用一套 status pill 覆盖可用、需登录、未授权、连接失败、本轮禁用 |
| 选择性借鉴 | voice shortcut、global shortcut、prompt app shortcut | 低到中优先级 | Neo 已有语音输入，关键问题更像发现和权限反馈 | 在 composer 和设置页显示当前快捷键、权限、转写 provider；无需先做复杂快捷键体系 |
| 选择性借鉴 | channel mappings 让 Telegram/Discord/Lark 像普通会话 | 需要验证后借鉴 | Neo 已有 channel bridge，差距可能在桌面端回看和解释一致性 | 优先验证 Telegram/Feishu 是否进入同一 ConversationEnvelope，再决定 UI 补口 |
| 没必要照搬 | 把 Neo 的复杂 workspace/project/review/eval 收成轻量聊天产品 | 没必要 | Neo 的差异化就在重工作台和长任务协作，削弱这层会丢优势 | 保留重能力，但在会话页用摘要层降低理解成本 |
| 没必要照搬 | 单独复制 Alma 的 Artifact Mode | 没必要 | Neo 已经有 WorkspacePreviewPanel 和 workspace assets，重复一个模式会增加入口 | 借鉴 artifact 归属和 inline reference，不新增平行模式 |
| 没必要照搬 | 默认展示完整 trace/hook/performance 细节 | 没必要 | 用户需要判断和证据，不需要把每轮都读成排障报告 | 默认一行解释，详细 trace 只在用户展开或调试视图中出现 |
| 没必要照搬 | 为所有 provider/plugin 做视觉收藏、图标、偏好装饰 | 没必要 | Neo 当前更大的问题是能力路径和状态清晰度，装饰层收益低 | 先做“推荐用于当前任务”和“是否可用”，视觉个性化放后面 |
| 没必要照搬 | 为 every token / every step 都做可视化指标 | 没必要 | 指标多会反向增加会话噪音，尤其 Neo 的 trace 维度更复杂 | 只暴露影响用户判断的指标：上下文是否够、是否降级、是否截断、是否保存完整输出 |

## 如何借鉴

借鉴 Alma 时，Neo 应该先借体验结构，再借具体控件。Alma 的价值在“用户一眼知道这轮任务如何被配置、如何执行、如何交付”，Neo 的落点应该是把已有的 composer、settings、trace、preview、channels 串成同一条会话路径。

### 借鉴原则

- 先会话页，后设置页。设置页只负责准备能力，用户信任发生在会话页；每个设置项都要能回流成会话页里的状态、推荐或错误恢复。
- 先摘要，后详情。默认给用户一行判断和关键状态，完整 trace、hook、tool log、provider response id 放进展开层。
- 先统一语义，再统一视觉。skills、MCP、connectors、provider、voice、channels 都应共用同一套状态语言：可用、需配置、需授权、失败、本轮禁用、本轮已使用。
- 先复用 Neo 已有重能力，再补表达层。Neo 已有 WorkspacePreviewPanel、ConversationEnvelope、turn timeline、composer store、channels bridge，不需要另起一套轻量 Alma 模式。

### 落地路径

| 借鉴方向 | Neo 现有落点 | 怎么借 | 先做什么 | 需要避免 |
| --- | --- | --- | --- | --- |
| 统一能力发现 | `SlashCommandPopover.tsx`、`useWorkbenchCapabilities`、`CapabilitySuggestionStrip`、`workbenchPresetStore` | 把 slash 结果抽成统一 result schema，来源可以是 command、prompt、skill、MCP、connector、preset | `/` 搜索时先显示可执行动作和状态，选择后写入 composer context | 继续让用户在 slash、能力条、设置页之间猜入口 |
| 本轮任务状态条 | `composerStore.ts`、`InlineWorkbenchBar.tsx`、`TraceNodeRenderer.tsx`、`conversationEnvelope.ts` | 把发送前 context 和发送后 metadata 合成同一条“本轮使用”表达 | 先显示 model、skills、MCP、connectors、context、artifact intent 的名称和状态 | 直接展示裸 ID、内部 enum 或过多 chip |
| 可解释执行 | `RouteTraceChip.tsx`、`FallbackBanner.tsx`、`turnTimelineProjection.ts`、`modelDecision` | 把 route、fallback、finish reason、关键 tool step 聚合成一层解释 | 默认一句话说明“为什么这样跑/为什么降级/是否完整结束”，展开看证据 | 把 trace 当主界面，把用户推去读日志 |
| artifact 归属 | `WorkspacePreviewPanel.tsx`、message blocks、workspace assets、turn timeline | 借鉴 Alma 的 inline artifact reference，把产物挂回对应回答和 turn | 先做 transcript inline card/chip，与 preview panel 双向定位 | 新增一个平行 Artifact Mode，导致 preview 入口更多 |
| 低噪错误 | `ToolCallDisplay`、`FallbackBanner`、tool result summary、transcript exporter | 建一套错误分类和短文案：认证、额度、网络、权限、截断、provider fallback、channel 发送失败 | 先覆盖最常见 raw error，把默认视图改成短摘要 + 下一步动作 | 把完整 stack、CLI 输出、HTTP body 直接塞进聊天流 |
| 设置回流 | `SettingsModal.tsx`、settings index、capability center、model settings、MCP/settings tabs | 借 setup banner 的任务语义，让设置页说明“会影响哪类任务” | 在设置页和 composer 之间建立同一套缺口提示，例如 MCP 未授权、voice permission 未开 | 把设置页继续做成配置仓库，只显示开关和表单 |
| 连续入口 | `channelAgentBridge.ts`、`ChannelsSettings.tsx`、`useVoiceInput`、speech IPC、attachment flow | 外部渠道、语音、图片、新会话都进入同一 ConversationEnvelope 和同一状态条 | 先验证 Telegram/Feishu、voice、image 是否能在桌面回看同一任务解释 | 为每个入口做一套单独 UI 和单独错误表达 |

### 切片顺序

1. 先做只读表达层

   从现有 metadata 里读 selected skills、selected MCP、model decision、context usage、fallback 和 artifact intent，先把“本轮任务状态条”显示出来。这个切片不改 runtime，不改 tool 调用，只解决用户看不懂当前回合的问题。

2. 再做 slash 统一入口

   把现有 SlashCommandPopover 和 workbench capability registry 接起来，让 `/` 能搜到 prompt、skill、MCP、connector、preset。这个切片的目标是减少发起任务前的选择路径，不先追求所有能力都能一步执行。

3. 接着做 artifact 双向归属

   先让已有 preview panel 和消息内 artifact reference 对上同一个 artifact id。用户从消息能打开产物，从产物能回到来源 turn。这个切片会直接提高交付物感，也方便后续做截图验收。

4. 然后统一错误短摘要

   先覆盖 provider fallback、MCP auth fail、tool fail、长输出截断、channel fail 五类。每类只给默认短文案和下一步动作，完整错误留给展开层。

5. 最后让设置页推荐回流

   设置页不先大改 IA，只补任务导向 setup banner 和 composer 侧提示。缺 provider、缺 MCP、缺 channel token、缺 voice permission 时，用户能知道这会影响什么任务，以及回到会话页后状态为何变化。

### 成功标准

- 用户发起任务前，不需要先理解 Neo 的能力分类，就能搜到可用能力。
- 用户看一轮完成后的 transcript，能在 5 秒内说出本轮用了什么能力、是否降级、是否失败、交付物在哪。
- 复杂 trace、hook、tool log 仍然可查，但默认不会挤占聊天流。
- New Chat、项目会话、语音、图片、Telegram/Feishu 入口进入同一套会话解释，不因为入口不同改变用户理解路径。
- 设置页里的配置变化能在会话页被看见，用户不会觉得“我配了，但不知道有没有生效”。

## 实施计划

这份计划按“先让用户看懂一轮任务，再减少发起任务的弯路，最后补齐设置和多入口连续性”推进。MVP 不改 agent runtime 的核心执行链，先用现有 metadata、timeline、composer context 和 preview 能力做表达层闭环。

### MVP 边界

必须进入 MVP：

- 本轮任务状态条：发送前/执行中/完成后都能显示本轮能力、模型策略、上下文、fallback、artifact intent。
- 统一 slash 入口：`/` 至少能搜到 commands、prompts、installed skills、MCP servers/tools、workbench presets。
- artifact 归属：聊天流里能看到 artifact inline card/chip，能打开对应 preview，也能从 preview 回到来源 turn。
- 错误短摘要：覆盖 provider fallback、MCP auth fail、tool fail、长输出截断、channel send fail 五类。

暂不进入 MVP：

- provider favorite/custom icon 这类装饰能力。
- 完整 trace inspector 和 performance dashboard。
- 新增平行 Artifact Mode。
- 全量重做设置页 IA。
- every token / every step 的可视化指标。

### 阶段拆分

| 阶段 | 目标 | 主要工作 | 产出物 | 验收 |
| --- | --- | --- | --- | --- |
| Phase 0：基线和契约 | 把现有数据源摸清，避免 UI 先行 | 梳理 `composerStore`、`conversationEnvelope`、`turnTimelineProjection`、`TraceNodeRenderer`、`WorkspacePreviewPanel` 里已有字段；列出缺的 label/status/artifact id | 一份字段契约表、一组现状截图、MVP 交互草图 | 不写新 UI 也能说明每个展示字段从哪里来；缺口有明确 owner |
| Phase 1：只读任务状态条 | 先解决“用户看不懂这一轮怎么跑” | 新建 turn summary adapter，把 model decision、selected skills/MCP/connectors、context usage、fallback、finish state 聚合成统一 view model；先在会话页只读展示 | 发送前“将使用”、完成后“本轮使用”的状态条 | 选择 skill/MCP 后发送，聊天流能显示可读名称和状态；没有裸 ID |
| Phase 2：统一 slash 发现 | 减少发起任务前的入口判断 | 给 slash 建统一 result schema；接入 command、prompt、skill、MCP、connector、preset；选择结果写入 composer context 或插入命令 | `/` 搜索面板、分组结果、状态/来源标签 | New Chat 和已有会话输入 `/lark`、`/image`、`/deploy` 能看到跨类型结果并可选择 |
| Phase 3：artifact 双向归属 | 让交付物成为 transcript 的一部分 | 定义 artifact reference；消息内渲染 inline card/chip；preview panel 支持回跳来源 turn；缺 artifact 时显示稳定 placeholder | artifact inline card、preview 联动、来源回跳 | 一轮生成多个 artifact 时，用户能从消息打开正确 preview，并从 preview 找回来源 |
| Phase 4：错误短摘要 | 降低失败 turn 的阅读成本 | 建错误分类、短文案和恢复动作；把 FallbackBanner、ToolCallDisplay、channel/tool errors 接入同一表达；完整错误放展开层 | 统一 error summary 组件和错误映射表 | 五类失败默认只显示短摘要和下一步动作，展开后仍能看到完整细节 |
| Phase 5：设置回流和连续入口 | 让设置变化、多入口任务都进入同一解释层 | 设置页补任务导向 setup banner；composer 侧展示缺口提示；验证 New Chat、voice、image、Telegram/Feishu 是否进入同一 envelope | setup banner、composer gap hint、多入口 smoke checklist | 设置页改动能在会话页看到状态变化；外部渠道任务回到桌面后仍有同一套状态条 |

### 推荐排期

- 第 1 周：Phase 0 + Phase 1。先产出字段契约和只读状态条，尽快拿到截图对比。
- 第 2 周：Phase 2。统一 slash 入口，减少用户发起任务前的分类成本。
- 第 3 周：Phase 3 + Phase 4。把产物归属和错误摘要接上，解决交付和失败两个最影响信任的点。
- 第 4 周：Phase 5。补设置页推荐回流和多入口连续性，做整链路走查。

### 关键依赖

- 能从 skill/MCP/connector registry 拿到稳定可读名称、状态和配置缺口；拿不到时不能默认展示裸 ID。
- `ConversationEnvelope` 和 turn timeline 需要能承载发送前 context、执行后实际使用能力、artifact reference、fallback/finish state。
- Workspace preview 需要稳定 artifact id；如果当前 artifact 只有文件路径或临时 id，需要先定义可回放引用。
- 错误分类需要覆盖 renderer、main、tool、provider、channel 多来源，避免每条链路各写一套文案。
- E2E 需要有可控 fake provider/MCP/channel 场景，否则 fallback 和失败摘要只能靠单测覆盖，验收不够真实。

### 风险和处理

- 风险：状态条变成一排技术 chip。处理：默认只露出 3 到 5 个最影响判断的信息，更多内容进展开层。
- 风险：slash 结果过多，搜索面板反而更乱。处理：按 intent 排序，先显示已安装/已配置/推荐项，未配置项放后面并带 setup action。
- 风险：错误摘要遮住排障信息。处理：短摘要默认展示，完整 raw error、stack、HTTP body、CLI output 保留在展开层和 trace。
- 风险：artifact inline card 与 WorkspacePreviewPanel 重复表达。处理：inline card 只负责归属和打开，preview panel 负责阅读、复制、下载、反馈。
- 风险：设置页 banner 变成另一套 onboarding。处理：只展示会影响当前任务路径的缺口，不做泛泛功能介绍。

### 验收门槛

- 产品走查：同一任务从 New Chat 发起，选择 skill/MCP，生成 artifact，触发一次 fallback 或 tool fail，用户不看日志也能说清本轮状态。
- 自动化：每个 Phase 至少有一条贴近行为的 renderer/E2E 测试；Phase 1 到 4 必须覆盖 metadata、slash selection、artifact id、error summary。
- 截图对比：保留改造前后同一任务的聊天流截图，重点看首屏噪音、状态可读性、artifact 归属和错误短摘要。
- 回归边界：已有 WorkspacePreviewPanel、settings navigation、tool expand/collapse、channel bridge 不因新增表达层退化。

## 当前实现覆盖审计（2026-06-14）

这条分支已经从研究计划进入了第一轮 MVP 实现。当前实现方向符合上面的取舍：优先借鉴 Alma 的会话页解释层、低噪错误、artifact 归属和设置回流，没有去复制 Alma 的轻量 Artifact Mode、provider 装饰层或完整 trace 面板。

### 当前目标收口口径

2026-06-14 后续目标收口为三项：provider 失败 UI smoke 可重复、桌面壳设置保存后 readiness 即时回流、真实语音端到端。Telegram/Feishu 真实账号入口不再作为本轮 goal 完成门槛，保留为后续风险。当前三项均已补到可复验记录；语音项的自动化边界是系统/浏览器麦克风权限仍被拒绝，所以本轮用真实 wav 文件验证产品转写入口和 Mimo ASR 能力，麦克风按钮录制截图留作后续权限恢复后的产品走查。

| 计划项 | 当前覆盖 | 已有证据 | 还缺的验收 |
| --- | --- | --- | --- |
| Phase 1：本轮任务状态条 | 已实现只读摘要，覆盖 workspace、路由、runtime input、selected skills/MCP/connectors、模型策略、fallback、blocked capability、artifact、语音/图片/外部渠道来源；真实发送后 raw workbench metadata 被 projection 剥离时，也能从 `workbench_snapshot` 兜底显示能力选择；web `/api/run` 现在会把 selected MCP server 转成本轮 tool scope，并预加载该 server 的 MCP tools，避免“会话页选了 MCP 但 runtime 仍看不见工具” | `turnTaskStatus.ts`、`TurnTaskStatusBar.tsx`、`TurnCard.tsx`、`turnTaskStatus.test.ts`、`src/web/routes/agent.ts`、`src/cli/bootstrap.ts`、`src/cli/types.ts`、`src/main/agent/runtime/contextAssembly/deferredToolPreload.ts`、`tests/unit/agent/deferredToolPreload.test.ts`、`tests/renderer/hooks/useConversationStreamEffects.test.ts`、`tests/e2e/alma-ux-visible.spec.ts`、`tests/e2e/alma-ux-send-metadata.spec.ts`、`tests/e2e/alma-ux-real-mcp-auth-failure-api.spec.ts`、`tests/e2e/alma-ux-real-image-upload.spec.ts`、`tests/e2e/alma-ux-real-channel-entry.spec.ts`、`tests/e2e/screenshots/alma-ux-voice-image-status.png`、`tests/e2e/screenshots/alma-ux-send-metadata-status.png`、`tests/e2e/screenshots/alma-ux-real-image-upload-status.png`、`tests/e2e/screenshots/alma-ux-real-channel-entry.png`、`tests/e2e/screenshots/alma-ux-real-mcp-auth-failure-inapp.png` | 已覆盖注入式语音来源 + 图片附件、真实 composer 图片上传、真实 HTTP API channel 入口、真实发送后 slash-selected Skill/MCP/Connector 进入完成 turn 状态条，无浏览器 API/SSE 级真实 selected MCP server -> MCP tool call，以及 in-app Browser 真实 UI 里 `/mcp:authfail` 选择后完成 turn 状态条显示 `MCP authfail`；还需要更完整的真实任务截图对比，确认状态条在复杂任务里仍可扫读 |
| Phase 2：统一 slash 发现 | 已把 slash 结果扩到 commands、prompts、skills、MCP、connectors、workbench capability，并补了能力条；已修正已安装未挂载 skill 和已启用但待授权 connector 在 slash 里不可发现的问题 | `slashDiscovery.ts`、`SlashCommandPopover.tsx`、`ComposerCapabilityStrip.tsx`、`workbenchCapabilityRegistry.test.ts`、`slashDiscovery.test.ts`、`skillStore.test.ts`、`tests/e2e/alma-ux-visible.spec.ts`、`tests/e2e/alma-ux-send-metadata.spec.ts`、`tests/e2e/screenshots/alma-ux-slash-skill-strip.png`、`tests/e2e/screenshots/alma-ux-existing-session-mcp-connector-strip.png`、`tests/e2e/screenshots/alma-ux-send-metadata-status.png` | 已覆盖 New Chat 搜索并选择 skill，已有会话选择 MCP/connector 到 composer strip，以及真实发送后 Skill/MCP/Connector metadata/status bar 一致；未挂载 skill 和待授权 connector 会在状态条里明确标为未生效 |
| Phase 3：artifact 双向归属 | 已让 turn artifact 带来源信息，消息内 artifact card 能打开 preview，preview 能回跳来源 turn/source node；同一路径的 tool output 与 turn artifact 已去重，优先保留带来源的 artifact 入口 | `workspacePreview.ts`、`useWorkspacePreviewModel.ts`、`turnTimelineProjection.ts`、`FileArtifactCard.tsx`、`WorkspacePreviewPanel.tsx`、`workspacePreviewArtifacts.test.ts`、`useTurnExecutionClarity.test.ts`、`tests/e2e/alma-ux-artifact-ownership.spec.ts`、`tests/e2e/alma-ux-real-multi-artifact.spec.ts`、`tests/e2e/screenshots/alma-ux-artifact-ownership.png`、`tests/e2e/screenshots/alma-ux-artifact-ownership-multiple.png`、`tests/e2e/screenshots/alma-ux-real-multi-artifact.png` | 已覆盖单 artifact、注入式同一 turn 多 artifact，以及真实发送后两个 `Write` 产物的 transcript card -> preview -> 来源回跳 |
| Phase 4：错误短摘要 | 已建错误分类和 banner，覆盖 provider fallback、MCP/auth、connector、tool fail、长输出截断、channel fail；失败 tool 默认不直接展开 raw 细节，展开后仍能看完整错误；终端 provider 网络/Base URL 失败现在会进入当前 turn 的错误摘要，而不是只落到 session 状态；blocked MCP 授权失败也会归为 `MCP 授权失效`；真实 stdio MCP tool 返回 `isError + invalid_token` 时会进入 `ToolResult.error`，并能通过真实 `/api/run` SSE 返回短授权错误；provider 失败 UI smoke 已可用隔离 webServer + in-app Browser 重跑，默认折叠态不泄露 raw Base URL，展开后仍能查看完整错误 | `turnErrorSummary.ts`、`TurnErrorSummaryBanner.tsx`、`ToolCallDisplay/index.tsx`、`useSessionLifecycleEffects.ts`、`useTurnProjection.ts`、`src/main/mcp/mcpToolRegistry.ts`、`src/main/mcp/mcpClient.ts`、`src/main/model/e2eLocalAgentModel.ts`、`src/main/agent/runtime/contextAssembly/deferredToolPreload.ts`、`tests/unit/mcp/mcpToolRegistry.test.ts`、`tests/integration/mcp/authFailureState.test.ts`、`tests/unit/model/e2eLocalAgentModel.test.ts`、`tests/e2e/alma-ux-real-mcp-auth-failure-api.spec.ts`、`tests/fixtures/mcp/auth-failure-server.mjs`、`turnErrorSummary.test.ts`、`turnErrorSummaryBanner.test.tsx`、`useSessionLifecycleEffects.errorState.test.ts`、`useTurnProjection.test.ts`、`tests/e2e/alma-ux-error-summary.spec.ts`、`tests/e2e/alma-ux-real-error-summary.spec.ts`、`tests/e2e/alma-ux-real-provider-failure-api.spec.ts`、`tests/e2e/alma-ux-real-channel-connect-failure-api.spec.ts`、`tests/e2e/alma-ux-real-provider-failure.spec.ts`、`tests/e2e/screenshots/alma-ux-error-summary.png`、`tests/e2e/screenshots/alma-ux-error-summary-mixed-failures.png`、`tests/e2e/screenshots/alma-ux-real-error-summary.png`、`tests/e2e/screenshots/alma-ux-real-mcp-auth-failure-inapp.png`、`tests/e2e/screenshots/alma-ux-real-provider-failure-inapp.png` | 已覆盖 Bash tool fail、provider fallback + MCP auth fail + channel send fail 的混合可控失败 E2E、真实 agent loop 触发真实 `Read` 缺失文件失败后的短摘要、终端 provider 网络/Base URL 失败的单测和投影测试、无浏览器 API/SSE 级真实 provider adapter 失败、无浏览器 API/SSE 级真实 selected MCP server 调用 stdio MCP 后返回 `invalid_token`、真实 HTTP API channel 同端口绑定失败、blocked MCP auth fail 的摘要映射、真实 stdio MCP 进程返回 `invalid_token` 后的主进程错误回流、provider 终端失败在 banner 默认折叠态不泄露 raw `ECONNREFUSED` 的 renderer 渲染测试、in-app Browser 真实会话页里 `MCP 授权失效 · mcp__authfail__search · 需要重新授权` 的截图，以及隔离 webServer + in-app Browser 重跑真实 provider 配置失败进入统一 `TurnErrorSummaryBanner` 的截图；Playwright bundled Chromium、Playwright system Chrome channel、system Chrome CDP helper 在当前执行环境仍未能启动，作为后续自动化质量项，不再阻塞当前目标收口 |
| Phase 5：设置回流 | 已补 composer 侧和设置页侧的任务导向缺口提示，覆盖模型、Browser、voice permission、channel account、selected skill/MCP/connector；模型配置修复后，composer 缺口和设置页 readiness 会同步消失；MCP bearer token 失效会显示为 `MCP 授权失效` 和 `重新授权`，不再只是泛泛连接错误；真实 stdio MCP 工具返回授权错误后，server state 会标记为 `error` 并保留错误文本，供 workbench registry 投影；启用但断开或连接失败的 channel account 会提示，禁用后会话页和设置页缺口消失；Web/app-host 设置页现在也可通过模型表单保存 Provider key，避免“去设置修复”落到禁用保存按钮；模型设置保存成功后会广播 settings snapshot change，ChatInput 和 SettingsModal 会立即重拉 readiness snapshot，避免用户保存 key 后还要刷新/重进会话才看到缺口消失；语音录音入口在不支持、麦克风权限拒绝或访问失败时会广播 voice setup change，让 composer/settings 重新读取权限状态；桌面壳代码链路上，模型 Provider setup 仍走同一个 `settings:set` IPC handler，且非 admin 写入模型配置已被 IPC 单测允许；Tauri dev 桌面壳已在本机连到同一 8180 app-host 后完成保存回流走查，保存 qwen key 后 settings readiness 和 composer readiness 都即时从 Model 缺口降级为只剩 Voice 权限缺口 | `workbenchCapabilityRegistry.ts`、`mcpRecovery.ts`、`composerCapabilityGaps.ts`、`settingsRefresh.ts`、`ComposerCapabilityGapBanner.tsx`、`SettingsTaskReadinessBanner.tsx`、`useVoiceSetupGap.ts`、`useVoiceInput.ts`、`useChannelSetupGap.ts`、`ProviderDetailSections.tsx`、`ModelSettings.tsx`、`ChatInput/index.tsx`、`SettingsModal.tsx`、`src/main/ipc/settings.ipc.ts`、`src/main/mcp/mcpClient.ts`、`src/main/mcp/mcpToolRegistry.ts`、`src/main/channels/api/apiChannel.ts`、`tests/unit/renderer/settingsRefresh.test.ts`、`tests/unit/renderer/voiceSetupGap.test.ts`、`tests/unit/ipc/settingsAccess.ipc.test.ts`、`tests/integration/mcp/authFailureState.test.ts`、`tests/renderer/utils/workbenchCapabilityRegistry.test.ts`、`tests/renderer/utils/workbenchQuickActions.test.ts`、`tests/e2e/alma-ux-visible.spec.ts`、`tests/e2e/alma-ux-real-channel-connect-failure-api.spec.ts`、`tests/e2e/screenshots/alma-ux-settings-readiness.png`、`tests/e2e/screenshots/alma-ux-settings-readiness-cleared.png`、`tests/e2e/screenshots/alma-ux-settings-ui-save-cleared.png`、`tests/e2e/screenshots/alma-ux-tauri-settings-readiness-cleared.png`、`tests/e2e/screenshots/alma-ux-channel-readiness-cleared.png`、`tests/e2e/screenshots/alma-ux-real-mcp-auth-failure-inapp.png` 及对应测试/手验 | 已覆盖 composer 模型缺口跳到设置页 readiness、settings API 修复默认模型配置后回到会话页/设置页缺口消失、Web/app-host 设置 UI 手填 Provider key 保存后缺口消失、Tauri/桌面壳 dev 窗口连接 app-host 后从会话页进入 settings UI 手填 Provider key 保存并即时清除 Model 缺口、模型设置保存后的 renderer settings refresh 事件、语音 setup change 事件广播、桌面 IPC handler 接受普通模型 Provider 配置写入、MCP auth fail 的重新授权表达、真实 stdio MCP 进程授权失败的主进程状态回写、in-app Browser 真实 UI 里 MCP 授权失败的会话页短摘要和 server state `error`、channel account 断开/禁用后的设置回流、真实 HTTP API channel 端口绑定失败回写 account `errorMessage`，以及真实 wav 进入产品 `/api/speech/transcribe` 转写成功；麦克风按钮录制因当前 in-app Browser 权限拒绝无法自动化，保留为后续系统权限恢复后的产品走查 |
| 多入口连续性 | 已给 channel 和 voice 写入 `entrySource`，状态条能显示外部渠道和语音来源；Feishu/Telegram 入口会进入同一套 channel metadata，状态条能显示渠道名，并在 hover title 保留渠道类型、会话和发送人；图片输入在状态摘要里可见；`message` 事件现在能把带 attachments/metadata 的用户消息加入会话页，真实 composer file chooser 上传图片后也能进入完成 turn 状态条；本地 HTTP API channel 已走过真实账号创建、连接、连接失败、`POST /api/message`、专用 channel session 回看；真实语音服务链路已用公开 wav 样本验证现有 Groq 路径和 Mimo ASR 候选路径 | `conversationEnvelope.ts`、`channelAgentBridge.ts`、`turnTaskStatus.ts`、`useAgentIPC.ts`、`useConversationStreamEffects.ts`、`ChatInput/index.tsx`、`channelMessageMetadata.test.ts`、`turnTaskStatus.test.ts`、`tests/e2e/alma-ux-real-image-upload.spec.ts`、`tests/e2e/alma-ux-real-channel-entry.spec.ts`、`tests/e2e/alma-ux-real-channel-connect-failure-api.spec.ts`、`tests/e2e/screenshots/alma-ux-voice-image-status.png`、`tests/e2e/screenshots/alma-ux-real-image-upload-status.png`、`tests/e2e/screenshots/alma-ux-real-channel-entry.png` | 已覆盖可控语音转写 + 图片输入的桌面会话回看 smoke、Feishu/Telegram channel metadata 和状态条投影单测、真实 composer 图片上传端到端、真实 HTTP API channel 本地入口、真实 HTTP API channel 连接失败不会被误标为 connected、产品 `/api/speech/transcribe` 对真实 wav 返回 transcript，以及 `mimo-v2.5-asr` 对同一 wav 返回 transcript 和 `audio_tokens`；还需要 Telegram/Feishu 真实账号入口和麦克风权限恢复后的 UI 录音截图 |

### 当前判断

- 最值得继续保的是“会话页信任链路”：发起前的能力发现、执行中的状态、失败时的短摘要、交付物的来源回跳。这几块已经形成一条线，继续打磨会比新增设置项收益更高。
- 还不应该继续扩的是完整 trace/performance inspector、单独 Artifact Mode、provider 收藏/图标装饰。这些会增加入口和视觉噪音，和本轮目标相反。
- 当前最大的剩余风险已经从“没有真实 E2E”收窄为“真实端到端场景还不够全”。slash skill/MCP/connector 选择、真实发送后的 metadata/status bar、设置回流、失败短摘要、artifact 双向定位、语音来源 + 图片输入状态条、本地 HTTP API channel 真实入口已有真实 web smoke 和截图；设置回流已覆盖模型缺口出现、跳转 settings readiness、API 修复后会话页和设置页缺口消失、Web/app-host 设置 UI 手填 Provider key 保存后会话页和设置页缺口消失、Tauri dev 桌面壳连接 app-host 后设置 UI 保存 key 即时清除 Model readiness、模型设置保存后 renderer 主动刷新 readiness snapshot、语音录音失败后的 setup refresh 事件、桌面 IPC 接受模型 Provider setup、MCP 授权失效的重新授权表达、真实 stdio MCP 进程返回 `invalid_token` 后的 state error 回写，以及 channel account 断开/禁用/连接失败后的提示回流；失败短摘要已覆盖 Bash tool fail、provider/MCP/channel 混合失败注入场景、真实 agent loop 的 `Read` 缺失文件失败、终端 provider 网络/Base URL 失败的投影和摘要单测、banner 折叠态渲染测试、blocked MCP auth fail 摘要映射、真实 stdio MCP `isError` 转 `ToolResult.error`，以及真实 HTTP API channel 同端口绑定失败；无浏览器 API/SSE 级真实 provider 配置失败已覆盖设置 API、`/api/run`、真实 provider adapter 和 SSE error event；真实 MCP 授权失败已覆盖 selected MCP server -> 本轮 tool preload -> 真实 stdio MCP tool call -> SSE tool failure -> server state error，并已补 in-app Browser 会话页截图；真实 provider 配置失败已用隔离 webServer + in-app Browser 重跑并补截图，当前已进入统一错误摘要 banner；artifact 已覆盖单产物、注入式同一 turn 多产物，以及真实 agent loop 两次 `Write` 生成多产物；图片已覆盖真实 composer file chooser 上传到完成 turn 状态条；HTTP API channel 已覆盖真实账号创建、连接、API 入站、专用 channel session、状态条回看和连接失败回写 account error；语音已覆盖真实 wav -> 产品 `/api/speech/transcribe` -> transcript，以及 Mimo `mimo-v2.5-asr` -> chat-completions 音频输入 -> transcript + `audio_tokens`；Feishu/Telegram channel metadata 与状态条投影已有类型级单测。按当前收口口径，三项目标已经有可复验记录；后续风险主要是麦克风权限恢复后的 UI 录音截图、Telegram/Feishu 真实账号入口和 Playwright provider UI 自动化。

### 本轮验收记录

- `npx vitest run tests/renderer/components/composerCapabilityGapBanner.test.tsx tests/renderer/components/settingsTaskReadinessBanner.test.tsx tests/renderer/stores/skillStore.test.ts tests/unit/channels/channelMessageMetadata.test.ts tests/unit/renderer/channelSetupGap.test.ts tests/unit/renderer/composerCapabilityGaps.test.ts tests/unit/renderer/slashDiscovery.test.ts tests/unit/renderer/turnTaskStatus.test.ts tests/unit/renderer/voiceSetupGap.test.ts tests/unit/renderer/workspacePreviewArtifacts.test.ts tests/unit/renderer/turnErrorSummary.test.ts tests/renderer/components/browserComputerActionPreview.rendering.test.ts tests/renderer/utils/workbenchCapabilityRegistry.test.ts`：13 个文件、70 条测试通过。
- `npx vitest run tests/unit/renderer/voiceSetupGap.test.ts tests/unit/renderer/composerCapabilityGaps.test.ts tests/renderer/components/composerCapabilityGapBanner.test.tsx`：3 个文件、25 条测试通过；验证 voice setup 只读权限状态、不会触发 `getUserMedia` 授权弹窗，且录音入口可通过固定事件名触发 composer/settings 重新读取 readiness。
- `npx vitest run tests/unit/channels/channelMessageMetadata.test.ts tests/unit/renderer/turnTaskStatus.test.ts`：2 个文件、12 条测试通过；验证 Feishu/Telegram 入站消息都会写入统一 channel entrySource，状态条可显示渠道名，并在 title 中保留渠道类型、会话和发送人。
- `npm run typecheck`：通过；验证新增 voice setup refresh import、事件函数和 renderer 设置回流类型链路没有破坏 TS 契约。
- `npm run build:renderer`：通过；Vite 仍有既有 chunk size / ineffective dynamic import warning，但 renderer 产物构建成功。
- `npx vitest run tests/renderer/hooks/useConversationStreamEffects.test.ts tests/unit/renderer/turnTaskStatus.test.ts`：2 个文件、25 条测试通过；验证 `message` 事件可把带 attachments 和 workbench metadata 的用户消息加入会话页，语音/图片状态摘要仍稳定；同时覆盖真实发送后用户节点 metadata 被转成 `workbench_snapshot` 时，状态条仍能显示 Skill/MCP 能力选择。
- `npx vitest run tests/renderer/hooks/useTurnExecutionClarity.test.ts tests/unit/renderer/workspacePreviewArtifacts.test.ts`：2 个文件、16 条测试通过；覆盖 no-user/recovered turn 的 artifact ownership 投影，以及 turn artifact 优先于普通 tool output 的 preview 去重。
- `npm run typecheck`：通过。
- `E2E_WEB_PORT=8203 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-error-summary.spec.ts`：2 条通过；验证失败工具默认显示短摘要，不泄露完整错误 marker，展开后可见完整错误；同时覆盖 provider fallback、MCP 授权失效、外部渠道发送失败三类混合失败，截图为 `tests/e2e/screenshots/alma-ux-error-summary.png` 和 `tests/e2e/screenshots/alma-ux-error-summary-mixed-failures.png`。
- `npx vitest run tests/renderer/utils/workbenchCapabilityRegistry.test.ts tests/unit/renderer/slashDiscovery.test.ts tests/unit/renderer/composerCapabilityGaps.test.ts`：3 个文件、21 条测试通过；验证已启用但待检查的 native connector 会进入 workbench/slash 可发现范围，且能力缺口提示仍指向修复路径。
- `npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-visible.spec.ts`：6 条通过；验证 slash skill 选择进入 composer capability strip，已有会话可选择 MCP 和已启用 connector 到 composer capability strip，语音来源 + 图片输入能进入会话页状态条，composer 模型缺口可跳到 settings readiness，settings API 修复默认模型配置后 composer 缺口和 settings readiness 同步消失，以及启用但断开的 channel account 进入 composer/settings 缺口、禁用后两处缺口同步消失；截图为 `tests/e2e/screenshots/alma-ux-slash-skill-strip.png`、`tests/e2e/screenshots/alma-ux-existing-session-mcp-connector-strip.png`、`tests/e2e/screenshots/alma-ux-voice-image-status.png`、`tests/e2e/screenshots/alma-ux-settings-readiness.png`、`tests/e2e/screenshots/alma-ux-settings-readiness-cleared.png`、`tests/e2e/screenshots/alma-ux-channel-readiness-cleared.png`。
- `CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-send-metadata.spec.ts`：1 条通过；验证真实 UI 发送链路中 `/xlsx` 选中的 Skill、`/calendar` 选中的 Connector 和 `/mcp` 选中的 MCP 写入 turn，完成后状态条显示 `模型 gpt-5`、`Skill xlsx`、`Connector Calendar`、`MCP context7`，并把未挂载的 skill 和待授权 connector 明确归入 `未生效 2`；截图为 `tests/e2e/screenshots/alma-ux-send-metadata-status.png`。
- `E2E_WEB_PORT=8204 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-artifact-ownership.spec.ts`：2 条通过；验证工具产物在 transcript 内显示 artifact card，可打开 WorkspacePreviewPanel，并能从 preview 回跳来源 source node；同时覆盖同一 turn 多 artifact 的 preview 切换和来源回跳不串；截图为 `tests/e2e/screenshots/alma-ux-artifact-ownership.png` 和 `tests/e2e/screenshots/alma-ux-artifact-ownership-multiple.png`。
- `npx vitest run tests/unit/model/e2eLocalAgentModel.test.ts`：1 个文件、7 条测试通过；验证 E2E-only deterministic model 的 Read、TaskManager、真实多产物 marker、真实工具失败 marker 和真实 MCP auth failure marker 分支互不干扰；多产物 marker 会先发出两个 `Write`，真实工具失败 marker 会先发出一个指向缺失文件的 `Read`，MCP auth marker 会先发出 `mcp__authfail__search`。
- `CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-real-multi-artifact.spec.ts`：1 条通过；验证真实 composer 发送后，deterministic local model 驱动真实 agent loop 顺序执行两个 `Write`，聊天流出现两个 artifact card，WorkspacePreviewPanel 显示 `2 files` 且来源回跳不串；截图为 `tests/e2e/screenshots/alma-ux-real-multi-artifact.png`。
- `CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-real-error-summary.spec.ts`：1 条通过；验证真实 composer 发送后，deterministic local model 驱动真实 agent loop 调用真实 `Read` 读取缺失文件，工具失败默认压成 `Read 执行失败` 短摘要，完整 missing path 只在展开层可见；截图为 `tests/e2e/screenshots/alma-ux-real-error-summary.png`。
- `CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-real-image-upload.spec.ts`：1 条通过；验证真实 composer 加号菜单打开 file chooser、上传 PNG 后附件栏出现图片，再通过真实发送链路进入完成 turn 状态条，显示 `图片输入 1 张`；截图为 `tests/e2e/screenshots/alma-ux-real-image-upload-status.png`。
- `./scripts/rebuild-native-system.sh`：通过；为当前系统 Node 24 重建 `dist/native/better-sqlite3`，让 webServer 的 DB-backed ChannelAgentBridge 能在本地 E2E 中创建真实 channel session。
- `CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-real-channel-entry.spec.ts`：1 条通过；验证真实 HTTP API channel 账号创建、连接、`POST /api/message` 入站、deterministic local model 真实 agent loop、专用 `[Channel]` 会话回看和 `渠道 E2E HTTP API 真实入口` 状态条；截图为 `tests/e2e/screenshots/alma-ux-real-channel-entry.png`。
- `tests/e2e/playwright.e2e.config.ts` 已把 `HOME`、`CODE_AGENT_HOME`、`CODE_AGENT_DATA_DIR` 指向 `/tmp/code-agent-e2e-home-<port>`，并关闭 renderer hot update，避免 E2E 读写真实用户目录或加载旧 renderer bundle。
- `npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-visible.spec.ts -g "model setup gap clears after saving the provider key through settings UI"`：1 条历史通过；验证默认任务模型切到未配置 Claude 后，用户从 composer readiness 进入模型设置、手填 Provider key、点击保存，回到会话页 composer 缺口消失，重新打开设置页 readiness 也消失；截图为 `tests/e2e/screenshots/alma-ux-settings-ui-save-cleared.png`。本轮已把该 spec 改成更严格的即时刷新断言：保存后先要求设置页 readiness 立即消失，关闭设置后直接检查当前 composer，不再重新打开会话。
- `npx vitest run tests/renderer/hooks/useSessionLifecycleEffects.errorState.test.ts tests/renderer/hooks/useTurnProjection.test.ts tests/unit/renderer/turnErrorSummary.test.ts`：3 个文件、38 条测试通过；验证终端 provider 网络/Base URL 失败会生成可投影的 system error 节点，并在 turn error summary 中显示 `模型服务暂时不可用` 和 `检查网络、代理或自定义模型 Base URL 后重试。`
- `npx vitest run tests/renderer/components/turnErrorSummaryBanner.test.tsx`：1 个文件、2 条测试通过；验证 provider 终端失败在会话页 banner 默认折叠态只显示短摘要和恢复动作，不把 `ECONNREFUSED` 或本地 Base URL 原始错误塞进首屏 transcript。
- `npx vitest run tests/unit/ipc/settingsAccess.ipc.test.ts -t "allows non-admin model provider setup for onboarding"`：已有 IPC 单测覆盖桌面壳 `settings:set` 可写入模型 Provider 配置；本轮未把它升级为 Tauri 真机 UI 验收，避免把代码链路证据误当成桌面交互证据。
- `npx vitest run tests/unit/renderer/settingsRefresh.test.ts tests/unit/renderer/composerCapabilityGaps.test.ts tests/renderer/components/modelSettings.management.test.ts tests/renderer/components/settingsModal.screenMemory.test.ts`：4 个文件、42 条测试通过；验证 settings refresh 事件可被 renderer 监听，模型设置保存链路、composer/setup gap 计算和设置页分组仍稳定。
- `E2E_WEB_PORT=8213 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-real-provider-failure-api.spec.ts`：1 条通过；验证坏掉的 OpenAI-compatible Base URL 通过设置 API 写入后，经 `/api/run` 走真实 provider adapter，SSE 返回 `event: error`、`ECONNREFUSED 127.0.0.1:9` 和对应 session id；这条不启动浏览器，用来补足真实 adapter path 证据。
- `E2E_WEB_PORT=8216 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-real-channel-connect-failure-api.spec.ts`：1 条通过；验证真实 HTTP API channel 先成功绑定本地端口，再用第二个账号撞同端口得到 `EADDRINUSE`，`connect-account` 返回 `success: false`，账号状态持久化为 `error` 并保留 `errorMessage`，避免连接失败被误标为 connected。
- `npx vitest run tests/unit/renderer/channelSetupGap.test.ts`：1 个文件、6 条测试通过；验证真实连接失败原因会被投影成 composer/settings 的 `外部通道连接异常`，且详情里保留 `listen EADDRINUSE` 这类可排查线索。
- `npx vitest run tests/renderer/utils/workbenchCapabilityRegistry.test.ts tests/unit/renderer/composerCapabilityGaps.test.ts tests/unit/renderer/turnErrorSummary.test.ts tests/renderer/utils/workbenchQuickActions.test.ts`：4 个文件、36 条测试通过；验证 MCP bearer-token/invalid_token 错误会从 registry blocked reason 进入 composer/settings `MCP 授权失效` + `重新授权`，quick action 仍走重新授权而非普通重连，blocked turn 也归入 `mcp_auth` 错误摘要。
- `npx vitest run tests/unit/mcp/mcpToolRegistry.test.ts tests/integration/mcp/authFailureState.test.ts`：2 个文件、19 条测试通过；验证真实 stdio MCP 子进程返回 `isError: true` + `invalid_token` 后，主进程把错误写入 `ToolResult.error`，并把对应 server state 标成 `error`、保留授权错误文本。
- `npx vitest run tests/unit/agent/deferredToolPreload.test.ts tests/unit/model/e2eLocalAgentModel.test.ts tests/unit/mcp/mcpToolRegistry.test.ts tests/integration/mcp/authFailureState.test.ts`：4 个文件、42 条测试通过；验证 selected MCP server 会预加载对应 `mcp__<server>__<tool>`，deterministic local model 能调用真实 MCP auth failure tool，MCP `isError` 到 `ToolResult.error` 和 server state error 的链路保持一致。
- `npx vitest run tests/unit/tools/modules/mcp/mcpInvoke.test.ts tests/renderer/utils/workbenchCapabilityRegistry.test.ts tests/unit/renderer/composerCapabilityGaps.test.ts tests/unit/renderer/turnErrorSummary.test.ts`：4 个文件、45 条测试通过；验证 `mcp` 工具模块、workbench registry、composer/settings 缺口和 turn error summary 对 MCP 授权失败的表达仍一致。
- `npm run build:web`：通过；验证 web server bundle 已包含 selected MCP tool scope、CLI bootstrap 透传和 MCP auth smoke 相关改动。
- `npm run build:renderer`：通过；验证本轮 in-app Browser 手验使用的是最新 renderer bundle。
- 手动 built-server API smoke：`WEB_HOST=127.0.0.1 WEB_PORT=8218 CODE_AGENT_E2E=1 CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1 ... node dist/web/webServer.cjs` 后运行 `node /tmp/alma-mcp-auth-smoke.mjs` 通过；输出 `ok: true`、`tool: mcp__authfail__search`、`error: 401 Unauthorized: invalid_token bearer token expired`、`sseBytes: 41193`。这条验证 `/api/run` 能把 selected MCP server 转成真实 MCP tool call，SSE 带授权错误，且 MCP server state 保留短错误。
- 手动 in-app Browser UI smoke：`WEB_PORT=8220 CODE_AGENT_E2E=1 CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1 ... node dist/web/webServer.cjs` 后，通过本地 API 添加并启用 `authfail` stdio MCP fixture、用 settings API 修复默认模型 readiness，在真实会话页输入 `/mcp` 选择 `authfail` 并发送 `E2E_REAL_AGENT_MCP_AUTH_FAIL`；页面显示 `本轮使用 模型 gpt-5 · 带 1 项能力 / MCP authfail`，错误摘要显示 `MCP 授权失效 · mcp__authfail__search · 需要重新授权；也可以先禁用这个 MCP。`，工具行显示 `failed Called mcp__authfail__search`，MCP server state 回写 `error: 401 Unauthorized: invalid_token bearer token expired`；截图为 `tests/e2e/screenshots/alma-ux-real-mcp-auth-failure-inapp.png`。
- in-app Browser provider UI smoke：`WEB_PORT=8232 CODE_AGENT_E2E=1 ... node dist/web/webServer.cjs` 在 `/tmp/alma-provider-browser-*` 隔离 home/data/workspace 下启动后，用 settings API 写入 `baseUrl: http://127.0.0.1:9/v1` 的 OpenAI-compatible provider，从真实会话页发送 `ALMA_UX_REAL_PROVIDER_FAILURE_IAB_20260614`；页面默认折叠态显示 `本轮需要处理 1 个问题需要处理` 和 `模型服务暂时不可用 · 检查网络、代理或自定义模型 Base URL 后重试。`，未泄露 `127.0.0.1:9` 或 `ECONNREFUSED`；展开后详情仍显示 `Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9`。截图为 `tests/e2e/screenshots/alma-ux-real-provider-failure-inapp.png`。这条证明 provider 失败已经和 MCP/tool fail 进入同一套 `TurnErrorSummaryBanner`，且可通过隔离 webServer + in-app Browser 重跑。
- Tauri/desktop settings UI smoke：在 `/tmp/alma-tauri-settings-data` 和 `/tmp/alma-tauri-settings-workspace` 下启动 `CODE_AGENT_E2E=1 node dist/web/webServer.cjs`，再用 `cargo tauri dev --no-dev-server-wait --config '{"build":{"beforeDevCommand":""},"bundle":{"resources":[]}}'` 启动真实 Tauri dev 壳；Tauri 日志显示 `Web server already running on http://localhost:8180, skipping spawn`。在 in-app Browser 打开同一 `http://localhost:8180`，用 settings API 临时切到无 key 的 `qwen/qwen-plus`，会话页出现 `Model qwen-plus` 缺口；点击 `去设置修复` 进入模型设置，手填 key 并保存后，settings readiness 从 2 项降为只剩 `Voice`，关闭设置后 composer banner 也只剩 `Voice`，不再包含 `Model qwen-plus` 或默认 Provider 未配置文案。截图为 `tests/e2e/screenshots/alma-ux-tauri-settings-readiness-cleared.png`。
- 真实语音服务 smoke：下载公开 wav 样本 `OSR_us_000_0010_8k.wav` 到 `/tmp/alma-open-speech-sample.wav`，通过当前 app-host 的 `POST /api/speech/transcribe` 发送 `{ audioData, mimeType: "audio/wav" }`，返回 `success: true`，转写内容以 `the birch canoe slid on the smooth planks...` 开头。这条验证现有产品语音转写入口能接收真实音频并产出 transcript；它仍走当前实现的 Groq Whisper 路径。
- Mimo ASR smoke：通过 `POST /api/domain/provider/discover_models` 用已配置 Xiaomi key 发现 `mimo-v2.5-asr`、`mimo-v2.5-tts` 等声音模型，并用 `provider/test_connection` 验证 `mimo-v2.5-asr` 连接成功；随后调用 `https://token-plan-sgp.xiaomimimo.com/v1/chat/completions`，模型 `mimo-v2.5-asr`，消息只包含 `input_audio.data: data:audio/wav;base64,...`，同一 wav 返回英文 transcript，usage 里包含 `prompt_tokens_details.audio_tokens: 211`。这条证明爸提到的 Mimo key 确实可用于 ASR，后续可把 Neo 的 speech provider 从硬编码 Groq 抽成可配置的 Xiaomi/Mimo ASR 路径。
- 语音 UI 权限边界：in-app Browser 当前页面文案显示 `Voice 语音输入`、`麦克风权限未开启`、`浏览器当前拒绝麦克风访问，语音输入按钮无法开始录音。`；read-only Browser eval 也显示页面正文包含拒绝麦克风文案。当前环境因此不能把“点击麦克风录制并发送”作为自动化通过证据，后续需要在系统/浏览器麦克风权限恢复后补 UI 录音截图。
- `npm run typecheck`：通过；验证本轮 MCP 授权表达、HTTP API channel 连接边界和既有 Alma UX 类型契约一致。
- `E2E_WEB_PORT=8212 npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/alma-ux-real-provider-failure.spec.ts`：未通过，阻塞在本轮执行环境，不是产品断言。沙箱内 Chromium 启动失败，错误为 `bootstrap_check_in ... Permission denied (1100)`；尝试非沙箱重跑时被系统额度限制拒绝。该 spec 已新增，但不能记为通过证据，也没有截图。
- `E2E_WEB_PORT=8214 npx playwright test --config tests/e2e/playwright.system-chrome.config.ts tests/e2e/alma-ux-real-provider-failure.spec.ts`：未通过，仍阻塞在浏览器启动层，不是产品断言。Playwright 通过 system Chrome channel 启动 `/Applications/Google Chrome.app/...` 后进程被 `SIGKILL`，非沙箱重跑也同样失败，并出现 `kill EPERM`。
- `npm_config_cache=/tmp/code-agent-npm-cache npx tsx scripts/acceptance/browser-computer-system-chrome-smoke.ts`：未通过，仍阻塞在浏览器启动层，不是产品断言。system Chrome CDP helper 等待 `127.0.0.1:<port>` 超时，沙箱和非沙箱结果一致；说明本轮环境无法补浏览器 UI 截图，API/SSE 证据仍有效。
- `npx playwright test --config tests/e2e/playwright.system-chrome.config.ts tests/e2e/alma-ux-visible.spec.ts -g "model setup gap clears after saving the provider key through settings UI"`：未通过，阻塞在 Chrome 启动层，不是产品断言。该 spec 自己成功启动了 `dist/web/webServer.cjs`，但 Playwright 启动 `/Applications/Google Chrome.app/... --headless --remote-debugging-pipe` 后 180 秒超时；因此本轮不能把“模型设置保存后即时清除 composer readiness”记为 UI 自动化通过证据。`playwright.e2e.config.ts` 版本也未进入断言，先卡在 webServer 前置 `npm run build:web` 的 `npx tsx` 临时安装/构建层。

### 下一步实施顺序

1. 补麦克风权限恢复后的 UI 录音截图：语音录音失败后的权限刷新事件已有单测覆盖，真实 wav -> transcript 和 Mimo ASR 已补服务级证据；后续只差系统/浏览器允许麦克风后，从会话页点击录音、转写并发送的产品截图。
2. 做截图对比：同一长工具任务对比改造前后首屏噪音、错误可读性、artifact 归属和状态密度。Telegram/Feishu 真实账号入口、Playwright provider UI 自动化和更多复杂任务截图保留为后续风险，不作为当前 goal 完成门槛。

## P0 借鉴建议

1. 做“本轮任务状态条”

   这条最能提升会话页信任。把模型策略、selected skills、selected MCP/connectors、context usage、hook 状态、fallback/finish reason 合成一行可扫读状态，展开后看细节。重点是显示人能读懂的名称和状态，不显示裸 ID。

   设计口径：发送前叫“将使用”，发送后叫“本轮使用”。失败时同一位置改成短错误和下一步动作，不另开一堆提示。

2. 统一 slash 和能力发现

   `/` 应该成为任务能力入口，覆盖 commands、prompts、installed skills、MCP server/tool、plugin command、workbench preset。Neo 现在能力面已经够多，继续分入口会让用户先做分类题。Alma 的 `PromptsPicker` 值得直接借鉴为“一个搜索框，多类结果，结果带状态和来源”。

   设计口径：用户输入 `/lark`、`/image`、`/deploy` 时，看到的是可执行任务能力，而不只是命令名。

3. 把 artifact 归属放进 transcript

   Neo 的 preview/workspace 能力更重，但会话页要补“这个产物来自哪里”。每个 artifact 在回答正文或消息底部有 inline card/chip，点击打开对应 panel；panel 里也能回跳到来源 turn。Alma 的 `TextWithArtifacts` + `ArtifactIndicator` 是这点的直接证据。

   设计口径：产物要成为本轮回答的一部分，不能只是侧栏里的孤立对象。

4. 错误短摘要和恢复动作统一

   把 provider fallback、MCP 连接失败、tool auth 失败、长输出截断、channel 发送失败都映射成短摘要：发生了什么、影响什么、用户下一步能做什么。完整错误进展开层或 trace。Alma 的 trace/fallback 字段和 clean transcript 方向说明它在减少“终端噪音”。

   设计口径：默认给用户判断，不把原始堆栈丢到聊天流正中间。

5. New Chat、语音、图片、外部渠道使用同一套会话解释

   新会话、语音转写、图片输入、Telegram/Feishu 等外部渠道都应进入同一 ConversationEnvelope，并在桌面端显示相同的本轮状态条、artifact 归属和错误摘要。这个 P0 的价值在连续性：用户不需要因为入口变了就重新学习系统。

   设计口径：输入渠道不同，任务语义和交付视图相同。

## P1 借鉴建议

- 设置页增加任务导向 setup banner：缺 provider、缺 MCP auth、缺 voice permission、缺 channel token 时，不只提示配置缺失，还说明会影响哪类任务，并提供回到会话页的推荐动作。
- 模型设置改成“任务模型”表达：弱化 provider 仓库感，强化“主任务模型、快速模型、长上下文模型、图像/语音模型”的场景标签。
- hook/trace 做一层产品化 inspector：从本轮状态条进入，默认显示关键步骤、耗时、fallback、finish reason；调试细节留给高级展开。
- clean transcript export：导出的会话默认去掉 terminal clutter，只保留用户输入、模型判断、关键工具摘要、产物链接和错误短摘要。
- 图片和 gallery placeholder 标准化：上传、生成、分享、preview 都显示一致的占位、失败、来源状态，避免大图或 base64 路径拖慢会话页。
- 可靠性回归场景产品化：长回复、长工具输出、大图、多 artifact、channel streaming、语音转写中断都要有截图/录屏基线。

## 验收方式

### 产品走查

- 从空设置开始：provider 未配置、MCP 未授权、voice permission 未开、channel token 缺失。检查设置页是否能把缺口转成任务导向提示，并在会话页显示对应状态。
- 修复关键设置后回到会话页：provider、MCP、voice permission、channel token 任一缺口被修复后，检查 composer 提示是否消失或降级，设置页 readiness 是否同步更新。
- 从 New Chat 发起任务：输入 `/` 搜索 skill、prompt、MCP、plugin command，确认用户不需要知道能力分类。
- 发起带 skill/MCP/artifact 的任务：检查发送前状态、执行中状态、完成后状态是否连续，且不用读裸 ID。
- 生成 artifact：检查聊天正文 inline card、右侧 preview/panel、来源 turn 三者是否能互相定位。
- 模拟失败：provider fallback、MCP auth fail、tool fail、长输出截断都只在聊天流默认显示短摘要。

### E2E

- slash 搜索 E2E：New Chat 和已有会话输入 `/`，断言 commands、prompts、skills、MCP/connector 结果同时出现，选择后写入 composer context；当前已覆盖 New Chat skill 和已有会话 MCP/connector 选择。
- workbench metadata E2E：选择 skill/MCP/connector 后发送，断言 user message metadata、assistant turn summary、trace projection 使用同一组可读 label；当前已覆盖真实发送链路里的 slash-selected Skill/MCP/Connector，并覆盖未挂载 skill、待授权 connector 在完成 turn 里显示为未生效。
- settings readiness E2E：从无模型 key 的配置进入 composer 缺口和 settings readiness，再写入可用默认模型配置，断言回到会话页后 composer 缺口消失，重新打开设置页也不再显示 readiness；对 channel account，创建启用但断开的账号后断言 composer/settings 缺口出现，禁用后两处缺口消失；当前已覆盖 web API 修复路径、Web/app-host 设置 UI 手填 Provider key 保存路径、Tauri/桌面壳 dev 壳连接 app-host 后设置 UI 保存 key 并即时清除 Model 缺口、MCP auth fail 的重新授权表达、真实 MCP 进程授权失败的 API/SSE 回写、in-app Browser 真实 MCP 授权失败 UI 截图、channel 禁用回流、voice setup refresh 事件、真实语音服务转写，以及真实 HTTP API channel 端口绑定失败回写 account error，后续补系统麦克风权限恢复后的 UI 录音截图和 Telegram/Feishu 凭证连接恢复路径。
- artifact ownership E2E：让 agent 生成一个或多个 artifact，断言 transcript inline card 与 WorkspacePreviewPanel 指向同一 artifact id，且多 artifact 切换时来源回跳不串；当前已覆盖注入式多 artifact 和真实 agent loop 两次 `Write` 的多产物路径。
- fallback/error E2E：模拟 provider 不可用、MCP auth 失败或 channel send 失败，断言 FallbackBanner/错误摘要出现，完整错误在展开层；当前已有注入式混合失败 smoke、真实 agent loop `Read` 失败 smoke、真实 provider 配置失败 API/SSE smoke、真实 selected MCP server 到 stdio MCP `invalid_token` 的 API/SSE smoke、in-app Browser 真实 MCP 授权失败 UI 截图、隔离 webServer + in-app Browser 重跑真实 provider 失败统一错误摘要截图、blocked MCP auth fail 单测，以及真实 HTTP API channel 同端口绑定失败 API smoke。浏览器 UI 版 provider failure spec 本轮因浏览器启动层不可用未跑通，已分别试过 Playwright bundled Chromium、Playwright system Chrome channel 和 system Chrome CDP helper；Playwright 自动化保留为后续质量项，不再阻塞当前目标收口。
- channel continuity E2E：从外部渠道入口发一条任务，回到桌面会话后能看到 channel source、同一 envelope、同一 artifact/trace 表达；当前已覆盖本地 HTTP API channel 的真实账号创建、连接、入站、专用会话回看和同端口绑定失败，并补了 Feishu/Telegram metadata 与状态条类型级单测，后续补 Telegram/Feishu 真实账号入口。
- voice/image E2E：语音转写和图片输入触发任务后，断言 attachment/transcript/status summary 不丢失；当前已覆盖可控注入式 `message` 事件进入真实会话页状态条、真实 composer 图片上传到完成 turn 状态条、真实 wav 进入产品 `/api/speech/transcribe` 返回 transcript，以及 Mimo `mimo-v2.5-asr` 对同一 wav 返回 transcript 和 `audio_tokens`；后续补麦克风权限恢复后的点击录音 UI 截图。

### 用户测试和截图对比

- 会话页密度对比：同一长工具任务，比较改造前后的首屏噪音、用户是否能 5 秒内说出“系统在干什么”。
- 错误理解测试：给用户看失败 turn，观察是否能不展开详情就判断下一步。
- 产物扫读测试：给用户看含多个 artifact 的会话，观察是否能快速找到来源、预览、复制或下载。
- 设置到会话的理解测试：用户在设置页完成 provider/MCP/voice/channel 配置后，回到会话页是否知道这些能力已经可用。

## 不建议直接照搬的点

- 不应把 Neo 简化成 Alma 的轻量版。Neo 的 workspace、review、eval、browser、channels 和 project 维度更重，应该保留，但要把它们压成更清楚的会话层表达。
- 不应继续新增孤立入口。当前更重要的是把 settings、composer、trace、preview、channels 之间的状态打通。
- 不应把所有 trace 都默认展示。用户需要的是短判断和可展开证据，工程日志应当退到二级层。
- 不应只改设置页 IA。设置页的价值必须回到会话页：推荐、默认值、状态、错误恢复和产物交付都要在任务路径里出现。
