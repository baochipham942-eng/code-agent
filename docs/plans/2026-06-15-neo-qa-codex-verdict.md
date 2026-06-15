**总判**

只读核对完成，没改文件。5 个 topic 里：Topic5 可以过，Topic1/2/4 需要收敛后再做，Topic3 按原方案应 REJECT。

| Topic | 裁决 | 核心判断 |
|---|---:|---|
| Topic1 Channel privacy | 收敛建议 | 根因方向对，但 persistence 路径讲得不够准，不能全局粗暴改 attachment persistence |
| Topic2 Slash hotkey | 收敛建议 | bug 成立，但 blanket composer scope guard 会误伤 `composer.focus` |
| Topic3 Model strategy vision | REJECT | 原方案混淆 modelDecision 层和 runtime vision fallback，且“explicit model priority”缺少现有代码信号 |
| Topic4 CI gates | 收敛建议 | 漏洞成立，但 path-filter 不能继续放在 required workflow 触发层 |
| Topic5 Shell capabilities | PASS | 5 个 action 缺 manifest 映射属实，最小修法成立 |

**Topic1: Channel Privacy**

裁决：收敛建议。

方案抓到的主漏洞成立：[ChannelAttachment](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/channel.ts:73) 确实有 `localPath`、`platformFileKey`、`metadata`，而 [sanitizeChannelAttachments](/Users/linchen/Downloads/ai/code-agent/src/main/channels/privacy/channelPrivacyFirewall.ts:105) 用 spread 复制后只处理了 `name/url/thumbnailUrl/data`，这些新字段会原样穿过去。转写链路也确实会把 transcript 写进 attachment metadata：[channelAgentBridge.ts](/Users/linchen/Downloads/ai/code-agent/src/main/channels/channelAgentBridge.ts:556)。

需要修正的事实点：进入持久化以后，channel 的 `localPath` 会被 [convertAttachments](/Users/linchen/Downloads/ai/code-agent/src/main/channels/channelAgentBridge.ts:715) 转成 `MessageAttachment.path`，再由 [sanitizeAttachmentForPersistence](/Users/linchen/Downloads/ai/code-agent/src/shared/utils/messageAttachments.ts:57) 保存。验收如果只盯 `ChannelAttachment.localPath` 会漏掉真正落库字段 `path` 和 `metadata`。

副作用风险在 persistence 层。`sanitizeAttachmentForPersistence` 现在服务所有消息附件，直接全局去掉 path/metadata 可能破坏本地用户附件、appshot 以外的正常文件引用。更稳的修法是给 channel-origin 附件单独走 `sanitizeChannelAttachmentForPersistence`，或者把 privacy mode / origin 显式传进去。

测试要补三类：channel sanitizer 直接测新增字段，转写 enrichment 后测 transcript 不落 `metadata`，落库 metadata 测 `MessageAttachment.path/metadata`。只测 firewall happy path 不够。

**Topic2: Slash Hotkey**

裁决：收敛建议。

问题成立。[composer.slashMenu](/Users/linchen/Downloads/ai/code-agent/src/shared/keybindings/actions.ts:88) 默认绑定 `/`，document 级 [handleKeyDown](/Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useKeyboardShortcuts.ts:482) 会先跑 `runAction`，而 [runAction](/Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useKeyboardShortcuts.ts:332) 对 slashMenu 没 input guard，随后 preventDefault。结果是普通输入框里敲 `/` 也可能被截走。

但“composer scope 只有 composer focused 才执行”不能一刀切。`composer.focus` 同样是 composer scope：[actions.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/keybindings/actions.ts:78)，它的目的就是从外部聚焦 composer。按 scope blanket 拦截会把这个正向能力修没。

更简单的修法：document shortcut 对 bare `/` 在 input/contentEditable 里直接返回 false，让真实输入先发生；ChatInput 自己已经在 [handleValueChange](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/features/chat/ChatInput/index.tsx:544) 根据尾部 slash token 打开菜单。`app:openSlashMenu` 可以保留给按钮或显式命令，不要覆盖非空文本。[handleOpenSlashMenu](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/features/chat/ChatInput/index.tsx:230) 也要避免把 `hello` 改成 `/`。

验收要覆盖：composer 空输入敲 `/` 后文本仍是 `/` 且菜单打开，非 composer input 敲 `/` 不被 preventDefault，已有文本尾部 slash 不被覆盖，slash 菜单打开后 Enter/Arrow 的 capture 行为还在。

**Topic3: Model Strategy Vision**

裁决：REJECT。

代码里的局部问题成立：在 task strategy manual 模式下，[resolveModelDecision](/Users/linchen/Downloads/ai/code-agent/src/main/model/modelDecision.ts:496) 把 intent 固定为 `coding`，不会走 [inferStrategyIntent](/Users/linchen/Downloads/ai/code-agent/src/main/model/modelDecision.ts:259) 的 vision 分支。

但方案把根因说大了。运行时还有能力检测和 vision preflight/fallback：[inference.ts](/Users/linchen/Downloads/ai/code-agent/src/main/agent/runtime/contextAssembly/inference.ts:1166) 会检测 vision capability，[inference.ts](/Users/linchen/Downloads/ai/code-agent/src/main/agent/runtime/contextAssembly/inference.ts:1203) 会跑 vision preflight，adaptive 允许时还能 model fallback。原文说“manual + image silently sent to text model”作为全链路结论不准确。

“explicit specified model priority over auto”也缺少实现基础。当前 `requestedConfig.adaptive !== true` 已经直接返回 user-selected：[modelDecision.ts](/Users/linchen/Downloads/ai/code-agent/src/main/model/modelDecision.ts:486)。如果 adaptive=true，就没有字段能区分“用户刚手选的模型”和“默认 base config”。方案没说明这个信号从哪里来，按原文实现容易把 auto 设计打乱。

另外，`ModelDecision` contract 没有泛化 diagnostics 字段：[modelDecision.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/modelDecision.ts:227)。要做 manual + vision 推荐，需要先设计 typed field 或事件，不能笼统写“落到 diagnostics/decision”。

更正确的方案：先定义三种状态的优先级：auto strategy vision、manual profile with vision-capable current model、manual profile lacking vision capability。只在第三种给非侵入式推荐，并避免和 runtime preflight/fallback 重复提示。测试必须保住 auto + image 仍走 vision profile。

**Topic4: CI Capability Gates**

裁决：收敛建议。

事实判断成立。[capability-evidence.yml](/Users/linchen/Downloads/ai/code-agent/.github/workflows/capability-evidence.yml:6) 和 [eval-harness-gate.yml](/Users/linchen/Downloads/ai/code-agent/.github/workflows/eval-harness-gate.yml:5) 都明确是 path-triggered，且 [swarm-ci.yml](/Users/linchen/Downloads/ai/code-agent/.github/workflows/swarm-ci.yml:52) 没把它们并进去。仓库里也没看到 branch protection / ruleset as code。

需要收敛的是 path filter 的位置。required gate 不能继续依赖 workflow-level `on.pull_request.paths`，否则没命中的 PR 可能根本不产出 required check。path filter 可以放在 job 内部，让 job 总是有结论：需要跑就跑，不需要跑也显式 pass。

验收方案里“改 locked deliverable 但不触发 gate path”这个例子要重选。很多 locked deliverable 本来就在现有 paths 里，会触发旧 gate，测不出漏洞。应该选真实依赖但不在旧 paths 里的文件，或者更直接地断言 `swarm-ci` 的必跑 job 总是产出 capability/eval gate 状态。

“required-as-code”也要说清楚。GitHub 不会自动读 repo 里的普通 YAML 当 branch protection。要么接 ruleset API/Terraform，要么就只能称为“documented requirement + CI self-check”。

**Topic5: Shell Capabilities**

裁决：PASS。

5 个缺口与代码吻合。renderer 侧确实调用了：

- `project/artifactIssues`、`project/setDescription`：[projectClient.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/services/projectClient.ts:34)
- `settings/saveProviderIconAsset`、`settings/resolveProviderIconAsset`：[providerIconAssets.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/utils/providerIconAssets.ts:28)
- `memory/memoryEntryUpdate`：[TurnQualityStrip.tsx](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/features/chat/TurnQualityStrip.tsx:119)

main handler 也存在：[project.ipc.ts](/Users/linchen/Downloads/ai/code-agent/src/main/ipc/project.ipc.ts:108)、[settings.ipc.ts](/Users/linchen/Downloads/ai/code-agent/src/main/ipc/settings.ipc.ts:306)、[memory.ipc.ts](/Users/linchen/Downloads/ai/code-agent/src/main/ipc/memory.ipc.ts:836)。缺的是 [CAPABILITY_DOMAIN_ACTIONS](/Users/linchen/Downloads/ai/code-agent/src/main/shellCapabilities.ts:46) 里的 manifest 映射。

最小修法“加 5 个 action”成立，风险低。测试还应加一条反向约束：manifest 里声明的 action 至少要能在对应 IPC handler 里找到，避免以后出现“能力声明存在但 shell 实际不处理”的假阳性。现有 [renderer-capability-scanner](/Users/linchen/Downloads/ai/code-agent/scripts/renderer-capability-scanner.mjs:12) 只证明 renderer 需要什么，不证明 handler 和 manifest 双向一致。

**事实错误清单**

- Topic1：持久化风险不只在 `ChannelAttachment.localPath`，实际落库字段会变成 `MessageAttachment.path`。
- Topic2：把 composer scope 当成统一 focus guard 会误伤 `composer.focus`。
- Topic3：manual strategy 层确实不会选 vision，但全 runtime 还有 vision preflight/fallback；“静默送到 text model”不是完整事实。
- Topic3：`ModelDecision` 当前没有通用 diagnostics 字段。
- Topic4：workflow-level path filter 不能作为 required gate 的保留方式。
- Topic5：没发现与代码不符的事实错误，主要是测试矩阵还可以补强。


