# Alma Voice Input 能力对标研究

日期：2026-06-13

范围：只研究 Alma 0.0.805 到 0.0.823 的语音输入完整链路，以及 code-agent 当前实现差距。本文不覆盖 Media & Channels 专项已经处理过的普通图片、文件、多媒体消息能力，除非它们影响语音输入进入会话页。

## 核心判断

Alma 的语音能力分成两条链路：桌面麦克风输入和渠道语音消息。桌面链路在 0.0.805 里已经成熟存在，0.0.823 与旧包基本一致；0.0.820 的新增重点在 Feishu/Lark 渠道，把收到的语音消息下载成本地音频，自动做 speech-to-text，再把转写文本变成会话输入。

Alma 最值得借鉴的地方不是“多一个麦克风按钮”，而是把语音当成会话交付链路：入口清楚、录音/转写状态轻量、转写结果可进入 composer 或 channel thread、失败时保留音频路径、渠道回复时减少进度噪音并给短错误摘要。

code-agent 现在已经有 composer 语音按钮、Groq 转写 IPC、全局 VoicePaste、local_speech_to_text 工具和音频附件分类，但这些能力是分散的。真正缺的是统一 ASR 层、可配置的本地优先策略、Feishu/Lark 语音入站转写、失败恢复和会话页解释性。

## Alma 能力拆解

### 1. 桌面 voice input

证据：新旧 renderer 都有 `SpeechInputAction`，核心代码没有明显变化。入口受 `settings.whisper.enabled` 控制；启用后显示麦克风按钮，点击开始录音，再次点击停止。录音用 `navigator.mediaDevices.getUserMedia` 和 `MediaRecorder`，转写前把 Blob 解码为 PCM，然后调用 `window.whisper.transcribe(audioData, sampleRate)`。

链路：

1. Settings 里启用 Speech/Whisper。
2. 点击 composer 麦克风按钮，或触发 `app:toggleWhisper` 快捷事件。
3. 初始化本地 Whisper：检查模型是否已下载，按 `settings.whisper.model` 和 `settings.whisper.language` 初始化。
4. 请求麦克风权限；权限拒绝时给错误，并尝试打开系统麦克风设置。
5. 录音时显示声浪；停止后进入 processing spinner。
6. 转写成功后调用 `onTranscript(result.text)`，把文本交给 composer。

桌面转写依赖本地 Whisper 模型。Alma 包内 evidence 包括 `@fugood/whisper.node`、模型目录 `whisper_models`、`ggml-*.bin`、16kHz 重采样、`transcribeData`。设置页提供模型下载、删除、选择、语言选择，支持 `tiny/base/small/medium/large-v3/large-v3-turbo` 等模型。默认快捷键是 macOS `Cmd+Shift+V`，其他平台 `Ctrl+Shift+V`。

### 2. 渠道 voice message

0.0.820 release notes 明确新增 Feishu/Lark voice messages 自动下载和 speech-to-text transcription，并说明 Feishu voice transcription 不再依赖 desktop Whisper setting。

新 main bundle 里的 Feishu/Lark 消息处理增加了 `message_type === "audio"` 分支：

- 从消息内容读取 `file_key` 和 duration。
- 通过 bundled `lark-cli` 执行 `im +messages-resources-download --message-id ... --file-key ... --type file --output ... --as bot`。
- 音频保存在 `~/.config/alma/groups/media`，文件名带平台 brand、时间戳和 file key，扩展名按 opus 处理。
- 下载成功后调用 `transcribeAudio(path)`。
- 转写成功时把入站内容写成 `[语音] ${transcript}`。
- 转写失败但音频下载成功时，把入站内容写成“用户发来一条语音消息，音频已保存到本地: path”，提示 Whisper 不可用时可用工具继续转写分析。
- 下载失败时写成“语音消息（音频下载失败）”。

这里有一个边界细节：release notes 说 Feishu voice transcription 不再依赖 desktop Whisper setting，bundle 证据显示渠道转写没有检查 `whisper.enabled` 开关；但它仍会读取 `settings.whisper.model/language` 作为本地模型偏好。如果本地模型不可用，它会 fallback 到 OpenAI `whisper-1`，从 enabled OpenAI provider 中找 API key。这说明 Alma 拆掉的是“桌面语音开关 gating 渠道转写”，并没有完全拆掉模型偏好复用。

### 3. 会话页落点

桌面 voice input 的转写结果进入 composer，不自动发送。用户能编辑文本，再按普通发送流程进入会话。这是低风险设计，适合我们的主 composer。

渠道 voice message 的转写结果不会进入本地 composer，而是作为 channel inbound message 的文本进入对应 thread。Alma 会给 agent 的 user message 加上消息 ID、发送者、群聊上下文等前缀。语音转写成功时 agent 看到的是文本内容；失败时 agent 至少能看到本地音频路径，后续可用工具处理。新 main bundle 还存在 voice language hint 逻辑：对 voice input 检测到的 spoken language，会注入回复语言提示，避免 transcript 被错译后回复语言跟丢。

### 4. 状态反馈和错误恢复

桌面录音状态靠按钮和声浪，不往会话里刷进度。转写中用 spinner。模型未下载、Whisper 初始化失败、麦克风权限失败、空音频、转写失败都会落到按钮 tooltip 或错误状态。

渠道侧 0.0.820 同时做了交付质量改进：Feishu typing indicator、减少 task processing progress spam、错误回复只发短摘要、修复 duplicate replies。main bundle 里也能看到超时恢复、tool-wait recovery、短错误摘要和清理 active generation 的逻辑。语音消息被转成任务后，用户应该看到“正在回复”的 typing 状态，而不是连续刷进度消息或完整 stack trace。

## Bundle Diff 证据

### Release notes

- v0.0.820：Feishu/Lark voice messages 自动下载和 speech-to-text transcription。
- v0.0.820：Feishu/Lark International 拆成单独连接。
- v0.0.820：Feishu typing indicator。
- v0.0.820：减少 Feishu task processing progress spam。
- v0.0.820：Feishu voice transcription 不再依赖 desktop Whisper setting。
- v0.0.820：错误回复只发 short summary。
- v0.0.823：降低 main process/database 慢路径，移除 base64 heavy processing 来源。这个对语音也有启发：长音频不要走大 base64 热路径。

### Renderer

旧 renderer `index-DZO6LH4W.js` 与新 renderer `index-lrtJ1hZ1.js` 的语音输入命中数量相同：`speech 47`、`whisper 61`、`recorder 24`、`microphone 11`。`SpeechInputAction` 位置和逻辑基本一致，说明桌面 voice input 不是这次 0.0.820 的主要新增点。

关键证据：

- `settings.whisper.enabled/model/language` 控制按钮和转写参数。
- `window.whisper.getStatus/initialize/transcribe` 是桌面转写桥。
- `requestMicrophonePermission/openMicrophoneSettings` 是权限恢复入口。
- `app:toggleWhisper` 配合 keybinding 触发。
- Whisper settings 页提供模型下载、删除、进度、语言选择。

### Main

main bundle 从旧到新变化更明显：

- `lark` 命中新包从 3 增到 128，`channel_mappings.platform` enum 新增 `lark`。
- `lark-cli` 新包出现 30 次，符合 release notes 里 bundled lark-cli。
- `message_type` 新包从 4 增到 8，Feishu/Lark 消息 handler 会先拉取完整消息，再处理 flattened event。
- 新包有 `message_type === "audio"` 分支、`downloadMessageResource`、`transcribeAudio`。
- `whisper-1` 新包从 3 增到 4，新增渠道音频 fallback。

## code-agent 当前实现

### Composer 语音输入

文件：

- `src/renderer/hooks/useVoiceInput.ts`
- `src/renderer/components/features/chat/ChatInput/VoiceInputButton.tsx`
- `src/renderer/components/features/chat/ChatInput/index.tsx`
- `src/main/ipc/speech.ipc.ts`
- `src/renderer/services/ipcService.ts`

现状：

- hook 状态只有 `idle | recording | transcribing | error`。
- 使用 `navigator.mediaDevices.getUserMedia({ audio: true })` 和 `MediaRecorder`。
- 每秒收集一次 chunk，默认最大录音 60 秒，低于 1 秒跳过。
- 音频 Blob 转 base64，通过 `ipcService.transcribeSpeech(audioData, mimeType)` 调主进程。
- 主进程只走 Groq Whisper：`whisper-large-v3-turbo`，`language: 'zh'`，最大 10MB。
- 有一组中文/英文 Whisper 幻觉过滤，比如“请不吝点赞”“thanks for watching”。
- 成功后 `handleVoiceTranscript` 把文本追加到 composer draft：有原文则补空格，没有原文则直接填入。用户可以编辑后再发送。
- 失败时按钮 title 展示错误，状态变 `error`，下一次点击可重新开始。

问题：

- provider 和语言硬编码，缺少本地优先和多语言设置。
- 桌面按钮没有音量可视化，只有录音时长和颜色变化。
- 权限失败只显示“请允许麦克风权限”，没有打开系统设置或权限 preflight。
- 转写失败时没有保留音频、重试、复制原音频、切换 provider 等恢复路径。
- 录音中 duration 文本悬在按钮下方，容易影响 composer 底栏布局。
- 没有会话记录元数据：用户之后看不出这段输入来自语音，也没有转写置信/语言/引擎信息。

### VoicePaste 全局语音粘贴

文件：

- `src/main/ipc/voicePaste.ipc.ts`
- `src/renderer/components/features/voice/VoicePasteIndicator.tsx`
- `src/renderer/stores/appStore.ts`

现状：

- 全局快捷键 `CommandOrControl+\``。
- 用 sox `rec` 录 16kHz mono WAV。
- 转写优先 `whisper-cpp` 和 `~/.cache/whisper/ggml-large-v3-turbo.bin`，失败后 fallback 到 Groq。
- 默认语言 `zh`。
- 转写后用 GLM/Kimi 做后处理，清理口头禅、标点和同音字。
- 通过剪贴板和 AppleScript 粘贴到当前焦点。
- 主进程会广播 `voice-paste:status`：recording、transcribing、processing、idle。

问题：

- 这条链路和 composer voice input 分离，ASR 引擎、语言、错误处理都不统一。
- `VoicePasteIndicator` 和 store 里有状态，但本轮搜索没有找到 renderer 订阅 `voice-paste:status` 并调用 `setVoicePasteStatus` 的代码，状态 UI 很可能没有真正接上。
- 通过系统粘贴进入当前焦点，不一定进入当前会话 composer，也没有 session 绑定。

### 本地 ASR 工具

文件：

- `src/main/tools/modules/network/localSpeechToText.ts`
- `src/main/tools/modules/network/localSpeechToText.schema.ts`

现状：

- 已经是本地离线语音转文字工具，基于 `whisper-cpp`。
- 支持 `.wav/.mp3/.m4a/.flac/.ogg/.webm/.aac/.wma`。
- 自动通过 ffmpeg 转 16kHz mono WAV。
- 支持 `language`、`model`、`threads`、`output_format: text/srt/vtt`、`translate`。
- 有单测覆盖 schema、happy path、缺 whisper-cpp、缺文件、空结果、translate 参数。

判断：这是最应该复用的 ASR 能力基础。composer 和 channel 不应该继续各自维护一套 Groq/whisper-cpp 分叉逻辑。

### 渠道语音

文件：

- `src/main/channels/feishu/feishuChannel.ts`
- `src/main/channels/channelAgentBridge.ts`
- `src/shared/contract/channel.ts`
- `src/main/agent/messageHandling/converter.ts`

现状：

- Feishu 入站只支持 `text | post | image | interactive`，没有 audio message type。
- shared contract 里已有 `ChannelAttachmentType = image | file | audio | video | link`。
- `channelAgentBridge` 能把 audio attachment 分类成 `audio`，但 MessageAttachment 的 `type` 仍会映射为 `file`。
- message converter 对 audio attachment 有提示：如需转写，可调用 `speech_to_text` 读取音频路径。
- 测试只覆盖“非 image 附件映射为 file”，没有实际 channel voice download/transcribe。

判断：code-agent 的渠道抽象已经留了音频附件位置，但 Feishu 入口还没有把平台语音消息下载、落盘、转写、失败保底这段补上。

### 测试覆盖

已有：

- `tests/renderer/services/ipcService.test.ts`：只验证 `transcribeSpeech` delegate。
- `tests/unit/web/extractRouter.test.ts`：验证 `/api/speech/transcribe` HTTP wrapper 参数校验和 handler 转发。
- `tests/unit/tools/modules/network/localSpeechToText.test.ts`：本地 ASR tool 覆盖较好。
- `tests/channels/channelMessageReply.test.ts`：附件转换边界里覆盖 audio 被当作 file。

缺口：

- `useVoiceInput` hook 的权限、状态机、max duration、失败恢复测试。
- `VoiceInputButton` 的无打扰布局、状态文案、disabled 行为测试。
- `speech.ipc.ts` 的 10MB、短音频、hallucination、Groq key 缺失测试。
- Feishu audio message normalize/download/transcribe/fallback 测试。
- VoicePaste status event 到 renderer store 的接线测试。

## 差异和借鉴

### 能力本身

code-agent 缺 Feishu/Lark voice message 入站能力。Alma 已经把渠道语音变成会话文本，并在转写失败时保留音频路径。

### 体验状态

code-agent composer 有状态，但录音状态比较粗，转写失败恢复弱。VoicePaste 状态事件可能没有接上。Alma 的桌面入口状态更细，渠道侧强调 typing indicator 和少刷进度。

### 设置边界

code-agent 缺一个统一 Speech/ASR 设置面。Alma 的经验是：桌面 voice input 可以被用户开关控制；渠道 voice transcription 不应该被这个开关挡住。我们的设计应拆成两层：

- Desktop Dictation：是否显示 composer 麦克风、默认语言、默认本地模型、快捷键、是否后处理。
- Channel Voice Transcription：是否自动下载/转写渠道语音、隐私策略、本地优先、云端 fallback 是否允许、失败时是否把音频作为附件进入上下文。

### 会话页可解释性

code-agent 桌面转写只把文本塞进 draft，发送后看不出来源。渠道音频目前只能作为普通 file/audio 附件被 agent 识别，缺少“这是一段语音，已转写成 X，原音频在 Y”的结构化上下文。Alma 的 `[语音] transcript` 和失败路径提示值得借鉴，但我们应做得更清楚：在 message metadata 里保留 source/audioPath/asrEngine/language，UI 上只展示轻量来源标签。

### 与其他模块联动

- Model：ASR provider 不能和 chat model 混在一起；需要单独的 `speech.asrProvider` 和 fallback 策略。
- Usage：云端 ASR 要计成本、调用次数、音频时长；本地 ASR 要计耗时和失败原因。
- Channels：每个 channel 可以有 voice policy，Feishu/Lark 先做。
- Composer：桌面语音默认填 draft，用户编辑后再发；不要默认自动发送。
- Attachments/Converter：渠道语音失败时应以 audio attachment + path 进入上下文，agent 可调用 local_speech_to_text。

## P0 开发切片

### P0.1 统一 ASR service

目标：把 composer、VoicePaste、channel voice 都接到同一个 ASR service。

范围：

- 抽出 `SpeechTranscriptionService`：输入 file/buffer + mime + language + source，输出 text、engine、language、duration、audioPath、errorCode。
- 默认本地优先：复用 `local_speech_to_text` 的 whisper-cpp/ffmpeg 能力。
- 云端 fallback 必须显式配置，先支持 Groq 或 OpenAI whisper-1 二选一。
- 保留现有 `speech:transcribe` IPC，但内部改走 service。

验收：

- 无 Groq key、有本地 whisper-cpp 时 composer 可转写。
- 无本地模型、有云端 fallback 开关和 key 时可转写。
- 无任何 ASR 时返回可操作错误，不丢音频。
- 单测覆盖本地成功、云端 fallback、缺模型、超时、空结果。

风险：

- 现有 `local_speech_to_text` 是 tool module，直接复用执行层可能牵扯 permission/context；建议先抽共享 helper，再让 tool 和 IPC 都调用 helper。

### P0.2 composer 语音输入体验收敛

目标：桌面麦克风输入稳定、低打扰、可恢复。

范围：

- 录音状态保持在 composer 控件内，避免 duration 绝对定位挤出底栏。
- 增加权限 preflight 和“打开系统设置”动作。
- 转写失败保留临时音频到受控目录，并提供重试/丢弃。
- 转写成功只进入 draft，不自动发送。
- draft 里插入文本时保留用户已有内容和光标语义，至少不要粗暴追加双空格。
- 发送时 message metadata 记录 `inputSource: voice`、`asrEngine`、`language`。

验收：

- 录音中、转写中、失败、成功四种状态都有 renderer 测试。
- 麦克风拒绝后能看到明确错误，并能再次尝试。
- 转写失败后原音频仍可重试。
- 成功后文本可编辑，按普通发送路径进入会话。

风险：

- MediaRecorder 在 Electron/浏览器模式格式不同，webm/mp4/wav 需要都能走。

### P0.3 Feishu/Lark voice message 入站

目标：收到渠道语音后自动下载、转写、进入对应 channel thread。

范围：

- 扩展 Feishu message type：支持 `audio`。
- 用 Feishu/Lark SDK 或现有 CLI 下载 message resource，落盘到 channel media 目录。
- 调统一 ASR service，channel policy 默认本地优先。
- 转写成功：content 形如 `[语音转写] ${text}`，metadata 记录 audioPath/asrEngine/language/duration。
- 转写失败：content 保留“收到语音，转写失败”，attachments 包含 audio path，converter 提醒 agent 可调用 local_speech_to_text。
- 渠道回复期间启用 typing indicator，避免刷多条 progress。

验收：

- mock Feishu audio event 能生成 ChannelMessage，content 是 transcript，attachment/metadata 有路径。
- 关闭桌面 voice input 后，channel voice transcription 仍可工作。
- 无 ASR 时不丢消息，agent 仍能拿到音频路径。
- 错误回复不包含 stack trace。

风险：

- Feishu/Lark 国际版资源 API 和文件 key 字段可能不同，需要把 region/type 做成 channel config。
- 音频格式通常是 opus/ogg，ffmpeg 依赖要明确。

### P0.4 Speech settings 边界

目标：让用户知道语音输入到底走哪里、是否本地、是否会上云。

范围：

- 新增或扩展设置页 Speech/ASR。
- Desktop Dictation：开关、快捷键、语言、模型、最大录音时长、后处理。
- Channel Voice：自动转写开关、channel 列表、云端 fallback 允许策略、保留音频期限。
- Model/Usage：展示本地模型状态、缺失依赖、云端 ASR 调用成本入口。

验收：

- 桌面开关只影响 composer 麦克风和快捷键。
- Channel voice 开关单独控制 Feishu/Lark 语音入站。
- 默认文案明确“本地优先；云端 fallback 需开启”。

风险：

- 不要把 ASR provider 塞进普通 chat model 选择器，否则用户会误以为切聊天模型会影响转写。

## P1 开发切片

1. 长语音分段：超过 60 秒或超过大小限制时自动 chunk，合并 transcript，记录分段状态。
2. 多语言自动识别：ASR 返回或检测语言后，给会话注入 spoken language hint，避免回复语言跟丢。
3. 音频质量反馈：录音时显示输入电平、静音检测、太短/无声提示。
4. 转写后处理：可选清理口头禅和标点，但必须保留 raw transcript。
5. Channel voice reply/TTS：只在 channel 用户发 voice 且回复较短时建议语音回复；先做策略，不要默认开启。
6. Usage/telemetry：记录音频时长、ASR engine、耗时、失败原因、是否云端。
7. 隐私保留策略：本地音频保留目录、自动清理、手动删除、incognito session 下不落长期盘。

## 交付风险

- 隐私：当前 composer Groq-only 会把用户原始语音上云，和本地优先方向冲突。
- 性能：base64 传大音频容易压 main/renderer，Alma 0.0.823 专门提到移除 heavy base64 慢路径。
- 权限：macOS 麦克风 TCC、Electron media permission、sox rec 权限是三套问题。
- 依赖：ffmpeg、whisper-cpp、模型文件、Groq/OpenAI key 都可能缺。
- 渠道：Feishu/Lark 消息资源下载可能要求 bot scope，region 分流也会影响 API。
- 线程：渠道语音转写慢时，容易造成重复回复、旧 thread 忙、新 thread 分叉，需要 active generation 和 dedup 策略。
- 可解释性：如果只把 transcript 当普通文本，用户和 agent 都无法区分“用户 typed”和“ASR guessed”。

## 建议优先级

第一优先级是统一 ASR service 和 composer 失败恢复，因为这能马上提升会话页输入质量，并为渠道语音复用同一底座。第二优先级是 Feishu/Lark audio 入站，因为这是 Alma 0.0.820 明确新增的差异能力。Speech settings 应跟着 P0 走，但先做必要边界，不要一开始做完整模型管理中心。

P0 不建议做语音回复/TTS 自动化。那会把“输入能力”扩成“输出人格和渠道礼仪”，容易和 Media & Channels 专项重叠，也会增加交付风险。
