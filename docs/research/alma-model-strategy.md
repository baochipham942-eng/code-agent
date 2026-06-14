# Alma Model Strategy 对标研究

日期：2026-06-13

范围：研究 Alma 0.0.805 到 0.0.823 的 Model 线索，以及 code-agent 当前 model/provider/router/fallback/billing/modelDecision/session UI 的差距。本文主体是研究和方案，分支推进状态单列记录。

## 核心结论

Alma 对 Model 的思路已经从“选一个聊天模型”推进到“为当前任务选择执行策略”。`main task model` 这个词的价值在于：模型承担的是任务交付质量、速度、成本、工具可用性和失败恢复，不只是聊天身份。0.0.807 的命名变化、0.0.811 到 0.0.813 的 Claude subscription/CLI 链路修复、0.0.812 的跨 provider programmatic tool calling、0.0.809/0.0.810 的 provider icon/favorite，都在把模型选择从静态配置推向可解释的任务执行系统。

code-agent 已经有不少底座：`resolveModelDecision()` 是单一路由决策入口，`ModelDecision` 带 requested/resolved/reason/billingMode，`model_decision` 事件会进入 assistant message，`RouteTraceChip` 和 `FallbackBanner` 会在会话页露出一部分结果。短板在表达层：用户看到的是“模型配置”和“路由 chip”，还不能清楚知道这一轮为什么用了这个模型、是否因为成本/速度/能力被推荐或跳过、fallback 链如何决策、provider 当前是否健康，以及工具能力会不会影响交付质量。

最值得借鉴 Alma 的方向是：把会话页里的模型能力表达升级为“任务级模型策略”。优先级不应先做更多 provider 表单，而应把已存在的 modelDecision / billing / health / fallback / tool capability 汇成一个用户看得懂的决策面板。

## 本分支推进状态

已落地：

- P0-1 第二版：`ModelDecision` 增加 `taskClass`、`complexityScore`、`costPolicy`、`speedPolicy`、`toolPolicy`、`capabilityNeeds`、`strategySummary`、`providerHealthSnapshot`；`resolveModelDecision()` 填充可确定字段和 resolved provider 的健康窗口；`RouteTraceChip` 支持展开查看任务、成本、速度、能力、provider 状态和 requested/resolved 模型。
- P0-1 第三版：`ModelFallbackInfo` / `ModelFallbackTraceStep` 增加 tried、skipped、selected、exhausted 轨迹；legacy router provider fallback 会记录 primary 失败、不可用或缺 key 的 skipped 候选、失败候选、最终 selected 候选和全链路耗尽；AI SDK adaptive 免费候选失败后回主任务模型也会带 selected/exhausted trace；`contextAssembly.inference` 会把成功 fallback 或 exhausted 错误写成当前 turn 的 `model_fallback` notice；`FallbackBanner` 展示已尝试、已跳过、已选用、已耗尽；`ProviderStatusNotice` 按 timeout/quota/auth/network 等分类展示原因，不再把所有 fallback 都说成超时。
- P0-1 第四版：`ModelSpeedPolicy` 从 `fast-path/normal` 扩到 `provider-degraded/fallback-recovery`；`resolveModelDecision()` 会按 resolved provider 的健康窗口标记 provider 状态风险，fallback 决策会标记恢复路径；`RouteTraceChip` 展开层直接显示“provider 状态风险”或“fallback 恢复”。
- P0-1 第五版：`RouteTraceChip` 的 provider 状态行显示 `providerHealthSnapshot.sampledAt` 的采样年龄，例如“采样 2 分钟前”，避免把 provider health 窗口统计误读成实时 SLA。
- P0-1 第六版：provider fallback 成功后，最终 assistant message 上的 `modelDecision` 会对齐 `response.actualProvider/actualModel` 和 `response.fallback`；`RouteTraceChip` 展示 fallback 后真正执行的 provider/model、`fallback-availability` reason、`fallbackFrom` 和 `fallback-recovery` 速度策略，避免 RouteTrace 与 FallbackBanner 说法不一致。
- P0-1 第七版：capability fallback 成功后也会把 `pendingCapabilityFallback` 挂回最终 response；消息级 `modelDecision` 会展示原主任务模型到能力模型的切换，例如 `mock/text-only -> zhipu/glm-4.5v`，reason 使用 `capability-vision`，summary 说明原模型缺少 vision 能力，而不是误说 provider 不可用。同一轮 capability fallback 只发一次 `model_fallback` notice，最终消息复用同一份 fallback 元数据做解释。
- P0-1 第八版：`FallbackBanner` 增加直接组件契约测试，覆盖 tried/skipped/selected/exhausted fallback trace、工具关闭数量和 disabled tool 预览，避免只靠 TraceNodeRenderer 间接证明 fallback 细节可见。
- P0-1 第九版：`RouteTraceChip` 增加 billing gate renderer 契约测试，覆盖 `billingMode=plan` 的“套餐内不切换”和 `billingMode=unknown` 的“计费未知保守”；会话页不只在 runtime 层知道 plan/unknown 不省钱，也能在展开层解释为什么沿用主任务模型。
- P0-1 第十版：`useTurnProjection` 的 model decision 去重键从单纯 reason/provider/model 扩到 strategy、billing/cost/speed、provider health、toolStrategy 和 externalEngine failure 指纹；连续完全相同的 chip 仍会去重，但同一路由下新增的订阅链路失败、计费策略或工具计量不会被投影层压掉。
- P0-1 第十一版：`ModelFallbackInfo` 增加 `strategy`，区分 `adaptive-provider-fallback`、`adaptive-capability-fallback`、`adaptive-main-task-recovery`；主进程 fallback、stream normalizer、IPC event 和 `FallbackBanner` 都保留该字段。会话页 banner 会显示“自动策略恢复 / 能力自动切换 / 回到主任务模型”，用户能看出系统是在自动策略边界内恢复，而不是越过显式模型选择。
- P0-1 第十二版：`RouteTraceChip` 展开层新增独立“计费”行，直接显示 payg/plan/free/unknown 的计费语义；成本策略继续说明本轮为什么省成本或保守跳过，避免用户把 `costPolicy` 误读成真实账单状态。
- P0-1 第十三版：`ProviderStatusNotice` 的即时 fallback toast 消费同一份 `strategy`，带策略时显示“自动策略恢复 / 能力自动切换 / 回到主任务模型”，无策略的旧事件保持原文案。这样消息内 banner 和即时 notice 不会对同一次模型恢复给出两套粒度。
- P0-1 第十四版：`ModelDecision` 增加 `providerIdentity`，记录 resolved provider 的 displayName/sourceLabel/protocol/transportLabel/endpoint；`resolveModelDecision()`、fallback 后消息级决策、renderer stream normalizer、`useTurnProjection` 去重 key 和 `RouteTraceChip` 展开层都保留该字段。用户不用只靠模型菜单，就能在本轮消息里看到自定义 relay 或 endpoint 链路身份。
- P0-1 第十五版：`model_fallback` notice 增加 `fromIdentity/toIdentity`，复用 `ModelProviderIdentity` 表达 source/protocol/endpoint；主进程 emit、renderer normalizer、notice parser 和 `FallbackBanner` 都保留身份信息。用户看到 fallback banner 时，不必等最终 `RouteTraceChip` 才知道系统切到了哪条 provider/relay 链路。
- P0-1 第十六版：`RouteTraceChip` 展开层的复杂度分增加口径说明，明确它是本轮路由解释用的规则估计，不是模型质量评分；`acceptance:model-strategy-summary` 也把这条 renderer 契约纳入本地验收汇总。
- P0-1 第十七版：`RouteTraceChip` 的 provider 状态行增加“最近窗口”和“非实时 SLA”口径，避免用户把 health snapshot 当成实时可用性承诺；`acceptance:model-strategy-summary` 纳入 provider health boundary 检查。
- P0-1 第十八版：新增 `acceptance:model-strategy-fallback`，直接渲染真实 `FallbackBanner` 并调用真实 `ProviderStatusNotice` toast formatter，验证 capability fallback 的策略标签、from/to provider identity、tried/skipped/selected trace、工具关闭提示、exhausted provider fallback 和 main-task recovery toast 都可见。`acceptance:model-strategy-summary` 已把这条 fallback visibility contract 纳入总验收。
- P0-1 第十九版：新增 `acceptance:model-strategy-surface`，直接渲染真实 `RouteTraceChip` 和 `ModelSwitcher` provider badges，验证 payg/plan/unknown billing 语义、provider source/protocol/endpoint identity、provider health/source/transport badge 和主任务模型 tooltip 都可见。`acceptance:model-strategy-summary` 已把 surface billing/identity contract 纳入总验收。
- P0-2 第一版：`ModelSwitcher` 和 `ModelSettings` 的用户可见文案从“默认模型”统一为“主任务模型”，自动模式说明改为按任务、成本和能力切换。
- P0-2 第二版：主聊天发送门禁和首次模型 onboarding 保存状态也统一为“主任务模型”文案；新增源码契约测试守住 `ChatView` 和 `ModelOnboardingModal`，避免用户入口回退成“默认模型”心智。
- P0-2 第三版：`ModelSwitcher` trigger tooltip 改为任务策略摘要。Native 自动模式会显示主任务模型、Engine、计费、Provider 状态、Effort 和 Thinking；显式 override 会保留原主任务模型；外部 engine 会显示引擎模型、Effort 和可靠性状态，避免 hover 入口只剩模型名。
- P0-2 第四版：设置页模型区在“设为主任务”按钮附近补主任务模型策略提示，明确复杂/长上下文任务适合能力更强模型，日常小任务避免长期锁定慢模型或按量昂贵模型，自动模式按任务、成本、速度和能力尝试切换。
- P0-3 第一版：`ModelSwitcher` 对外部 Agent Engine 增加可靠性状态卡，复用 descriptor/catalog 的 install/runtime/lastError/model disabled/capabilities，展示 missing、not configured、model limited、ready 等状态。
- P0-3 第二版：`AgentEngineDescriptor` 增加 `reliability` 链路状态，Claude Code descriptor 明确 CLI 可用性、auth/quota 未探测、stream-json、partial messages、clean transcript、只读工具和 MCP bridge 状态；Claude Code adapter 的 command summary 补齐 `--input-format text`、`--strict-mcp-config`、`--include-partial-messages`、`--no-session-persistence`，并补测试证明 partial stream-json 重组不会重复 snapshot，也不会把 terminal/footer 噪声写进最终 assistant transcript。
- P0-3 第三版：本机 live smoke 已确认 `claude` CLI 存在且版本为 `2.1.177 (Claude Code)`，最小 `stream-json` 调用能输出 init/status/api_retry/result 事件；但当前环境返回 401 `authentication_failed`，因此真实订阅端到端未通过。adapter 已补强失败归因，`result.is_error` 且 stderr 为空时会把 CLI 返回的认证错误作为用户可见失败原因。
- P0-3 第四版：Claude Code / Codex CLI 成功返回的 assistant message 会写入 `modelDecision.externalEngine`；`RouteTraceChip` 展开层展示外部引擎 runtime、CLI、auth、quota、stream、tool support、transcript 和版本。外部订阅模型链路不再只在模型菜单里可见，也进入本轮消息级策略解释。
- P0-3 第五版：外部 engine 失败路径增加 `AgentEngineFailureDiagnostics`，把 auth、quota、timeout、network、permission、missing_cli、runtime 失败稳定归类；Claude 401 会进入 `auth_failed`，Codex quota/rate-limit 会进入 quota 分类，并写入 run result、ledger failed event、notification payload 和 error details。
- P0-3 第六版：Claude Code / Codex CLI 失败时也会写入一条 assistant 诊断消息，消息携带 `modelDecision.externalEngine.failure`；`RouteTraceChip` 展开层能看到失败分类、是否可重试和建议。这样认证失败、quota 耗尽这类订阅链路问题会直接出现在会话页，而不是只留在后台任务或通知里。
- P0-3 第七版：`ChatInput` 的模型策略提示覆盖外部 engine 边界：Claude Code / Codex CLI 收到图片附件时提示当前 CLI 通道只接收文本；代码/产物落地型任务走外部 engine 时提示当前是只读 CLI 链路，建议需要写文件时切回 Native 主任务模型。
- P0-3 第八版：`AgentEngineSessionMetadata` 保存最近一次外部 engine failure；Claude Code / Codex CLI 失败会把 auth/quota/timeout 等诊断写回 `session.engine.failure`，`ModelSwitcher` 可靠性卡片优先展示最近失败，让用户在下一轮发送前知道订阅/CLI 链路是否刚刚卡在登录、额度或运行状态。
- P0-3 第九版：`AgentEngineFailureDiagnostics` 增加 `occurredAt`；Claude Code / Codex CLI 用本轮 completedAt 记录失败发生时间，`ModelSwitcher` 可靠性卡片和 `RouteTraceChip` 失败行显示“刚刚失败 / 2 分钟前失败”等年龄，避免用户把陈旧的登录或 quota 失败误判为当前轮状态。
- P0-3 第十版：`ChatInput` 会读取当前 session 的 `engine.failure`；外部 engine 有最近 auth/quota/timeout 等失败时，Composer 发送前模型策略提示优先展示失败类型、发生时间和恢复建议，用户不必先打开 ModelSwitcher 才知道订阅/CLI 链路不可用。
- P0-3 第十一版：外部 engine 最近失败如果不可重试，Composer 推荐条提供“切回 Native”动作，复用现有 `updateSessionEngine` 选择链路并清掉当前 model override；timeout/network 这类可重试失败只提示，不自动引导切换。
- P0-3 第十二版：`switch-native-engine` 动作的 engine selection payload 抽成 `buildModelStrategyEngineSelectionRequest()`，helper 单测保证它生成 `{ kind: 'native', permissionProfile: 'default' }`，不混用普通 provider/model `switchModel` payload。
- P0-3 第十三版：`sessionStore.updateSessionEngine()` 增加 native 恢复回归测试，覆盖带 auth failure 的 Claude Code session 切回 Native 后，store 中的 engine 回到 native 且不再保留旧 `failure`，避免 Composer 继续显示陈旧失败。
- P0-3 第十四版：Composer “采用建议”动作抽成 `applyModelStrategyRecommendationAction()`，不可重试 external engine failure 会调用 `updateSessionEngine(native)`、清空 model override、dismiss 当前推荐，并有 helper 级回归测试覆盖。
- P0-3 第十五版：Composer 模型策略推荐条抽成 `ModelStrategyRecommendationStrip`，warning/info 样式、失败因素标签、“切回 Native”和“保持当前”渲染有组件级静态测试，外部 engine failure 不再只停在数据 helper 层。
- P0-3 第十六版：`RouteTraceChip` 的 external engine 失败行展示 HTTP status 和 CLI exit code，例如 `auth · auth_failed · 2 分钟前失败 · HTTP 401 · exit 1 · 需处理`，消息级 trace 与模型菜单可靠性摘要对齐。
- P0-3 第十七版：新增 `acceptance:claude-subscription-cli` 手动门控 smoke。`--dry-run` 会打印实际 `claude -p --output-format stream-json --input-format text ...` 命令和 guardrails；`--probe-only` 只检测 CLI 版本；真实订阅请求必须同时传 `--manual-claude` 和 `CODE_AGENT_CLAUDE_CLI_SMOKE=1`，避免把真实账号请求变成默认 CI 行为。
- P0-3 第十八版：Claude Code adapter 与手动门控 smoke 都会读取 stream-json result 里的 `api_error_status`，并把结构化 HTTP status 传入 failure diagnostics；即使错误文案里没有 `401/429` 字样，会话页 RouteTrace 和 smoke 结果也能稳定显示认证/额度类失败。
- P0-3 第十九版：renderer stream normalizer 会保留 `modelDecision.externalEngine`，并对白名单内的 engine kind、install/runtime 状态、capabilities、reliability 和 failure diagnostics 做结构化解析；主进程发出的 CLI/auth/quota/stream/transcript/HTTP status 不会在进入 assistant message 时被丢掉。
- P0-3 第二十版：`ModelSwitcher` 的 external engine reliability 摘要补齐 auth/quota 状态；模型菜单和消息级 `RouteTraceChip` 都能看到 CLI、登录态、额度态、stream、transcript 和工具支持，不再只在失败后才暴露登录或额度信息。
- P0-3 第二十一版：`TraceNodeRenderer` 遇到 `modelDecision.externalEngine.failure` 时会让 `RouteTraceChip` 默认展开。认证、quota、runtime 等外部引擎失败的 HTTP status、CLI exit code、失败年龄和恢复建议会直接出现在本轮 assistant 诊断消息里，不再要求用户先点开策略 chip。
- P0-3 第二十二版：当前分支重新跑过 `npm run acceptance:claude-subscription-cli -- --dry-run --json` 和 `--probe-only --json`。dry-run 确认真实请求命令仍是 `claude -p --verbose --output-format stream-json --input-format text --permission-mode plan --setting-sources local --disable-slash-commands --tools Read,Glob,Grep,LS --allowedTools Read,Glob,Grep,LS --strict-mcp-config --include-partial-messages --no-session-persistence`，且真实请求仍需 `--manual-claude` 与 `CODE_AGENT_CLAUDE_CLI_SMOKE=1`；probe-only 确认本机 Claude Code CLI 版本为 `2.1.177 (Claude Code)`。
- P0-3 第二十三版：`acceptance:claude-subscription-cli` 的 dry-run/probe JSON 增加结构化 `contract`，明确 requestMode=`claude-print`、transport=`stdin-text`、stream-json + partial messages、plan permission、local settings、slash commands disabled、只读 `Read/Glob/Grep/LS`、strict MCP config、clean result transcript、no session persistence；同一契约也列出离线覆盖项和仍需人工 live gate 的登录账号、quota、长回复 live 请求、MCP bridge tool execution。
- P0-3 第二十四版：`acceptance:claude-subscription-cli` 增加 `--replay-fixture` 离线回放入口和 `tests/fixtures/claude-subscription-long-response-stream.ndjson`。fixture 覆盖长回复被拆成多个 `stream_event:content_block_delta`、存在 assistant snapshot、result 事件不带最终文本、stdout 混入 terminal footer / tokens used 噪声的情况；回放会验证 partial 合并、snapshot 不重复、terminal 噪声不进入 final transcript，并把这些检查作为结构化 replay evidence 输出。
- P0-3 第二十五版：Claude subscription smoke 的 stream-json parser 增加 `stream_event.content_block_start` 里的 `tool_use`、`user.message.content[].tool_result` 和 MCP-style `mcp__...` 工具名识别；`--replay-fixture` 增加 `--expect-mcp-bridge`，并新增 `tests/fixtures/claude-subscription-mcp-tool-stream.ndjson`。这能离线证明 MCP-style 工具事件会被观察到、tool_result / terminal 噪声不会进入最终 transcript，但仍不替代真实 Claude 订阅账号里的 live MCP bridge tool execution。
- P0-3 第二十六版：`acceptance:claude-subscription-cli` 的 npm script 从临时 `npx tsx` 改为本地 `jiti` runner，避免 smoke 验收卡在 npx 下载或 cache lock；`--dry-run`、`--probe-only` 和 MCP fixture replay 都已通过 npm script 快速返回，并新增测试守住该 script 不再依赖 npx。
- P0-3 第二十七版：当前分支已显式运行真实最小 Claude subscription smoke：`CODE_AGENT_CLAUDE_CLI_SMOKE=1 npm run acceptance:claude-subscription-cli -- --manual-claude --json`。结果为 `status=blocked`，Claude CLI 版本 `2.1.177 (Claude Code)`，stream-json 观察到 `init=1 / assistantSnapshot=1 / result=1`，CLI 返回 `401 Invalid authentication credentials`，被稳定归类为 `auth/auth_failed`、`authState=needs_login`、`retryable=false`，并保留恢复建议。也就是说真实请求链路已触达 Claude CLI 和 stream-json 结果层，但当前账号认证未通过；quota、真实长回复和 live MCP bridge 仍未被通过态证明。
- P0-3 第二十八版：按当前验收口径新增 `acceptance:codex-cli-engine`，用 `codex exec --json --sandbox read-only --output-last-message` 验证外部 CLI engine 链路。当前本机真实运行通过，Codex CLI 版本 `0.139.0`，最终消息为 `CODEX_MODEL_STRATEGY_OK`，并收到 `turn.completed` usage；因此订阅/外部引擎这条线不再把 Claude 账号登录作为当前目标阻断，Claude smoke 保留为 Alma subscription 对标证据。
- P1-1 第一版：`ChatInput` 增加发送前模型策略建议条。简单任务可一键采用自动模式；图片、长上下文、代码/产物/联网检索任务会在当前主任务模型能力不足时提示风险，并允许用户保持当前选择。
- P1-1 第二版：发送前策略建议接入 provider health；当前 Native 主任务模型所在 provider 降级或不可用时，会提示本轮可能变慢或触发 fallback，并在未开启自动模式时提供“采用自动”动作。
- P1-1 第三版：发送前策略建议可从已配置 runtime models 中选择候选；当图片、长上下文、工具任务缺能力，或当前 provider 降级/不可用且存在 healthy/recovering 候选时，“采用建议”会直接切到对应 provider/model，而不是只进入自动模式。
- P1-1 第四版：采用建议的 `switchModel` request body 抽成可测试契约；`switch-model` 建议会发目标 provider/model 且 `adaptive=false`，`enable-auto` 建议会保留当前主任务模型并设置 `adaptive=true`。
- P1-1 第五版：`ModelDomainCapability` 增加 `search`；联网、搜索、最新信息类任务会优先推荐 search-capable 主任务模型，例如 Perplexity/Sonar；`CapabilityRecommender` 也能把 `web_search/search/browse` 错误映射为 search capability gap。
- P1-1 第六版：发送前策略建议接入当前 provider 的 `billingMode` 和模型速度倾向；简单任务在按量计费且当前主任务模型偏重时会提示慢/贵风险并建议自动策略，套餐/免费/未知计费不再假装能靠自动策略省钱，有健康快模型候选时才建议切换。
- P1-1 第七版：`ModelStrategyRecommendation` 增加 `strategyFactors`，Composer 推荐条会展示“任务 / 需要能力 / 计费 / 速度 / 候选 / provider 状态”等短标签，让用户在采用建议前看到推荐依据，而不是只读一段 body 文案。
- P1-1 第八版：任务级推荐覆盖外部 engine 最近失败；如果当前 Claude Code / Codex CLI session 存在 failure，推荐条优先解释失败原因和是否可重试，而不是继续按普通文本 prompt 隐身放行。
- P1-1 第九版：推荐动作扩展 `switch-native-engine`，只用于不可重试外部 engine failure，避免 auth/quota/permission 失败后用户继续误发到同一条订阅/CLI 链路。
- P1-1 第十版：`switch-native-engine` 与 `switch-model` / `enable-auto` 分离成不同 helper request，推荐系统能清楚区分“切模型/provider”和“切执行 engine”。
- P1-1 第十一版：采用推荐的异步副作用从 `ChatInput` 中抽成可测 helper；`switch-native-engine` 不会走普通 `switchModel` IPC，`switch-model` / `enable-auto` 仍走会话模型切换。
- P1-1 第十二版：推荐条 UI 从 `ChatInput` 内联 JSX 抽成独立组件，组件测试覆盖标题、body、结构化因素、主动作和保持当前按钮；推荐对象、采用动作和可见 UI 三层都有各自回归。
- P1-1 第十三版：`ChatInput` 采用模型策略建议时使用当前会话实际生效的 provider/model，而不是全局默认主任务模型；源码契约测试覆盖 `handleApplyModelStrategyRecommendation`，避免 session override 下启用自动策略写回错误模型。
- P1-1 第十四版：`ModelStrategyRecommendationStrip` 增加组件级点击契约测试，直接验证“采用建议”调用 `onApply`、“保持当前”调用 `onDismiss`；任务级推荐不只证明能渲染，也证明主操作和保留当前选择的交互线已接上。
- P1-1 第十五版：外部 engine 遇到图片附件或代码/产物落地任务时，Composer 推荐条不再只用文案提示“切回 Native”，而是直接提供 `switch-native-engine` 主动作；测试确认这条动作不会误走普通 `switchModel`。
- P1-1 第十六版：`applyModelStrategyRecommendationAction()` 的三条采用路径都有副作用契约测试。`switch-model` 会调用 session scoped `switchModel` 并写入显式 override；`enable-auto` 会保留当前主任务 provider/model 只打开 adaptive；`switch-native-engine` 会调用 `updateSessionEngine(native)` 并清空模型 override，三者互不串线。
- P1-1 第十七版：新增真实浏览器 E2E `tests/e2e/model-strategy-recommendation.spec.ts` 和 `npm run test:e2e:model-strategy`，覆盖“简单任务输入 -> 推荐条 -> 采用自动 -> `domain:session.getModelOverride` 写入 `{ provider, model, adaptive: true }`”的目标路径，不请求真实模型；初版使用 Chromium/Chrome pipe 启动时在当前 Codex 沙箱里触发 `kill EPERM`，后续第十九版已改为 headless shell CDP 并跑通。
- P1-1 第十八版：用 Codex 内置 Browser 对隔离 web server 做真实页面手验通过。fake HOME 配置 `xiaomi/mimo-v2.5-pro` 且 `billingMode=payg`；页面输入 `你好` 后展示“简单任务不必占用重模型 / 任务: 简单问答 / 计费: 按量 / 速度: 当前偏重”，点击“采用自动”后通过 domain HTTP 读取当前 session override，结果为 `{ provider: "xiaomi", model: "mimo-v2.5-pro", adaptive: true }`。Playwright 自动化 spec 仍保留，但在当前 Codex 沙箱里浏览器进程启动受限，不能作为自动通过证据。
- P1-1 第十九版：`tests/e2e/model-strategy-recommendation.spec.ts` 改为优先使用 Playwright 缓存里的 `chrome-headless-shell` 走 CDP 端口，避免 `remote-debugging-pipe` 在当前沙箱触发 `kill EPERM`。`npx playwright test --config tests/e2e/playwright.system-chrome.config.ts tests/e2e/model-strategy-recommendation.spec.ts` 已在当前环境通过，1 test passed，真实页面自动化覆盖“简单任务 -> 采用自动 -> session adaptive override”。
- P1-1 第二十版：`tests/e2e/model-strategy-recommendation.spec.ts` 增加 `?e2e=1` 测试 harness，只允许注入当前 session 的 external engine failure 并读取 engine 状态；spec 覆盖目标是“Claude Code auth failure -> Composer 展示切回 Native -> 点击后通过 `domain:agentEngine.select` 写回 native engine”。该路径不请求真实 Claude，不把本地注入的 failure 当 live 证据；当前沙箱内重跑 `npm run test:e2e:model-strategy` 卡在 Chrome launch/cleanup 的 `kill EPERM`，提权重跑又被系统用量限制拒绝，所以这条新增页面自动化还不能算通过证据。
- P1-1 第二十一版：`chatInput.modelStrategyRecommendationWiring.test.ts` 锁住 `ChatInput` 采用推荐时会把 `updateSessionEngine` 传入 `applyModelStrategyRecommendationAction()`；配合 helper 级 `switch-native-engine` 副作用测试，能证明“切回 Native”按钮在页面 e2e 之前已有组件接线和状态副作用两层回归。`npx vitest run tests/renderer/components/chatInput.modelStrategyRecommendation.test.ts tests/renderer/components/chatInput.modelStrategyRecommendationStrip.test.tsx tests/renderer/components/chatInput.modelStrategyRecommendationWiring.test.ts` 当前通过，3 files / 32 tests。
- P1-1 第二十二版：用 Codex in-app Browser 对隔离 web server 跑通 external engine failure 页面手验。临时 fake HOME 配置 `xiaomi/mimo-v2.5-pro`、`billingMode=payg`，页面以 `?e2e=1` 打开后通过测试 harness 注入当前 session 的 Claude Code auth failure；输入 `帮我修复这个函数的 bug` 后推荐条展示“Claude Code 最近运行失败 / 失败: 认证失败 / 恢复: 需处理 / 切回 Native”，点击后读回 session engine 为 `{ kind: "native", permissionProfile: "default", origin: "manual" }`。Playwright 自动化仍受当前沙箱 Chromium Mach port 权限限制，不能把手验等同 CI 通过。
- P1-1 第二十三版：`test:e2e:model-strategy` 默认浏览器启动策略改为 CDP-only；headless shell / bundled Chromium CDP 都失败时直接抛出环境门槛诊断，不再自动 fallback 到 Playwright pipe 并把失败伪装成 `kill EPERM`。本机重跑确认失败信息包含 `bootstrap_check_in ... Permission denied (1100)` 和“environment gate, not a model-strategy product assertion”；只有显式设置 `E2E_ALLOW_PIPE_FALLBACK=1` 时才尝试 pipe fallback。
- P1-1 第二十四版：当前验收接受 Codex in-app Browser 手验作为 model strategy 推荐流的通过证据；Playwright/CDP 自动化继续保留为回归工具，但当前沙箱的 Mach port 限制不再计为产品目标阻断。`acceptance:model-strategy-summary -- --in-app-browser-model-strategy-ok` 会把该项标为 passed。
- P1-1 第二十五版：provider 降级/不可用触发的模型推荐现在会先按本轮任务硬需求筛选候选模型，例如图片任务必须推荐带视觉能力的健康候选，搜索任务必须推荐 search-capable 候选，代码/产物任务必须保留工具能力；推荐因素里会显示“需要: 视觉/搜索/工具/长上下文”。这样 provider health 不会盖过任务能力。
- P1-1 第二十六版：provider 降级/不可用且本轮是简单问答时，健康候选会优先选择 fast/flash/mini/lite 类快模型，并在推荐因素里显示“任务: 简单问答”。这样系统处理 provider 风险时仍保留速度/等待成本取舍，不会只按 provider 健康和名称排序。
- P1-1 第二十七版：provider health 推荐的 dismiss key 增加任务作用域，例如 `task:simple`、`task:vision`、`task:tool`。用户对简单问答点击“保持当前”后，图片、搜索、代码/产物这类不同任务的模型策略建议不会被同一个 provider health key 压掉。
- P1-1 第二十八版：vision/search/long-context/tool 能力建议和 external engine 附件建议的 dismiss key 增加任务输入片段。用户对一张截图或一个搜索任务点击“保持当前”后，后续不同截图、搜索或代码任务仍会重新出现对应模型策略建议。
- P1-1 第二十九版：任务级推荐增加 `taskSignal` 和 apply/dismiss 反馈事件。采用建议、保持当前和采用失败都会产出同一结构的 `model_strategy_recommendation_feedback`，只带 task kind、能力需求、provider/model、计费/速度和输入 fingerprint，不上传完整 prompt；后续可以按任务类型统计推荐采纳率和误报率。
- P1-2 第一版：`ModelProviderSettings` 增加 `icon` / `favorite`；设置页 Provider 列表和会话页模型菜单展示短图标与收藏星标，收藏 provider 在当前选中项之后前置，同时保留 source label、协议、Key 状态和 provider 身份。
- P1-2 第二版：`shared/modelRuntime` 增加内置 provider icon preset；设置页连接区增加短标识 picker，官方 provider 和动态 custom provider 都能从推荐标识里选择，仍写入现有 `icon` 字段，不改变 provider 身份和 source label。
- P1-2 第三版：`icon` 字段支持受限 `data:image/...;base64` 小图片；设置页连接区可上传/清除 provider 图片图标，左侧 Provider 列表、详情 Header 和会话页模型菜单会渲染图片，同时继续保留 source label、协议和 endpoint，避免自定义图标掩盖真实 provider 身份。
- P1-2 第四版：会话页模型菜单的 provider group 增加健康状态 badge，并按 favorite、健康、恢复中、未检测、降级、不可用排序；用户不再只能在单个模型行里看到一颗健康点，而能在 provider 层判断这条链路是否适合当前任务。
- P1-2 第五版：设置页图片图标提示明确写出“内联 data URL 保存在本机 settings 中”并展示估算大小；图标治理边界更清楚，但仍未升级到独立资产目录或团队共享图标。
- P1-2 第六版：`shared/modelRuntime` 增加 `validateProviderIcon()`，统一短文本、受限 `data:image`、96 KB 大小和拒绝原因；设置页手动变更和上传入口复用同一套校验，非法/过大的 data URL 会提示并且不会写入 settings。
- P1-2 第七版：`managedByCloud` 团队托管 provider 的显示名称和图标进入身份保护路径。设置页禁用本机名称/图标编辑，保存 helper 也会保留控制面下发的 `displayName/icon`；本机仍可保存 favorite，避免团队共享链路被本地伪装成别的 provider。
- P1-2 第八版：provider 图片图标支持本机资产目录。上传图片会通过 settings domain 保存到 `assets/provider-icons`，settings 中只保存 `provider-icon://local/...` 引用；设置页、Provider 列表和会话页 ModelSwitcher 会按引用解析成小 data URL 展示，避免把 base64 长串长期塞进 settings。
- P1-2 第九版：本机 provider 图标资产目录增加 `manifest.json`，记录 icon URI、filename、provider、mime、size、sha256、ownership、createdAt/updatedAt。后续云端文件同步或团队共享图标治理可以消费 manifest，不需要扫描目录再猜来源。
- P1-2 第十版：provider 图标资产 manifest 增加 `source`、`syncState`、`remoteId`、`lastSyncedAt` 治理元数据；本机上传默认为 `local-upload/local-only`，团队或控制面下发可标记为 `team/cloud-control-plane/synced`，同一文件后续重复本机保存不会把团队同步元数据降级。settings IPC 会剥掉 renderer 传入的团队治理字段，避免普通本机上传伪装成团队同步资产。
- P1-2 第十一版：`RuntimeModelOption` / provider group 透传 `providerBillingMode`；会话页 `ModelSwitcher` provider header 增加“按量 / 套餐 / 免费 / 计费未知”策略 badge 和 tooltip，并用 `ProviderBillingBadge` 组件级测试锁住渲染契约。用户打开模型菜单时能同时看到 provider 身份、健康状态和计费语义，理解自动策略为什么会或不会把简单任务切到快模型。
- P1-2 第十二版：会话页模型菜单 provider 分组排序抽成 `sortProviderGroupsByModelStrategy()`。排序规则保持收藏 provider 优先，其余按健康、恢复中、未检测、降级、不可用排列，并用 helper 测试锁住顺序，避免 provider 可用性分组退回组件内联黑盒。
- P1-2 第十三版：会话页 provider 健康 badge 抽成 `ProviderHealthBadge`，和计费 badge 一样带 `data-provider-health-state`、tooltip detail 与可访问状态标签，并用组件级静态渲染测试锁住“不可用 / P50 / 错误率”展示契约。
- P1-2 第十四版：会话页 provider 来源标签抽成 `ProviderSourceBadge`，带 `data-provider-source-label` 和 `title="来源: ..."`，并用组件测试锁住渲染契约。自定义图标、favorite 和健康/计费 badge 可以继续演进，但不能把中转站或自定义 relay 的真实来源挤掉。
- P1-2 第十五版：`RuntimeModelOption` / provider group 透传 `providerProtocol`、`providerTransportLabel` 和 `providerEndpoint`；会话页模型菜单 provider header 增加 `ProviderTransportBadge`，显示 OpenAI-compatible / Claude-compatible 与 endpoint tooltip。自定义 relay 即使被归入 Claude/OpenAI canonical group，也能看到真实传输协议和 endpoint。
- P1-3 第一版：capability fallback 选中不支持 tool calls 的模型时，`model_fallback` notice 会带 `toolPolicy`；会话页 fallback banner 显示“工具已关闭”和工具数变化，让用户知道本轮从可调工具降级为纯文本回复。
- P1-3 第二版：`response.runtimeDiagnostics` 增加 `toolStrategy` 和带工具快照的 `modelDecision`；最终 assistant message 会保留本轮可见工具数、MCP tool/server、programmatic tool calling 状态和 token saved 计量状态；`RouteTraceChip` 展开层展示工具数、MCP、程序化工具。
- P1-3 第三版：`toolStrategy.tokenSavings` 从空口径推进到 `estimated`；runtime 会按本轮可见工具的 `name/description/inputSchema` 估算如果塞进普通消息上下文约占多少 tokens，`RouteTraceChip` 同时展示估计节省量和“真实账单以 provider usage 为准”的口径说明。
- P1-3 第四版：`toolStrategy.tokenSavings.basis` 记录本地估算来源、工具数、预览工具数和参与估算的字段；`RouteTraceChip` 展开层增加“估算”行，用户能看到节省 token 口径来自工具规格本地估算，而不是 provider 回传账单。
- P1-3 第五版：`toolStrategy.tokenSavings.providerUsage` 记录本轮模型响应回传的 input/output/total tokens；`RouteTraceChip` 展开层增加“用量”行，把 provider usage 作为成本旁证展示，但仍不把它说成真实 saved tokens。
- P1-3 第六版：`toolStrategy.tokenSavings.measurement` 增加机器可读计量口径：`savingsSource=tool-spec-local-estimate/not-measured`、`usageSource=model-response-usage/unavailable`、`providerReportedSavings=false`。`RouteTraceChip` 展开层增加“计量”行，直接说明“上下文少占=本地估算、用量=provider usage、无 provider-reported saved tokens”。
- P1-3 第七版：`RouteTraceChip` 对 `toolPolicy=disabled-by-model` 增加“工具策略”说明，明确当前执行模型不支持工具调用，本轮按纯文本执行，MCP / 程序化工具不会下发；用户不必从“模型不支持”四个字猜本轮工具为何不可用。
- P1-3 第八版：`RouteTraceChip` 把折叠/展开里的 saved-token 文案改成“本地估算少占上下文”，并在没有 provider-reported saved tokens 时自动展示“saved tokens 是工具规格少占上下文的本地估算，不等同 provider 账单节省；真实成本看 provider usage”。即使事件生产方没写 detail，UI 也会保留防误读边界。
- P1-3 第九版：`ModelResponse.usage` / `toolStrategy.tokenSavings` 增加 provider-reported saved-token contract；当 provider/tool 层明确回传 `providerReportedSavedTokens` 时，runtime 会把 `tokenSavings.status` 升级为 `provider-reported`，会话页展示“provider 回传节省”和 `providerReport`，并自动取消本地估算边界。当前仍缺真实 provider live evidence，不能把本地估算当账单节省。
- P1-3 第十版：新增 `acceptance:provider-saved-tokens` fixture smoke，用 `tests/fixtures/provider-reported-saved-tokens-decision.json` 验证 `provider-reported` contract 必须同时具备 `providerReport.savedTokens`、`measurement.providerReportedSavings=true` 和 provider usage，且拒绝把 `providerUsage` 单独当 saved-token evidence 或混入本地估算 `basis`。这只是本地 contract gate，真实 provider live evidence 仍未完成。
- P1-3 第十一版：当前分支重新跑过 P0/P1 的离线 contract gates：Claude subscription dry-run、长回复 partial replay、MCP-style tool replay 和 provider-reported saved-token fixture smoke 都返回 `ok: true` / `status=passed`；这证明命令合同、transcript 清洗、MCP-style 事件观察和 provider-reported saved-token contract 没被后续 UI 改动打坏，但仍不替代真实订阅账号或真实 provider live evidence。
- P1-3 第十二版：`acceptance:provider-saved-tokens` 增加手动 live response evidence gate。显式传 `--live-response <path>` 时必须同时传 `--manual-provider` 和 `CODE_AGENT_PROVIDER_SAVED_TOKENS_SMOKE=1`，脚本会读取真实 provider response JSON，只接受 `usage.providerReportedSavedTokens` 或等价 provider/tool saved-token 字段；只有 `usage` 没有 saved-token 字段会返回 `status=blocked`，不能冒充账单节省。已用临时响应文件验证：带 `providerReportedSavedTokens=42` 通过，usage-only 响应 blocked。
- P1-3 第十三版：`scripts/acceptance/xiaomi-smoke.ts` 增加 `--provider-response-out <path>`，可把真实 Xiaomi tool-calling 响应写成 provider response artifact，并直接接入 `acceptance:provider-saved-tokens --live-response`。后续第十五版已确认凭证在 `~/.code-agent/.env`，并跑到真实 Xiaomi tool-calling 证据。
- P1-3 第十四版：Xiaomi provider response artifact builder 抽成纯函数并补单测。测试证明 artifact 只保留 provider/model/scenario/capturedAt/usage/toolCalls，不携带 tool result/live output 等多余内容；当 usage 带 `providerReportedSavedTokens` 时，可直接通过 `validateProviderReportedSavedTokensLiveResponse()`。
- P1-3 第十五版：已按真实路径 `~/.code-agent/.env` 读取 Xiaomi 凭证并跑通 `scripts/acceptance/xiaomi-smoke.ts --provider-response-out /tmp/xiaomi-provider-response.json`。结果：`mimo-v2.5-pro` 普通对话通过，tool calling 产出 `get_weather({"city":"上海"})`，`mimo-v2.5` 标准模型通过；artifact 有 provider usage 和 1 个 tool call，但没有 `providerReportedSavedTokens` 或等价 saved-token 字段。因此当前产品口径是 provider 已验明“不报告 saved-token 差值”，不是缺 key 或没有真实请求。
- P1-3 第十六版：`acceptance:model-strategy-summary` 把 `provider-saved-token-live-gate` 调整为 `provider-saved-token-live-boundary`。如果真实 provider artifact 只有 usage/toolCalls 而无 saved-token 字段，汇总会把该项标为 passed：证明 live response 已观察、usage-only 仍被严格挡在 provider-reported 外，不再把“provider 不报告字段”显示成待用户补依赖。
- P1-4 第一版：AI SDK 普通 provider 失败后，在 `adaptive=true` 的自动模式下复用 provider fallback chain；成功切换会写入 `response.fallback`，候选缺 Key、provider unavailable、AI SDK 不支持或全链路耗尽都会记录 tried/skipped/selected/exhausted trace，显式模型选择仍不跨 provider fallback。
- P1-4 第二版：fallback 元数据和会话页 notice 增加策略模式标签。provider fallback 显示“自动策略恢复”，capability fallback 显示“能力自动切换”，adaptive 候选失败回主任务模型显示“回到主任务模型”，把“为什么系统换了模型/又回到主模型”从技术 trace 提升为任务策略解释。
- P1-4 第三版：`ProviderStatusNotice` 的 toast formatter 增加策略模式测试，覆盖 `adaptive-provider-fallback` 和 `adaptive-main-task-recovery`，同时保留无 strategy 旧事件兼容。
- 验收汇总第六版：`acceptance:model-strategy-summary` 增加 Codex CLI live smoke、Xiaomi live response artifact、fallback visibility contract、surface billing/identity contract、task recommendation capability contract 和 in-app Browser 手验证据入口。当前推荐用法是 `npm run acceptance:model-strategy-summary -- --codex-result /tmp/codex-cli-engine-smoke.json --xiaomi-live-response /tmp/xiaomi-provider-response.json --in-app-browser-model-strategy-ok --json`；这会把 Codex CLI、Browser、Xiaomi tool calling、provider-saved-token live boundary、fallback 可见性、会话页 billing/provider identity、provider health 推荐按任务能力筛选、简单任务优先健康快模型和 dismiss key 任务作用域都标为通过。真实 Xiaomi 不回传 saved-token 字段被表达为 provider 能力限制，而不是 live gate。
- 验收汇总第七版：`acceptance:model-strategy-fallback`、`acceptance:model-strategy-surface`、`acceptance:model-strategy-summary` 和 Xiaomi live smoke 改走本地 `scripts/acceptance/run-vite-acceptance.mjs` runner。runner 用项目本地 Vite SSR 加载 TS/TSX 脚本，显式配置 `@shared/@renderer/@main` alias，不再依赖临时 `npx tsx` 下载、cache lock 或 `/tmp` 下 esbuild service。

未落地：

- 更完整的 provider 图标资产管理，例如真实云端文件同步和团队共享图标分发；当前已支持受限小图片 data URL 兼容路径、本机资产目录引用、资产 manifest、同步治理元数据、输入边界、大小估算、拒绝原因、团队托管 provider 身份保护，以及会话页 provider 计费、健康、来源、协议和 endpoint 语义 badge。
- Claude subscription/CLI 的通过态不再作为当前实现目标阻断；它保留为 Alma 对标证据。当前可用的外部 CLI engine 验收改走 Codex CLI，已经跑到通过态。
- programmatic tool saved tokens 的真实 provider evidence 已落到“真实 Xiaomi usage + tool call + 无 provider-reported saved-token 字段”。这里的产品结论已经明确：会话页只能展示本地估算和 provider usage，不能声称 provider 回传账单节省。

## 资料与证据

本地资料：

- Alma release notes：`/tmp/alma-update-20260613/release-notes-805-823.md`
- Alma old renderer：`/tmp/alma-update-20260613/old/extract/renderer-assets/index-DZO6LH4W.js`
- Alma new renderer：`/tmp/alma-update-20260613/new/extract/renderer-assets/index-lrtJ1hZ1.js`
- Alma old main：`/tmp/alma-update-20260613/old/extract/index.js`
- Alma new main：`/tmp/alma-update-20260613/new/extract/index.js`

Release notes 关键证据：

- v0.0.807：新增 `Plugins & Providers` 设置入口和 provider setup banner；文档把 `main chat model` 改为 `main task model`，并提醒不要选择过慢或过贵的模型。见 release notes 134-141。
- v0.0.811：Claude subscription requests 改走官方 Claude CLI interactive mode；修复长回复截断/重组错误，改用干净 conversation text，去掉 terminal footer/interface clutter。见 release notes 98-107。
- v0.0.812：新增跨 provider 的 universal programmatic tool calling，并展示 programmatic tool calling 节省的 token。见 release notes 83-88。
- v0.0.813：恢复 pipe-based `claude -p`，同时保留 V3 和 MCP tool support。见 release notes 73-77。
- v0.0.809/0.0.810：provider 支持 custom icon、favorite、icon picker。见 release notes 112-120。
- v0.0.805：plugin events/metadata 增加 finish reasons、response IDs、`chat.subagent.didComplete`，被截断的 tool output 会保存到文件。见 release notes 155-158。
- v0.0.823：减少 main process 和 database layer 慢点，移除 base64 heavy path 导致的全局卡顿。见 release notes 4-5。

Bundle diff 关键证据：

- new/old renderer 都存在 `modelUsageHistory`、`recordModelUsage`、`sortModelsByUsage`、`/api/models`、`providerSyncClient`、`useACPCommands`、`MCP_CLIENT_TOOLS_KEY`、`selectedMCPServers`、`getMCPStatusIcon`、`SafePromptInputModelCombobox`。这说明 Alma 会话输入区的模型选择、provider 同步、ACP/MCP 工具上下文已经是同一条用户路径。
- new/old main 都能搜到 `claude-subscription` provider 类型，但 new main 比 old main 多出订阅链路关键运行时：`mcp-bridge.cjs` 从 0 到 1，`--input-format stream-json` 从 0 到 1，`--strict-mcp-config` 从 0 到 1，`--allowedTools` 从 0 到 1，`specificationVersion:"v3"` 从 0 到 1，`claude-subscription-get-cli-status` 从 0 到 1。
- new main 的运行轨迹比 old main 更可解释：`turnEndReason` 从 2 到 22，`fallbackReason` 从 0 到 7，`providerResponseId` 从 4 到 10，`recordStep` 从 0 到 4，`finalize` 从 0 到 18。
- new main 的 Claude subscription pipe 片段包括 `-p`、`--output-format stream-json`、`--input-format stream-json`、`--include-partial-messages`、`--strict-mcp-config`、`--mcp-config`、`--allowedTools`、`--dangerously-skip-permissions`，并用临时 MCP bridge 把 Alma tool bridge 注入 Claude CLI。

## Alma 的 Model 产品思路

### 1. `main task model` 比 `main chat model` 更准确

`main chat model` 暗示模型只是对话外观，用户会倾向于用“喜欢哪个模型”理解它。`main task model` 暗示模型是任务交付链的主执行引擎，选择会直接影响：

- 能不能完成任务：是否支持 tools、MCP、programmatic tool calling、vision、长上下文。
- 完成得稳不稳：subscription CLI 是否会截断，transcript 是否干净，response ID/finish reason 是否能追踪。
- 完成得快不快：main process/db/base64 热路径会影响会话页响应，慢模型会拖慢等待。
- 花费是否合理：过贵模型不适合简单任务；programmatic tool calling 甚至会显式展示 token saved。
- 失败后如何恢复：fallback、pipe-based Claude CLI、MCP bridge、tool output 落盘，都是“让任务可继续”的策略。

Alma 的文档命名变化有运行时证据支撑。它在 0.0.811 到 0.0.813 里用链路修复证明：模型链路质量直接影响会话页交付质量。

### 2. Provider 可识别性也是模型策略的一部分

v0.0.809/0.0.810 的 custom icon、favorite 看起来小，但作用很直接：当 provider 数量增加、subscription/API/ACP/MCP 混在一起时，用户需要快速识别“这轮任务到底跑在哪条链路上”。provider 如果只是下拉框字符串，会话页无法建立信任。

### 3. Tool calling 让 provider 差异变成输出质量差异

v0.0.812 的 universal programmatic tool calling across all providers 说明 Alma 在解决一个核心问题：同样的任务，模型/provider 对工具调用格式、节省 token、MCP 支持的表现会不同。会话页如果只显示模型名，用户看不到工具能力是否拖累了结果。

### 4. Subscription model 是独立运行链路

Claude subscription 通过官方 CLI interactive mode、pipe-based `claude -p`、stream-json、transcript 清洗、MCP bridge、CLI status 暴露，说明订阅模型链路的可靠性由终端协议、输出重组、权限、MCP 配置共同决定。它不适合被塞进普通 API Key provider 表单里假装一致。

## code-agent 当前实现位置

### 决策与计费

- `src/main/model/modelDecision.ts`
  - 单一路由决策入口，注释明确说 UI trace、日志、成本统计统一消费同一个对象。
  - `resolveProviderBillingMode()` 定义 `free | plan | payg | unknown`，普通 provider 默认 `payg`，动态 custom provider 默认 `unknown`。
  - `resolveModelDecision()`：subagent 走 `role-tier` 并剥离 adaptive；主聊天 adaptive 关闭走 `user-selected`；simple task 只有 `billingMode === 'payg'` 才切免费模型；plan/unknown 返回 `billing-gate-skip`。
- `src/shared/contract/modelDecision.ts`
  - `ModelDecision` 包含 requested/resolved provider/model、role、reason、billingMode、fallbackFrom。
  - reason 已预留 `capability-vision`、`fallback-availability`。研究时 payload 还缺任务类型、复杂度分、速度/成本说明、provider health snapshot；本分支已补第一版字段和展示。
- `src/shared/contract/settings.ts`
  - `ModelProviderSettings.billingMode` 已写清计费语义，且说明 simple 到免费档仅在 payg 生效。

### Router、fallback 与 provider 运行时

- `src/main/model/modelRouter.ts`
  - `ModelRouter` 注册 moonshot、groq、qwen、minimax、perplexity、local、openai、deepseek、openrouter、zhipu、claude/anthropic、gemini、volcengine、longcat、xiaomi、custom。
  - `fallbackModels` 按 capability 定义 vision/reasoning/code/fast/general/gui/search/compact/quick/longContext/unlimited。
  - `getVisionPreflightCandidates()` 按同 provider 视觉模型到其它已配置 Key 的视觉模型排序，避免写死单一 provider。
  - `inference()` 走 `resolveModelDecision()`，simple task 免费路由失败后回到默认 provider。
  - `allowCrossProviderFallback = config.adaptive === true`，显式选模型时不会跨 provider fallback。
  - fallback 成功后写 `result.actualProvider/actualModel/fallback`，并广播 `provider:fallback`；本分支已把 primary failed、candidate skipped/failed、selected candidate 和 exhausted 记录进 trace。
- `src/main/model/modelRouterPolicy.ts`
  - fallback 分类覆盖 timeout、rate_limit、quota、auth、provider_unavailable、network、artifact_response、model、unknown。
  - 支持控制面 override fallback chain，坏配置回退到硬编码链。
  - artifact 请求会重排 fallback priority，并限制何时留在 selected provider、何时允许跨 provider。
- `src/main/model/providerHealthMonitor.ts`
  - provider health 有 `healthy/degraded/unavailable/recovering`、p50/p95、5 分钟 error rate、连续错误。
- `src/shared/constants/providers.ts`
  - provider 端点、代理决策、国内直连/海外代理、provider 并发限额等都是模型策略的一部分。
- `src/shared/modelRuntime.ts`
  - runtime model option 含 provider label、provider group/source label、tool/vision/reasoning feature。
  - 对 custom provider 会根据 displayName/modelId/protocol 推断 canonical provider group。

### 会话页可见性

- `src/main/agent/runtime/contextAssembly/inference.ts`
  - `resolveMainChatModelDecision()` 在 aiSdk/legacy 两条引擎前统一发射 `model_decision` 事件，data 带 decision、turnId、timestamp。
  - vision preflight 成功时发 notification；整轮能力 fallback 时发 `model_fallback`，并带 capability trace。
  - router 返回 `response.fallback` 时，会补发当前 turn 的 `model_fallback` notice，让 provider fallback 能进入会话回看；router 抛出带 `modelFallback` 的 exhausted 错误时也会先发 notice。
  - AI SDK adaptive 免费候选失败后回到主任务模型，会把这次回退写入 `response.fallback`；主任务模型也失败时，错误携带 exhausted trace。
  - AI SDK 普通 provider 调用在自动模式下会复用 fallback chain；selected、skipped、exhausted 也走同一份 `ModelFallbackInfo`，显式选择保持不降级。
  - `ModelFallbackInfo.strategy` 会标记自动 provider 恢复、能力自动切换或回到主任务模型，renderer 的 fallback notice 和 provider fallback toast 不再只展示换了谁，也展示这次恢复属于哪种模型策略。
  - fallback 模型如果不支持 tool calls，会清空工具列表并改用简化视觉 prompt。
- `src/renderer/hooks/agent/effects/useConversationStreamEffects.ts`
  - `normalizeModelDecisionPayload()` 校验 reason/billingMode 后，把 decision 写回 assistant message。
  - `model_fallback` 事件会归一化 tried/skipped trace，并插入 `buildModelFallbackNoticeMessage()`。
- `src/renderer/hooks/useTurnProjection.ts`
  - 将 `modelDecision` 投到 assistant_text node；连续相同决策去重。
  - 将 `source === 'model'` 的 fallback notice 投为 `model_fallback` system node。
- `src/renderer/components/features/chat/RouteTraceChip.tsx`
  - 当前只展示 reason label 和 requested/resolved model 简写；hover title 只有 from/to。
- `src/renderer/components/features/chat/MessageBubble/FallbackBanner.tsx`
  - 当前展示“模型已降级”、from/to/reason，以及已尝试、已跳过、已选用、已耗尽的 provider/model 轨迹。
- `src/renderer/components/StatusBar/ModelSwitcher.tsx`
  - 会话页 StatusBar 里合并 Engine、Model、Effort，打开时拉取 settings、provider health、agent engine descriptors、engine model catalog。
  - 会过滤未配置 runtime models，并有健康状态 map，但策略解释仍不在主消息流中展开。

### 设置页与 provider 管理

- `src/renderer/components/features/settings/tabs/ModelSettings.tsx`
  - Master-Detail：左侧 provider 列表，右侧连接/模型/高级配置。
  - 支持默认模型、provider API Key、动态 custom provider、provider doctor、模型能力标签、并发、代理、protocol。
- `src/renderer/components/features/settings/tabs/ModelSettings.helpers.tsx`
  - provider-only save 与 set-default 分离；保存 provider 不会顺手改默认模型。
  - `buildProviderManagementRows()` 给 provider 列表产出 endpoint、selected、default model、keyless 等状态。
- `src/renderer/components/ProviderStatusNotice.tsx` 与 `ProviderDoctorDialog.tsx`
  - 有 provider 状态/诊断入口，但还没有和会话页的 model decision 合成一个解释面。

### 已有测试锚点

- `tests/unit/model/modelDecision.test.ts`：覆盖 subagent role-tier、user-selected、simple-task-free、billing-gate-skip、billingMode 默认值。
- `tests/unit/model/modelDecisionWiring.test.ts`：源码契约保证 aiSdk/legacy 和 agentDefinition 都走统一决策入口。
- `tests/unit/agent/inference.modelDecision.test.ts`：保证 `model_decision` 事件发射在 aiSdk/legacy 分发前。
- `tests/renderer/hooks/useTurnProjection.test.ts`：保证 modelDecision 和 model fallback notice 进入 turn projection。
- `tests/renderer/hooks/useConversationStreamEffects.test.ts`：保证 SSE `model_decision` 写回 assistant message。

## 差异判断

### 我们已经有“策略底座”，但用户看到的仍像配置

code-agent 的实现已经把模型路由、计费门控、fallback、能力检测拆成了真实策略。但 UI 入口仍以 `ModelSettings`、`ModelSwitcher`、`RouteTraceChip` 组织，用户心智仍容易停在“我选了哪个模型”。Alma 的 `main task model` 更直接地提醒用户：这是当前任务的执行主模型，选错会让任务慢、贵、弱、容易失败。

### 会话页解释粒度仍需继续收敛

本分支后，`RouteTraceChip` 和 `FallbackBanner` 已能显示：

- 用户选择 / 角色档位 / 简单任务 / 计费跳过 / 视觉能力 / 可用性降级。
- requested model 到 resolved model。
- 任务类型、复杂度分、成本策略、速度策略、能力需求、provider health snapshot。
- resolved provider 的来源、协议和 endpoint 身份。
- fallback 的 tried、skipped、selected、exhausted 轨迹，provider/capability fallback 的最终执行模型对齐到消息级 `RouteTraceChip`，fallback notice 的 from/to provider identity，以及 fallback 后工具被关闭的原因。
- 本轮可见工具数、MCP server、programmatic tool calling 是否可用。

仍然欠的主要是：

- 任务分类和复杂度仍是规则估计；当前已经有推荐 apply/dismiss 的隐私有界 task feedback signal，但还缺长期聚合、质量回放和自动阈值校准。
- subscription/外部 engine 的 CLI 状态、partial/transcript 重组、成功/失败消息级策略 trace 和失败归因已有离线契约；`claude -p` stream-json 保留为 Alma 对标证据，当前实现验收走 Codex CLI，真实 `codex exec --json --sandbox read-only` 已通过。
- programmatic tool saved tokens 已有真实 Xiaomi tool-calling usage 证据，但 provider response 没有 `providerReportedSavedTokens` 或等价字段；当前差距是 provider 是否能提供 saved-token 差值，而不是 key、网络或请求链路。
- provider 图标、favorite 和可用性分组仍是轻量配置；内置短标识 picker、小图片 data URL、本机图片资产目录、资产 manifest、同步治理元数据、输入校验、模型菜单 provider 健康/计费/来源/协议/endpoint badge 和团队托管 provider 身份保护已补，真实云端同步和团队共享图标分发还没做。

### Subscription 模型链路还没有被产品化表达

Alma 把 Claude subscription 单独打磨：CLI mode、pipe mode、transcript、MCP bridge、CLI status 都是可靠性面。code-agent 现在会话页有 Agent Engine selector 和外部 engine catalog，但用户看不到“这个订阅/外部引擎链路是否健康、是否会截断、是否支持 tools/MCP、当前 auth/quota 是否正常”的任务级提示。

### Provider 可识别性已补轻量层，资产治理仍弱

Alma 在 0.0.809/0.0.810 做 custom icon/favorite。code-agent 这条分支已经补了短标识、图片图标、本机资产目录、资产 manifest、favorite、provider 健康分组、来源标签、协议/endpoint badge、输入边界和团队托管 provider 身份保护；剩下的差距主要在资产治理：云端同步和团队共享 provider 图标文件治理。provider 增多后，用户仍需要一眼分辨“官方 API、中转站、订阅 CLI、外部 engine、local”。

## 借鉴建议

### P0-1：会话页 Model Decision 解释面

目标：把现有 `RouteTraceChip` 升级为可展开的 `Model Strategy` 说明，默认轻量，展开后能读懂本轮模型决策。

最小开发切片：

- 扩展 `ModelDecisionEventData`，增加可选字段：
  - `taskClass`: `simple | coding | vision | artifact | search | long_context | multi_tool | unknown`
  - `complexityScore`
  - `costPolicy`: `save_cost | plan_no_savings | unknown_conservative | user_locked`
  - `speedPolicy`: `fast-path | normal | provider-degraded | fallback-recovery`
  - `capabilityNeeds`: `vision/tool/longContext/search/code`
  - `toolPolicy`: `tools_enabled | tools_disabled_by_model | mcp_available | programmatic_available`
  - `healthSnapshot`: provider status + p50/p95/errorRate
  - `providerIdentity`: source label + compatible protocol + endpoint
  - `ModelFallbackInfo.tried` / `ModelFallbackInfo.skipped` / selected trace
- `resolveModelDecision()` 先只填现有能确定的字段，避免臆测。
- `RouteTraceChip` 改成点击展开，不改变消息流结构。
- `FallbackBanner` 复用同一份 strategy copy，避免 chip 和 banner 说法不一致。

验收：

- 单测：扩展 `modelDecision.test.ts`，覆盖 payg/plan/unknown 对 costPolicy 的映射。
- 接线：扩展 `inference.modelDecision.test.ts`，保证新字段透传。
- Renderer：扩展 `useConversationStreamEffects.test.ts`、`useTurnProjection.test.ts`、`TraceNodeRenderer` / `RouteTraceChip` 测试。
- Acceptance：`npm run acceptance:model-strategy-fallback -- --json` 渲染真实 fallback banner 和 notice formatter，确认 capability/provider fallback 的策略标签、身份、trace、工具关闭和 toast 文案不会漂移。

风险：

- 解释太长会压消息流。默认只显示一句短判断，详情放展开层。
- health snapshot 可能过期。字段名要标明 sampledAt，避免伪实时。
- 不要让解释诱导用户以为系统一定能省钱，未知计费要保守。

### P0-2：把“默认模型”改成“主任务模型”的产品语义

目标：先改信息架构和文案，不先动路由算法。让 Settings 和会话页都把主模型解释为任务执行主模型。

最小开发切片：

- `ModelSettings` 顶部把默认模型区域改为“主任务模型”，说明它负责普通任务的主要执行质量。
- 已完成第四版：在 provider detail 的默认按钮附近加短提示，说明复杂/长上下文任务适合强模型，日常小任务避免长期锁定慢模型或按量昂贵模型，自动模式会按任务、成本、速度和能力尝试切换。
- 已完成第三版：`ModelSwitcher` trigger tooltip 改为“本轮主任务模型 / 外部引擎 / effort / 计费 / provider 状态”的任务策略摘要，不只写模型名。
- 已完成补强：`ChatView` 发送门禁、首次模型 onboarding 保存状态也使用“主任务模型”，避免最早接触模型配置的入口还停留在“默认模型”。
- 文案必须贴合当前逻辑：只有 `adaptive=true` 且 `billingMode=payg` 才做 simple cost routing。

验收：

- Renderer 测试覆盖设置页文案、ModelSwitcher tooltip；tooltip helper 覆盖 Native 自动、显式 override、外部 engine 三类入口。
- 已补源码契约测试覆盖 `ChatView`、`ModelOnboardingModal` 和 `ModelSettings` 的主任务模型文案与策略提示。
- 不改 settings schema、不改默认 provider 行为。

风险：

- 只改文案不补解释面，容易变成概念升级但用户仍看不到证据。应和 P0-1 同批或紧邻。

### P0-3：订阅/外部引擎可靠性状态进入会话页

目标：对 Claude/Codex/其它 external engine 或订阅链路，展示“可用性 + 输出可靠性 + tools/MCP 支持”的运行状态。

最小开发切片：

- 在 Agent Engine catalog descriptor 或 runtime descriptor 中增加：
  - `authState`
  - `quotaState`
  - `cliStatus`
  - `streamingMode`
  - `toolSupport`
  - `transcriptMode`
- 已完成：`ModelSwitcher` 外部 engine 选项显示状态：可用、需配置、CLI 不可用、tools limited。
- 已完成：Claude Code / Codex CLI 成功消息会带 `modelDecision.externalEngine`，会话页 `Model Strategy` 展开层显示 external engine 的链路状态。
- 已完成：Claude Code / Codex CLI 失败会带结构化 failure diagnostics，auth/quota/timeout/network 等不再只是一段 stderr 文本。
- 已完成：Claude Code / Codex CLI 失败会落可见 assistant 诊断消息，且展开层显示 `externalEngine.failure`。
- 已完成：Claude Code / Codex CLI 最近一次失败会进入 `session.engine.failure`；模型菜单可靠性卡片优先展示这次失败，而不是只展示 descriptor 的静态可用状态。
- 已完成：外部 engine failure 记录 `occurredAt`，模型菜单和消息级 RouteTrace 会显示失败发生多久前，区分当前轮失败和陈旧链路状态。
- 已完成：Composer 发送前策略提示读取 `session.engine.failure`，外部 engine 最近失败时展示失败分类、时间和恢复建议。
- 已完成：不可重试的外部 engine 最近失败可从 Composer 一键切回 Native 主任务模型；可重试失败保持提示，不抢用户选择。
- 已完成：发送前策略提示会说明外部 engine 当前文本/只读链路边界，避免用户误以为它会像 Native 一样处理图片或直接写文件；图片附件和代码/产物落地任务都可从推荐条一键切回 Native。
- 已完成：store 层回归测试证明切回 Native 会移除旧 external failure，不会让陈旧 auth/quota 状态继续影响下一轮推荐。
- 已完成：Composer 采用建议动作有 `applyModelStrategyRecommendationAction()` helper 级测试；不可重试 external failure 会切回 Native、清 override、dismiss 当前推荐，且不会触发普通 `switchModel`。
- 已完成：Composer 推荐条有独立组件和渲染测试，外部 engine 失败提示、因素标签、“切回 Native / 保持当前”可见性不再依赖整块 ChatInput 目测。
- 已完成：消息级 RouteTrace 展开层显示 external engine failure 的 HTTP status 与 CLI exit code，认证、quota、runtime 失败能直接在本轮消息里定位。
- 已完成：新增手动门控 Claude subscription CLI smoke，覆盖 dry-run、version probe、stream-json 输出解析、expected marker、auth/quota/runtime 失败分类；真实请求不会默认执行。
- 已完成：Claude Code adapter 和 smoke parser 都接入 `api_error_status` 结构化字段，不再只靠错误文本里的数字识别 HTTP status。
- 已完成：renderer stream normalizer 保留 external engine diagnostics，避免 `RouteTraceChip` 已支持的订阅链路解释在 `model_decision` 事件进入消息时丢失。
- 已完成：模型菜单 reliability 摘要补齐 auth/quota 状态，订阅链路是否已登录、是否 quota 耗尽不必等到失败消息出现才知道。
- 已完成：带 `externalEngine.failure` 的消息级 RouteTrace 默认展开，auth/quota/runtime 失败的 HTTP status、exit code、失败年龄和建议在 assistant 诊断消息里直接可见，并有 `TraceNodeRenderer` renderer 测试覆盖。
- 已完成：Claude subscription smoke 的 dry-run/probe 输出结构化 `contract`，把 CLI print-mode、stdin text、stream-json、partial messages、plan permission、只读工具、strict MCP、clean transcript、no session persistence、离线覆盖和人工 live gate 边界拆成机器可读字段。
- 已完成：Claude subscription smoke 增加 `--replay-fixture`；当前 fixture 能离线回放长回复 partial delta、assistant snapshot、无 final text 的 result 事件和 terminal/footer 噪声，验证最终 transcript 由 partial 合并、没有重复 snapshot、没有把终端噪声写入 assistant 文本。
- 已完成：Claude subscription smoke 的 fixture replay 可要求 MCP bridge 边界；MCP/tool fixture 会回放 `mcp__...` tool_use、tool_result 和工具输出噪声，验证工具事件可观察且不会污染 assistant transcript。
- 已完成：最小真实 Claude subscription smoke 已显式运行；当前真实阻塞是 `auth/auth_failed`，HTTP 401，`authState=needs_login`。这证明真实 CLI 请求失败会进入结构化归因，但还不是订阅通过态。

验收：

- Agent engine selector smoke：缺 CLI、缺 auth、可用三种状态。
- Renderer：菜单项状态和 tooltip。
- 不接真实 Claude CLI 也能先用 mock descriptor 验 UI 合同。
- 手动门控：`npm run acceptance:claude-subscription-cli -- --dry-run --json`、`--probe-only --json`、`--replay-fixture tests/fixtures/claude-subscription-long-response-stream.ndjson --json` 和 `--replay-fixture tests/fixtures/claude-subscription-mcp-tool-stream.ndjson --expect-mcp-bridge --json` 已在当前分支通过，且 npm script 现在走本地 `jiti`，可无真实请求验证命令、CLI 版本、结构化运行契约、长回复 partial/transcript 回放和 MCP-style 工具事件解析边界；真实订阅请求已用 `CODE_AGENT_CLAUDE_CLI_SMOKE=1 npm run acceptance:claude-subscription-cli -- --manual-claude --json` 跑到 CLI/result 层，但当前返回 `auth/auth_failed`，HTTP 401，仍需登录通过态后复跑。

风险：

- 不要把订阅 CLI 和 API provider 强行揉成同一种配置。状态字段可共用，配置路径应分开。
- CLI transcript/streaming 的真实可靠性需要端到端手验，不能只靠单测。

### P1-1：任务级模型推荐

目标：用户发送前，系统给出“当前任务建议模型”或“保持当前模型”的建议，解释能力/成本/速度取舍。

最小开发切片：

- 基于已有 `inferModelCapabilities()`、`detectRequiredCapabilities()`、`estimateComplexity()`、provider health、billingMode 做推荐。
- 已完成：发送前建议会读取当前 provider health，degraded/unavailable 时提示质量风险，并复用“采用自动”动作进入可 fallback 的任务策略。
- 已完成：发送前建议会从已配置 runtime models 中挑选 provider/model；provider 降级迁移只接受 healthy/recovering 候选，采用建议后会调用 `switchModel` 切到目标 provider/model，未找到可靠候选时才退回自动策略。
- 已完成：采用建议的 `switchModel` payload 有 helper-level 单测覆盖；推荐条组件已有点击契约测试。
- 已完成：Codex 内置 Browser 对隔离 web server 跑通“简单任务 -> 采用自动 -> session adaptive override”；Playwright 自动化 spec 已改用 headless shell CDP，并在当前环境通过。
- 已完成：联网、搜索、最新信息类任务单独走 `search` 能力判断，当前模型不具备 search 时优先推荐 search-capable 主任务模型；工具型代码/产物任务继续走 `tool` 能力判断，避免把检索质量问题误说成普通工具能力问题。
- 已完成：简单任务推荐开始区分计费和速度。`payg` provider 上的偏重模型会提示慢/贵风险并建议自动策略；`plan/free/unknown` provider 不再沿用“省成本”话术，只有存在健康快模型候选时才建议切换。
- 已完成：推荐对象带结构化 `strategyFactors`，Composer 推荐条直接展示任务类型、能力需求、计费/速度、候选模型和 provider 状态，避免把模型推荐依据藏在长句里。
- 已完成：外部 engine 最近失败会进入同一条推荐机制，用 warning 提醒用户先处理登录、额度、网络、权限或切回 Native 主任务模型。
- 已完成：`switch-native-engine` 推荐动作只处理 engine 恢复，不混进 provider/model 的 `switchModel` payload，避免把订阅/CLI 链路和普通 API provider 混成一类配置。
- 已完成：`buildModelStrategyEngineSelectionRequest()` 覆盖 native engine selection payload；不可重试 external failure 会生成 engine selection，可重试 failure 不生成动作。
- 已完成：`applyModelStrategyRecommendationAction()` 覆盖采用推荐的异步副作用，保证 `switch-model`、`enable-auto` 和 `switch-native-engine` 走不同执行路径；`enable-auto` 保留当前主任务模型身份，只打开 adaptive。
- 已完成：`ModelStrategyRecommendationStrip` 覆盖推荐条的可见 UI 契约；任务级推荐不只停留在算法 helper。
- 已完成：ChatInput 采用推荐时绑定 session-effective provider/model，session override 场景不会把自动策略错误写回全局默认主任务模型。
- 已完成：Codex in-app Browser 手验通过 external engine failure 的真实页面链路；推荐条显示 auth failure 和“切回 Native”，点击后 session engine 回到 native。`test:e2e:model-strategy` 自动化 spec 已补，默认失败会明确停在 CDP 环境门槛上；当前验收接受 in-app Browser 证据，CDP 自动化作为回归补充。
- 已完成：provider 降级/不可用推荐不再只找健康候选，还会先按本轮任务能力需求筛选。图片、搜索、长上下文、代码/产物任务分别要求 vision/search/long-context/tool，避免推荐健康但不具备本轮硬能力的模型。
- 已完成：provider 降级/不可用下的简单问答会优先推荐健康快模型，避免把“恢复可靠性”做成只看 provider 健康、不看速度和等待成本。
- 已完成：provider health 推荐的“保持当前”作用域带任务类型，不会因为用户在一个简单任务里保留当前模型，就隐藏后续图片、搜索、代码/产物任务的不同策略建议。
- 已完成：能力类推荐和外部引擎附件提示的“保持当前”作用域带任务输入片段，不会因为一个截图或搜索任务被保留当前，就吞掉后续不同任务的模型策略建议。
- 已完成：任务级推荐的采用/保持当前/采用失败会产出隐私有界 task feedback signal。事件不带完整 prompt 和推荐 key，只带任务类型、能力需求、输入 fingerprint、当前 provider/model、计费/速度、provider health 和目标模型，后续可以用它评估哪些推荐被接受、哪些任务类型容易误报。
- Composer 或 ModelSwitcher 顶部显示一条建议：
  - “这轮是简单问答，按量计费下建议快模型。”
  - “这轮含截图，当前模型不支持视觉，会先用 X 读图。”
  - “这轮需要产物写入，建议使用工具能力稳定的模型。”
- 只提供“采用建议/保持当前”，不自动抢用户显式选择。

验收：

- 单测覆盖 simple、vision、artifact、long-context、provider degraded。
- 已完成 helper-level payload 测试：`switch-model` 与 `enable-auto` request body；已补三类采用建议动作副作用测试、推荐条渲染/点击测试、ChatInput 接线源码契约测试。推荐反馈测试证明 apply/dismiss 事件只发 task signal，不带完整 prompt。真实浏览器点击链路已用 Codex Browser 手验通过“采用自动”和“external failure 切回 Native”；`test:e2e:model-strategy` 已补对应自动化 spec，并把默认失败口径收敛到 CDP 环境门槛，当前验收以 in-app Browser 通过为准。

风险：

- 推荐错会损害信任。先做建议，不做强制切换。
- 不要用过细模型排行榜，先用 capability + health + billing 的可解释规则。

### P1-2：Provider 图标、favorite 与可用性分组

目标：提高 provider 可识别性，借鉴 Alma custom icon/favorite。

最小开发切片：

- 已完成第一版：`ModelProviderSettings` 增加 `icon`、`favorite` 可选字段。
- 已完成第一版：`ProviderListPanel` 支持 favorite pin，`ModelSwitcher` 支持 favorite group。
- 已完成第二版：设置页连接区支持内置短标识 picker，官方 provider 和动态 custom provider 都有 preset。
- 已完成第三版：设置页连接区支持上传/清除受限小图片图标，设置页列表、详情 Header、会话页模型菜单共享同一 `icon` 渲染逻辑。
- 已完成第四版：会话页模型菜单按 provider 健康状态排序并显示健康 badge，降级/不可用 provider 会排到健康 provider 后面。
- 已完成第五版：设置页会显示图片图标以内联 data URL 保存在本机 settings 中，并展示估算大小；用户能分清“本机识别标识”和“团队共享资产/官方身份”。
- 已完成第六版：provider 图标使用 `validateProviderIcon()` 统一校验，非法 data URL、非图片 data URL 或超过 96 KB 的图片会被拒绝并给出用户可见提示，保存层不会持久化无效图标。
- 已完成第七版：团队托管 provider 的 `displayName/icon` 由控制面下发，设置页禁用本机编辑，保存 helper 也会保留托管身份；favorite 仍作为本机偏好保存。
- 已完成第八版：本机 provider 图标资产目录落地，上传后 settings 保存 `provider-icon://local/...` 引用，渲染时再解析成小 data URL。
- 已完成第九版：本机 provider 图标资产写入 manifest，包含 provider、mime、size、hash、ownership 和时间戳，为后续同步提供稳定索引。
- 已完成第十版：manifest 增加 source/syncState/remoteId/lastSyncedAt；本机上传和团队/控制面同步资产可以在同一目录里被区分，旧 manifest 也会读成 local-only 默认值。
- 已完成第十一版：会话页模型菜单的 provider group 直接显示 provider 计费语义；`payg`、`plan/free`、`unknown` 分别解释成本路由、套餐/免费优先速度能力、未知保守处理，并有组件级 badge 渲染测试。
- 已完成第十二版：`ModelSwitcher` provider 分组排序使用 `sortProviderGroupsByModelStrategy()`，收藏优先和健康状态优先有 helper 级测试，不再只靠组件内联排序。
- 已完成第十三版：会话页 provider 健康状态使用 `ProviderHealthBadge` 组件，状态、tooltip 明细和不可用文案有静态渲染测试，避免 provider 可用性只停留在排序逻辑。
- 已完成第十四版：会话页 provider 来源标签使用 `ProviderSourceBadge` 组件，组件测试覆盖 source label、title 和空值不渲染，避免自定义图标掩盖 relay 身份。
- 已完成第十五版：会话页 provider header 增加协议/endpoint 身份 badge；runtime option/group 会透传 `providerProtocol`、`providerTransportLabel`、`providerEndpoint`，组件测试覆盖 OpenAI-compatible relay 的 tooltip 和空值不渲染。
- 后续可补：团队共享 provider 图标真实分发，以及云端文件级同步。
- provider source label 继续保留，避免自定义 icon 掩盖中转站身份。

验收：

- Settings helper 单测：icon/favorite 保存不影响默认模型；非法 provider 图标不会写入 settings 且有可读提示。
- Renderer：favorite group 排序、custom provider icon 展示、provider billing/health/source/transport badge 文案。

风险：

- 图标不能替代 provider 真实身份；中转站、官方、local、external engine 的 source label 必须保留。

### P1-3：Tool capability 与成本节省可视化

目标：让用户知道不同模型/provider 对工具调用质量的影响。

最小开发切片：

- 已完成第二版：在 `ModelDecisionEventData` / response diagnostics 里记录 tools enabled/disabled、MCP selected、programmatic tools available。
- 已完成第一版：如果某 fallback 模型不支持 tools，`model_fallback` notice 记录 `toolPolicy`，会话页显示“工具已关闭”和工具数变化。
- 已完成第一版验收补强：`FallbackBanner` 直接组件测试覆盖 `toolPolicy` 的 `originalToolCount → effectiveToolCount`、disabled tool 预览和 fallback trace 分组。
- 已完成第四版：token savings 的 `estimated` 状态带 `basis`，说明估算来源、工具数、预览工具数和字段范围；会话页 `RouteTraceChip` 展示这条估算依据。
- 已完成第五版：token savings 增加 `providerUsage` 快照，记录模型响应回传的 input/output/total tokens；会话页展示“用量”行，把真实 usage 和本地 saved-token 估算放在同一个策略面板里。
- 已完成第六版：token savings 增加 `measurement` 口径快照；会话页展示“计量”行，把 saved-token 来源、usage 来源和 provider-reported saved-token 是否存在拆开表达。
- 已完成第七版：执行模型不支持工具时，`RouteTraceChip` 直接说明本轮按纯文本执行，MCP / 程序化工具不会下发。
- 已完成第八版：`RouteTraceChip` 默认把 saved-token 解释为“本地估算少占上下文”，并在展开层显示“不等同 provider 账单节省”的边界说明，避免把 programmatic tool calling 的上下文优化误读成精确账单。
- 已完成第九版：provider-reported saved-token contract 打通；`usage.providerReportedSavedTokens` 存在时，runtime 产出 `tokenSavings.status=provider-reported`、`measurement.savingsSource=provider-reported` 和 `providerReport`，RouteTrace 展示 provider 回传并取消本地估算边界。
- 已完成第十版：新增 provider-reported saved-token acceptance smoke；本地 fixture 会证明 provider 回传差值、provider usage 和计量口径同时存在，且不会把 usage-only 或本地估算 basis 误认为 provider-reported saved tokens。
- 已完成第十二版：provider-reported saved-token acceptance smoke 增加手动 live response artifact 模式；真实 provider response 只有 usage 时会返回 blocked，只有明确 provider-reported saved-token 字段时才通过。
- 已完成第十三版：Xiaomi provider live smoke 可通过 `--provider-response-out <path>` 产出 tool-calling response artifact；凭证已从 `~/.code-agent/.env` 读取并跑通真实 Xiaomi tool-calling。
- 已完成第十四版：Xiaomi artifact builder 有单测覆盖，确保真实请求产物字段有界，且与 provider saved-token live-response validator 兼容。
- 已完成第十六版：summary 的 live boundary 会接受真实 Xiaomi usage-only artifact 作为“provider 不报告 saved-token”的通过证据，同时继续保证 usage-only 不会被误标为 provider-reported savings。

验收：

- Runtime 测试：fallback 模型不支持 tool 时事件字段正确。
- Renderer：展开层显示 tool policy、token savings 估算来源、provider usage、计量口径和非账单边界。
- Acceptance：`npm run acceptance:provider-saved-tokens -- --json` 验证 provider-reported saved-token contract；`npx vitest run tests/unit/scripts/xiaomiSmoke.test.ts` 验证 Xiaomi response artifact 有界且兼容 live-response validator；`set -a; source ~/.code-agent/.env; set +a; node scripts/acceptance/run-vite-acceptance.mjs scripts/acceptance/xiaomi-smoke.ts --provider-response-out /tmp/xiaomi-provider-response.json` 产出真实 provider artifact；`npm run acceptance:model-strategy-summary -- --codex-result /tmp/codex-cli-engine-smoke.json --xiaomi-live-response /tmp/xiaomi-provider-response.json --in-app-browser-model-strategy-ok --json` 验证真实 usage-only 响应被归为 provider capability boundary，而不是缺证据。

风险：

- token saved 很容易被误读为精确账单；没有可靠计量前只展示“估计/本轮节省”。

## 推荐执行顺序

1. P0-1 会话页 Model Decision 解释面。
2. P0-2 `main task model` 信息架构和文案。
3. P0-3 订阅/外部引擎可靠性状态。
4. P1-1 任务级模型推荐。
5. P1-2 provider 图标/favorite/可用性分组。
6. P1-3 tool capability 与成本节省可视化。

这个顺序的原因很简单：先让用户看懂系统已经做出的决策，再让系统主动推荐。否则推荐会变成黑盒，用户只会看到模型被换了，却不知道系统在保护质量、成本还是速度。

## 验收总表

| 能力 | 验收方式 |
| --- | --- |
| 决策可解释 | `modelDecision.test.ts`、`inference.modelDecision.test.ts`、`useConversationStreamEffects.test.ts`、`useTurnProjection.test.ts`；provider identity 覆盖 source/protocol/endpoint 不被 stream normalizer 或 projection 去重丢失 |
| 会话页展示 | `TraceNodeRenderer` / `RouteTraceChip` renderer tests；复杂度分显示为规则估计而不是模型质量评分；provider health 显示为最近窗口且标注非实时 SLA；`acceptance:model-strategy-surface` 覆盖 billing、provider identity 和主任务模型 tooltip；外部 engine failure trace 默认展开 |
| 任务级推荐 | `chatInput.modelStrategyRecommendation*.test.ts` 覆盖推荐生成、渲染、点击和副作用；provider 降级/不可用推荐会按本轮任务能力筛选候选，图片任务不会切到无视觉候选，简单任务优先健康快模型，dismiss key 带任务类型和输入片段；apply/dismiss feedback 只发送隐私有界 task signal，不带完整 prompt；Codex Browser 手验通过真实页面采用自动策略和 external failure 切回 Native；`test:e2e:model-strategy` 历史通过采用自动策略，新补 external failure 切回 Native spec；当前沙箱运行被 Chromium Mach port 权限挡住，默认失败已明确归类为环境门槛，当前验收接受 in-app Browser 证据 |
| fallback 可见 | `npm run acceptance:model-strategy-fallback -- --json` 覆盖 `model_fallback` banner 的 strategy mode、from/to provider identity、tried/skipped/selected/exhausted trace、工具关闭提示，以及即时 `ProviderStatusNotice` toast 与 banner 使用同一套策略标签 |
| billing 语义 | `npm run acceptance:model-strategy-surface -- --json` 覆盖 payg/plan/unknown 三类 RouteTrace billing 语义、plan/unknown 保守解释和 `ModelSwitcher` provider group 计费 badge |
| provider health / identity | `npm run acceptance:model-strategy-surface -- --json` 覆盖 provider health badge、source label 不被图标遮蔽、协议和 endpoint tooltip；`ModelSwitcher` provider group 排序测试继续覆盖 favorite 优先和健康状态顺序 |
| external engine | mock descriptor：missing/auth/quota/available/tool-limited；TraceNodeRenderer 覆盖 auth failure 默认展开和 HTTP/exit/suggestion 可见 |
| 验收汇总 | `npm run acceptance:model-strategy-summary -- --codex-result /tmp/codex-cli-engine-smoke.json --xiaomi-live-response /tmp/xiaomi-provider-response.json --in-app-browser-model-strategy-ok --json` 通过本地 Vite acceptance runner 聚合离线合同、Codex CLI live smoke、Xiaomi live artifact、fallback visibility、surface billing/identity、task recommendation capability contract 和 Browser 手验证据；真实 Xiaomi usage-only 会被标为 provider capability boundary passed，不再显示为缺依赖或缺 live evidence |

## 主要风险

- 过度解释会让会话页变重。默认一句话，展开看细节。
- 模型推荐如果越过用户显式选择，会破坏控制感。显式选择必须优先，自动模式才允许策略切换。
- provider health 是窗口统计，不代表 SLA。UI 要表达“最近状态”，避免承诺。
- billingMode 来自用户配置，可能不准。unknown 要保守，不做省钱路由。
- Claude subscription CLI 链路仍只是 Alma 对标风险面，不能代表当前实现目标阻断；当前外部 CLI engine 的 live 验收走 Codex CLI，并已拿到通过态。Claude 的 401 auth failure 仍保留为订阅链路失败归因证据。
- provider icon/favorite 容易把身份包装得太像官方。source label 和 endpoint 信息不能藏。

## 当前不建议做的事

- 不先重写 ModelRouter。现有策略底座够用，先把解释面补起来。
- 不把 subscription CLI 塞进普通 API Key provider 表单。它是运行链路，不只是 endpoint/key。
- 不做全自动模型推荐切换。先提示、解释、让用户确认。
- 不扩大到完整 provider marketplace。Alma 这轮值得借鉴的是会话页策略表达，provider 数量本轮收益不高。
