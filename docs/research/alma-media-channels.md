# Alma Media & Channels 对标研究

> 日期：2026-06-13
> 范围：只研究 Alma v0.0.805-v0.0.823 在会话页交付质量上的媒体输入、图片/附件、Feishu/Lark 渠道会话和外部渠道 UX；不涉及产品功能开发。
> 资料：`/tmp/alma-update-20260613/release-notes-805-823.md`，Alma old renderer `index-DZO6LH4W.js`，Alma new renderer `index-lrtJ1hZ1.js`，code-agent 当前源码。

---

## 1. 核心判断

Alma 这一轮最有价值的方向，是把“媒体输入”和“外部渠道消息”当成会话交付质量的一部分处理。它连续补了来源绑定、状态降噪、失败恢复、渠道回执、短错误和主进程减负，价值已经超过单个语音按钮或图片上传按钮。

对 code-agent 来说，底层能力并不弱：已有 Appshots、图片附件、音视频附件、PPT/压缩包摘要、本地 STT 工具、Feishu/Telegram/HTTP API 通道、IngressPipeline、Telegram typing。真正的差距在产品接线上：

| 方向 | code-agent 现状 | 对标后的判断 |
|---|---|---|
| 桌面会话输入 | 文本、图片、文件、Appshot、语音输入都有 | 缺统一的媒体生命周期状态，附件多是“选中后直接进入消息” |
| 音频 | 输入框语音走 Groq Whisper；工具层有本地 `local_speech_to_text`；后台音频有 whisper-cpp/Qwen3-ASR | 外部渠道语音没有自动下载、转写、绑定到会话消息 |
| 图片/附件 | 图片、PDF、Excel、PPT、压缩包、音视频契约已扩展；Appshot 已做会话绑定和隐藏 XML | 普通上传、渠道图片、生成图、编辑图之间缺统一 provenance、占位、失败恢复 |
| Feishu/Lark | 当前注册的是 `feishu`，支持 webhook/WS、text/post/image 占位、编辑/卡片/reaction | 没有 Lark 独立连接、没有语音消息、没有真实图片下载、没有 Feishu typing |
| 状态体验 | `StreamingIndicator` 已有“低噪音、长工具才浮现”的理念；IngressPipeline 有 debounce/lock | 渠道输出仍可能把内部错误和进度直接变成用户可见噪音 |

优先级应该是：P0 先把 Feishu 媒体下载、语音 STT、短错误、去重、typing/低噪音状态打通；P1 再做 Lark 独立连接、图片生成/编辑状态统一、多图编辑 fallback 和更完整的媒体 provenance。

---

## 2. Alma 事实提炼

### 2.1 版本线索

| 版本 | 变化 | 质量含义 |
|---|---|---|
| v0.0.807 | 图片处理和截图工作移出主进程 | 媒体路径不能拖慢整个 app |
| v0.0.808 | local gallery cache 图片发送前自动嵌入 | 本地缓存图片必须在发送边界前变成模型可读内容 |
| v0.0.814 | 图片生成 placeholder 只出现在正确 chat thread；图片编辑可 fallback 到之前生成图；多图编辑修复 | 生成/编辑图必须有 turn/thread 归属和失败恢复 |
| v0.0.818 | Feishu/Lark 连接流改为 lark-cli QR sign-in；同时支持 Feishu 和 Lark | 国内飞书和国际 Lark 是两个产品入口，不应混成一个配置 |
| v0.0.820 | Feishu/Lark voice messages 自动下载和 STT；Feishu typing indicator；减少 progress spam；避免重复回复；错误只发短摘要 | 渠道交付质量重点在少打扰、可感知、可恢复 |
| v0.0.823 | 减少主进程和 DB 慢路径，移除重 base64 处理 | 媒体和 base64 不应进入性能关键路径 |

### 2.2 renderer 证据

Alma new renderer 里能看到几类会话页能力：

- `SpeechInputAction`：录音、Whisper 初始化、音量可视化、转写后把 transcript 追加回 composer。
- `ChatComposer`：附件可作为 submit 条件；图片附件以 file part 进入 optimistic message；非图片文件路径以 text part 表达。
- `filePartsToAttachments`：从 message file parts 反推 composer attachments，说明附件可从历史/待发送状态恢复。
- Appshot/截图进入 composer 时，新 renderer 会尝试 `apiClient.uploadAttachmentImage(bytes)`，拿到 URL 后再作为 attachment；失败时保留 data URL fallback。旧 renderer 在同一位置只用 data URL。
- chat 事件处理按 `threadId` 过滤 `tool_analysis_progress`、`skill_analysis_progress`、`memory_retrieval_progress`、`skill_extraction_progress`，说明进度状态不能串到别的 thread。
- `TypingIndicator` 和 todo progress 都在会话层，但 v0.0.820 的 Feishu typing 更关键：外部渠道也需要“正在准备回复”的轻信号。

这些证据说明 Alma 的前端把媒体放进了消息归属、恢复、可见状态和降级路径的闭环里，远远超过一次性上传。

---

## 3. Alma 的媒体与渠道交付模型

### 3.1 媒体输入进入会话前先被正规化

Alma 对图片、截图、gallery cache、语音都在发送前做“可读化”：

- gallery cache 图片发送前自动嵌入，避免模型收到本地不可访问引用。
- 截图/Appshot 会尝试上传成 URL，失败再退回 data URL。
- 语音进入上下文前，Feishu/Lark 会先自动下载音频，再做 STT。
- 图片编辑会在缺输入图时 fallback 到前一张生成图，多图编辑也作为 first-class 场景处理。

对 code-agent 的启发：所有入口都应该落到统一的 `MessageAttachment` 加 `mediaState`，包括桌面上传、Appshot、渠道文件、生成图和编辑图。

### 3.2 状态表达低噪音

Alma v0.0.820 明确减少 Feishu progress spam，同时增加 typing indicator。这个组合很关键：

- 用户需要知道“系统在准备”，不需要看到每个内部阶段。
- progress 应该只留在桌面会话页或内部 trace；外部 IM 只发少量状态。
- 长任务可用 typing、reaction、短占位卡片表达；不要连续发多条“正在处理第 N 步”。

code-agent 已有 `StreamingIndicator` 的设计理念：大部分时间只显示一个呼吸光标，只有长工具运行才浮现“执行中”。这套原则可以直接下沉到 ChannelResponseCallback。

### 3.3 失败恢复是会话质量的一部分

Alma 处理失败时会把失败边界收窄，避免把内部错误完整扔给用户：

- 图片上传失败后退回 data URL。
- 图片编辑缺图时回退到前一张生成图。
- 外部渠道错误只发短摘要，完整 stack 不进入 IM。
- 避免重复回复，说明同一 platform message 必须有幂等处理。

code-agent 目前在 `channelAgentBridge.ts` 出错时会直接发送 `处理失败: ${errorMsg}`，`channelManager.sendErrorResponse()` 给外部通道的内容是 `错误: ${errorMessage}`。这对调试有用，但对 IM 用户过长、过内部。

### 3.4 渠道会话要独立于桌面设置

v0.0.820 的“Voice transcription in Feishu no longer depends on the desktop Whisper setting”很重要。渠道消息是远端入口，不能因为桌面 composer 的开关或本地 UI 设置而不可用。它应该有自己的媒体下载、STT、隐私和错误策略。

code-agent 目前：

- composer 语音按钮用 `ipcService.transcribeSpeech()`，实际走 Groq Whisper。
- 工具层 `local_speech_to_text` 用 whisper-cpp 和 ffmpeg，适合模型主动处理音频文件。
- `DesktopAudioCapture` 有 whisper-cpp -> Qwen3-ASR fallback。

这些能力需要抽一个渠道可调用的 ASR service，Feishu 语音不适合绕到 composer 语音按钮。

---

## 4. code-agent 当前能力盘点

### 4.1 会话输入和附件

关键文件：

- `src/renderer/components/features/chat/ChatInput/index.tsx`
- `src/renderer/components/features/chat/ChatInput/useFileUpload.ts`
- `src/renderer/components/features/chat/ChatInput/AttachmentBar.tsx`
- `src/renderer/components/features/chat/MessageBubble/AttachmentPreview.tsx`
- `src/shared/contract/message.ts`
- `src/shared/utils/messageAttachments.ts`
- `src/main/agent/messageHandling/converter.ts`
- `docs/designs/attachments.md`

已有能力：

- `MessageAttachment.category` 支持 image/audio/video/pdf/excel/presentation/archive/code/text/data/document/html/folder/other。
- `useFileUpload` 上传时能解析 PDF、DOCX、Excel、PPT、ZIP，图片读 data URL，音视频也读 data URL。
- `AttachmentBar` 和 `AttachmentPreview` 已能显示图片缩略图、音频播放器、视频播放器、PPT 简要页数、压缩包清单。
- `buildMultimodalContent()` 会把图片转成 image content；非视觉模型降级时提示用 `image_analyze`，音频/视频只给元数据并提示可用 `speech_to_text/local_speech_to_text`。
- `sanitizeAttachmentsForPersistence()` 会剥离部分大 data URL，避免 DB 长期沉淀重二进制。

短板：

- 附件没有统一的上传/嵌入/转写/失败/retry 状态模型。
- 音频附件默认只是“可转写提示”，不会自动生成 transcript。
- 普通图片、Appshot、渠道图片、生成图 artifact 的来源和归属没有统一展示。
- tests 里 `channelMessageReply.test.ts` 的附件转换测试还停留在“非 image 都映射为 file”的简化逻辑，与当前 `getAttachmentCategory()` 已经不完全同步。

### 4.2 Appshot 和图片上下文绑定

关键文件：

- `src/shared/contract/appshot.ts`
- `src/renderer/stores/appshotsStore.ts`
- `src/renderer/hooks/useAppshots.ts`
- `docs/designs/appshots.md`

已有能力：

- Appshot capture 有 `pendingSessionId` 和 `startingSessionId`，异步读图期间切会话也不串台。
- 发送时 `buildAppshotXml()` 把 AX/OCR 文本作为隐藏 `<appshot>` 注入，`buildAppshotAttachment()` 把截图作为图片附件随消息发送。
- 渲染层剥离 `<appshot>`，用户看到干净消息，模型看到图和文本。

短板：

- Appshot 这套“来源绑定 + 隐藏上下文 + session 防串台”还没有扩展到普通上传、渠道图片和生成图。
- Appshot 附件目前依赖 screenshot data URL，缺 Alma 那种先上传成 URL、失败再 fallback 的统一策略。

### 4.3 语音和 STT

关键文件：

- `src/renderer/components/features/chat/ChatInput/VoiceInputButton.tsx`
- `src/renderer/hooks/useVoiceInput.ts`
- `src/main/ipc/speech.ipc.ts`
- `src/main/tools/modules/network/localSpeechToText.ts`
- `src/main/services/desktop/desktopAudioCapture.ts`

已有能力：

- Composer 语音按钮能录音，最长 60 秒，转写后追加到输入框。
- `speech.ipc.ts` 用 Groq Whisper，带大小校验、短音频校验、Whisper 幻觉过滤。
- `local_speech_to_text` 工具使用本地 whisper-cpp，必要时 ffmpeg 转 16kHz mono WAV。
- `DesktopAudioCapture` 已有 whisper-cpp 与 Qwen3-ASR fallback，并发 ASR 队列。

短板：

- 这三套 ASR 能力分散，渠道层没有一个稳定可调用的 `transcribeAudioFile()` service。
- Composer STT 依赖 Groq Key，渠道语音若复用它会把远端 IM 能力绑到桌面输入设置和云 API 上。
- 渠道语音没有 transcript 状态、失败状态和原始音频保留策略。

### 4.4 外部渠道

关键文件：

- `src/shared/contract/channel.ts`
- `src/main/channels/channelInterface.ts`
- `src/main/channels/channelManager.ts`
- `src/main/channels/channelAgentBridge.ts`
- `src/main/channels/ingressPipeline.ts`
- `src/main/channels/feishu/feishuChannel.ts`
- `src/main/channels/telegram/telegramChannel.ts`
- `src/renderer/components/features/settings/tabs/ChannelsSettings.tsx`

已有能力：

- `ChannelAttachmentType` 已支持 `image | file | audio | video | link`。
- `ChannelManager` 当前注册 `http-api`、`feishu`、`telegram`。
- `IngressPipeline` 有 debounce、session lock、有界队列，适合减少连续消息噪音和同会话并发混乱。
- `ChannelAgentBridge` 会为每个 `accountId:chatId` 创建专门 channel session，session origin 标记为 `kind: 'channel'`。
- Telegram 有 typing 状态续期，收到消息后立刻 `sendChatAction('typing')`，发送真实回复前停止。
- Feishu 有 webhook/WS 接收、text/post/image 解析、sendMessage、editMessage、deleteMessage、reaction、card、streamingMessage 模拟。

短板：

- Feishu `message_type` 只识别 text/post/image/interactive，没有 audio/file 等媒体消息。
- Feishu 图片只保留 `image_key` 作为 `url`，注释也写着“需要通过 API 获取真实 URL”，当前没有下载成模型可读内容。
- 没有 Lark 独立账号类型和区域配置。
- Feishu 没有 typing/presence 回调。
- 错误回复直接带内部错误内容，不够短。
- 缺对同一平台 message 的持久幂等记录，进程重启或 webhook 重投时仍可能重复处理。

---

## 5. 差距矩阵

| 能力 | Alma | code-agent | 差距 |
|---|---|---|---|
| Feishu/Lark 分离 | v0.0.818/v0.0.820 分开 Feishu 和 Lark International | 只有 `feishu` 类型 | 需要 `lark` 账号类型或 region 字段 |
| 渠道语音 | 自动下载 voice message 并 STT | 通道契约能表示 audio，Feishu 未解析和下载 | P0 差距 |
| 渠道 STT 独立性 | 不依赖桌面 Whisper 设置 | ASR 能力分散，渠道没有 service | P0 差距 |
| Typing indicator | Feishu typing | Telegram 有，Feishu 无 | 可复用 ChannelResponseCallback 模式 |
| Progress 降噪 | 明确减少 Feishu spam | Ingress 可合并入站，出站仍无渠道进度策略 | 需要出站低噪音策略 |
| 错误短摘要 | 外部错误只发 summary | `处理失败: ${errorMsg}` / `错误: ${errorMessage}` | 需要外部错误 sanitizer |
| 重复回复 | 修复 Feishu duplicate replies | 有 bot loop 防护和新增消息提取测试，缺 webhook 幂等 | 需要 processed message ledger |
| gallery cache 图片嵌入 | 发送前自动嵌入 | 上传图片读 data URL；Appshot 发 data URL | 需要统一 materialize/upload/fallback |
| 图片 placeholder 归属 | 正确 chat thread | Appshot 有 session 绑定；生成图状态未统一 | P1 补 turn/thread ownership |
| 图片编辑 fallback | 缺图时用之前生成图 | 有 image_generate/image_annotate/image_process 工具，未见会话级 fallback 契约 | P1 补产品规则 |
| 多图编辑 | 已修复 | 底层工具需核对多输入支持，UI 未统一 | P1 |
| 主进程减负 | 图片/截图移出主进程，base64 从关键路径移除 | Appshot 事件只带路径，附件持久化有瘦身；上传仍有 data URL 路径 | 继续收敛大 base64 |

---

## 6. 可借鉴设计

### 6.1 统一媒体输入信封

建议引入一个内部媒体信封，不一定直接落库：

```ts
type MediaInputOrigin =
  | { kind: 'composer'; sessionId: string }
  | { kind: 'appshot'; sessionId: string; requestId: string; appName: string }
  | { kind: 'channel'; accountId: string; platform: 'feishu' | 'lark' | 'telegram' | 'http-api'; chatId: string; messageId: string; fileKey?: string }
  | { kind: 'tool'; sessionId: string; turnId?: string; toolCallId: string };

type MediaMaterializationState =
  | 'pending'
  | 'downloading'
  | 'embedded'
  | 'transcribing'
  | 'ready'
  | 'failed';
```

它负责把不同来源转成 `MessageAttachment`，并保留 origin、thread/session、平台 message id、download/transcript 状态。最终可以继续复用现有 `MessageAttachment`，但会话页和渠道桥有足够信息展示和恢复。

### 6.2 渠道状态只显示必要信号

外部 IM 的状态策略：

- 入站连续消息：继续用 `IngressPipeline` debounce。
- 处理开始：发 typing 或 reaction，不发文本进度。
- 超过阈值：最多一条短提示，例如“还在处理，完成后回复”。
- 完成：发送最终答复。
- 失败：发送短摘要，完整错误写日志和 session trace。

Telegram 已经有 typing 实现，Feishu 可以补同等接口。若 Feishu typing API 受权限或版本限制，降级为静默处理，不用发“处理中”文本刷屏。

### 6.3 渠道语音走本地 ASR service

不要让 Feishu/Lark 语音依赖 composer 的 Groq Whisper。更稳的做法：

1. Feishu/Lark 收到 voice/audio/file event。
2. connector 用平台 file API 下载到本地临时 media cache。
3. 调用共享 `transcribeAudioFile()`，默认本地 whisper-cpp，失败再按设置考虑 Qwen3-ASR 或云端 fallback。
4. 构建 ChannelMessage：
   - `content` 包含短文本：`[语音转写]\n<transcript>`。
   - `attachments` 保留音频文件路径、MIME、大小和 transcript metadata。
5. 模型上下文既有 transcript，也知道原始音频路径可复核。

### 6.4 图片/生成图归属按 session + turn + message 绑定

Alma v0.0.814 的教训适用于 code-agent：

- 图片生成 placeholder 必须绑定当前 session/turn/toolCallId。
- 任何异步图片结果回来时先核对 session 和 turn，没有命中则只入 artifact，不改当前消息状态。
- 图片编辑默认输入图来源应可解释：用户本轮上传图、当前 turn 生成图、最近一次生成图。fallback 必须在 trace 中可见。
- 多图编辑要把输入图列表作为 first-class 参数，不用从消息文本里猜。

### 6.5 短错误和长错误分流

外部渠道错误建议分两层：

- 用户可见：`处理失败：模型超时，请稍后重试。`
- 本地 trace/log：stack、provider response、platform message id、account id、session id。

这能保留排障能力，同时避免把 stack trace、token、路径或实现细节发到 IM 群里。

---

## 7. P0 开发切片

### P0-1 Feishu 媒体下载与附件物化

目标：Feishu image/file/audio 进入 Agent 前变成可读 `MessageAttachment`，不再只传 `image_key`。

改动范围：

- `src/main/channels/feishu/feishuChannel.ts`
- 新增 Feishu media downloader service，例如 `src/main/channels/feishu/feishuMedia.ts`
- `src/main/channels/channelAgentBridge.ts`
- `tests/unit/channels/*`

要点：

- 扩展 `FeishuMessageType`，覆盖音频/文件类消息。
- 用 Lark SDK 下载 file/image/voice 到本地 cache，记录 MIME、size、local path。
- 图片可生成 data URL 或本地 path；音频只保留 path，交给 P0-2 转写。
- 隐私层保留现有默认：raw payload 脱敏，附件 data 不落 raw。

验收：

- 单测模拟 Feishu image event，输出 `ChannelMessage.attachments[0].type === 'image'`，且 bridge 转换后模型可收到图片 data 或 path。
- 单测模拟 voice/audio event，输出 audio attachment，包含本地 path、mimeType、size。
- 下载失败时消息内容包含短提示，处理继续，不让整个通道崩。

### P0-2 渠道语音自动 STT

目标：Feishu/Lark 语音消息进入 channel session 时自动带 transcript。

改动范围：

- 抽共享 ASR service，例如 `src/main/services/media/audioTranscriptionService.ts`
- 复用 `local_speech_to_text` 的 whisper-cpp/ffmpeg 核心逻辑，避免工具层和渠道层复制实现。
- `FeishuChannel` 或 `ChannelAgentBridge` 在入队前完成转写。

要点：

- 默认本地 whisper-cpp，避免把远端 IM 音频送到云端。
- 转写失败时保留音频附件，content 只写“语音转写失败，可稍后重试”。
- transcript 要作为文本进入 `message.content`，也可写入 attachment metadata。

验收：

- 用 fake downloader 产出短 wav，单测确认最终 `orchestrator.sendMessage()` 收到 `[语音转写]` 文本。
- whisper-cpp 不存在时返回短失败摘要，不发 stack。
- 同一音频不会重复转写两次，至少在同一处理周期内缓存结果。

### P0-3 外部渠道低噪音状态和 Feishu typing

目标：渠道处理时有“正在准备”的轻信号，内部 progress 不刷屏。

改动范围：

- `ChannelResponseCallback` 增加可选 `startTyping/stopTyping` 或 `withTyping()`。
- `TelegramChannel` 复用已有 `startTyping/stopTyping`。
- `FeishuChannel` 实现 typing 或受限降级。
- `ChannelAgentBridge.handleSyncMessage()` 用统一生命周期包裹。

要点：

- typing 开始失败必须静默，不影响回复。
- 除最终结果和短错误，不向 IM 发工具进度文本。
- 长任务超过阈值时最多发一条中性提示，且可配置关闭。

验收：

- fake channel callback 记录 start/stop 顺序：收到消息 -> startTyping -> sendText 前 stopTyping。
- 异常路径也会 stopTyping。
- 模拟多个 tool progress event，不产生多条 sendText。

### P0-4 渠道错误短摘要

目标：外部渠道不再收到完整内部错误。

改动范围：

- `ChannelAgentBridge.sendErrorResponse()`
- `ChannelManager.sendErrorResponse()`
- 新增 `summarizeChannelError(error, surface)`。

策略：

- 超时：`处理超时，请稍后重试。`
- 权限：`缺少必要权限，请在桌面端处理。`
- 模型/API：`模型服务暂时不可用。`
- 其他：`处理失败，已记录本地日志。`

验收：

- 单测传入 stack trace，sendText 内容不包含 stack、路径、token、provider raw body。
- 本地 logger 仍保留完整错误。

### P0-5 渠道消息幂等处理

目标：同一 platform message 不重复触发 agent 回复。

改动范围：

- `IngressPipeline` 或 `ChannelAgentBridge`
- 可新增 processed ledger：`accountId + platformMessageId -> status`

要点：

- 至少内存 TTL；更稳是持久化到 channel inbox/outbox。
- 状态包含 `processing/completed/failed`，重投时按策略忽略或返回已处理。
- 不影响用户真正连续发两条不同消息。

验收：

- 同一 `FeishuMessageEvent.message_id` 重复投递两次，只调用一次 `orchestrator.sendMessage()`。
- 失败后是否允许 retry 要明确，可先支持手动 retry，不自动重复。

---

## 8. P1 开发切片

### P1-1 Feishu 和 Lark 独立连接

目标：把国内飞书和国际 Lark 的账号、文案、endpoint、登录方式分开。

方案：

- 轻量方案：`FeishuChannelConfig` 增加 `region: 'feishu' | 'lark'`，Settings 显示两个模板。
- 更清晰方案：`ChannelType` 增加 `'lark'`，共享 `LarkLikeChannel` 基类，Feishu/Lark 分别注册。

验收：

- Settings 能分别添加 Feishu 和 Lark 账号。
- 两个账号能同时存在，不共享错误状态。
- session title/source 能区分来源。

### P1-2 图片/附件生命周期 UI

目标：会话页展示 pending/downloading/embedded/transcribing/failed/retry，不再只显示静态附件卡。

方案：

- 给 attachment 增加可选 `state` 或在 renderer store 维护 transient media state。
- 上传、Appshot、渠道下载、STT 都通过同一状态映射。
- 失败可 retry；retry 不改变原始 message id，只更新状态和结果。

验收：

- renderer 测试覆盖图片下载中、语音转写中、失败重试三个状态。
- 切会话后异步完成不会把状态写到错误 session。

### P1-3 生成图和编辑图的归属与 fallback

目标：生成图 placeholder、编辑图输入来源、多图编辑都有可解释的规则。

方案：

- image tool result metadata 包含 `sessionId/turnId/toolCallId/sourceImages[]`。
- MessageBubble 或 Turn timeline 用这些 metadata 显示“生成中/完成/失败”。
- 编辑图未提供 input 时，按规则使用当前 turn 最近生成图；没有则报短错误。
- 多图编辑显式传 `sourceImages[]`。

验收：

- A 会话生成图时切到 B，会话 B 不显示 A 的 placeholder。
- 图片编辑无输入时能 fallback 到上一张生成图，并在 trace 中显示来源。
- 多图输入顺序稳定，测试覆盖两张以上图片。

### P1-4 渠道会话页可见性

目标：桌面会话页能看清外部渠道消息的来源、媒体状态和回复结果。

方案：

- session header 或 message metadata 显示 channel source：平台、账号、chatId/chatName。
- user message 上显示 source chip，例如 `Feishu · 群聊`。
- channel inbox/outbox 状态与 session 消息关联，能看到 sent/failed。

验收：

- 从 Feishu 消息创建的 session，有明确 channel origin 展示。
- 发送失败能在桌面会话页看到，但 IM 只收到短错误。

### P1-5 媒体性能和存储收敛

目标：继续减少大 base64 在主流程和 DB 中的存在。

方案：

- 渠道下载、普通上传、Appshot 统一走 media cache，消息里优先 path/ref，必要时按模型能力临时读 data。
- 大文件 data URL 不进入持久化；缩略图和摘要保留。
- 对 DB 与主进程慢路径加 telemetry。

验收：

- 10MB 图片/音频不会把 session DB 写入放大到数十 MB。
- renderer 发送大图不阻塞主进程关键路径。

---

## 9. 验收方式

### 9.1 单测

建议新增或扩展：

- `tests/unit/channels/feishuMediaDownload.test.ts`
- `tests/unit/channels/feishuVoiceTranscription.test.ts`
- `tests/unit/channels/channelTypingLifecycle.test.ts`
- `tests/unit/channels/channelErrorSummary.test.ts`
- `tests/unit/channels/channelDeduplication.test.ts`
- `tests/unit/agent/messageConverter.attachments.test.ts`
- `tests/renderer/components/channelMessageMediaState.test.tsx`

重点断言：

- 附件类型不丢：image/audio/video/file 进入 bridge 后 category 正确。
- transcript 文本进入模型上下文，原始音频路径仍可追踪。
- 外部渠道错误不泄露 stack/path/token/raw payload。
- typing 在成功、失败、取消路径都能收尾。
- duplicate message id 不重复触发回复。

### 9.2 集成 smoke

本地 fake Feishu webhook：

1. 发送 text，确认 channel session 创建、回复一次。
2. 重投同一个 message id，确认不重复回复。
3. 发送 image event，fake downloader 返回图片，确认消息里有图片附件。
4. 发送 voice event，fake downloader 返回 wav，确认 transcript 进入 user message。
5. 模拟模型异常，Feishu 只收到短错误，本地日志有完整错误。

桌面会话页：

1. 打开由 channel 创建的 session，能看到来源。
2. 语音消息有 transcript 和音频附件。
3. 图片消息能预览或至少显示可读取状态。
4. 切会话期间媒体异步完成不串台。

### 9.3 手动验证

- Feishu 真实机器人：发文字、图片、语音，观察桌面 session 和 Feishu 群内回执。
- Telegram 回归：typing 仍工作，长消息拆分不受影响。
- 大图片/大音频：观察 UI 卡顿、DB 体积、日志是否有 base64 大块。

---

## 10. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| Feishu/Lark 权限 | 下载语音、图片、文件可能需要额外 scopes | 实现前列权限矩阵，Settings 明确缺什么权限 |
| 隐私 | 外部 IM 可能含敏感语音和文件 | 默认本地 STT；raw payload 继续脱敏；短错误不泄露内部信息 |
| 存储膨胀 | 图片/音频 data URL 写库会迅速放大 | media cache + persistence sanitize |
| 重复处理 | webhook 重投、WS 重连、进程重启都可能重复消息 | processed ledger + outbox 状态 |
| 状态串台 | 异步下载/STT 完成时用户切 session | 所有 media state 绑定 accountId/chatId/messageId/sessionId/turnId |
| 平台 API 不稳定 | typing、下载 URL、文件 key 在 Feishu/Lark 有差异 | connector 层适配，功能降级不影响最终回复 |
| ASR 成本和准确率 | 云端快但有隐私/成本，本地依赖安装 | 默认本地；缺模型时短提示；提供后台安装/诊断入口 |
| 过度产品化 | 外部渠道不适合承载完整 trace | trace 留桌面端，IM 只要 typing、最终答复、短错误 |

---

## 11. 建议排期

P0 应该作为一个“小闭环”合并：

1. Feishu 媒体下载。
2. 音频自动 STT。
3. typing/低噪音状态。
4. 错误短摘要。
5. 幂等去重。

这五项一起完成后，用户会明显感觉 Feishu 会话从“能回文字”升级为“能可靠处理真实消息”。P1 再补 Lark 独立账号和图片生成/编辑状态，不会挡住第一轮价值。

---

## 12. 一句话落地原则

媒体要脱离附件栏装饰的定位，外部渠道也要脱离另一个输入框的定位。它们都应该进入同一条会话质量链路：来源清楚、状态安静、内容可读、失败可恢复、回复不重复。
