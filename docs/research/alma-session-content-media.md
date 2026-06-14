# Alma Session Content & Multimedia Display 对标研究

## 结论

Alma 0.0.805 到 0.0.823 这条线的核心变化，已经超出单个图片按钮或单个 artifact 卡片，重点是把会话里的内容和媒体从「模型输出的附属物」推进成「有归属、有状态、有操作入口的会话对象」。用户能感知到三件事：长回复更干净，图片/生成图不会乱串 thread，大图和 base64 不再拖慢整机交互。

Neo/code-agent 当前在内容结构上更强。它有 turn projection、contentParts 交错渲染、tool/reasoning 折叠、artifact ownership、markdown/code/table/mermaid 等丰富渲染能力，也有 streaming delta/snapshot 修复链路。差距主要在媒体呈现层：图片、视频、附件、生成结果、artifact 文件分散在不同组件里，没有统一的 media asset 模型；复制、保存、打开、定位来源这些操作也不够一致；多图和编辑图的输入输出关系不够可见。

建议 P0 不做大改 UI，先把媒体资产投影、thread/turn 归属、lightbox 操作和 base64 缓存边界补上。P1 再做 gallery、编辑链路、多图关系和窄屏体验优化。

## Neo 借鉴判断

Neo 需要借鉴 Alma 的不是整套会话 UI，而是会话主区域里「媒体作为一等对象」的产品原则。Neo 已经有更强的 trace、contentParts、tool 分组、reasoning 折叠、artifact ownership 和 streaming projection，照搬 Alma 的消息结构会削弱 Neo 自己的工程优势。

### 需要借鉴

| 借鉴点 | 为什么 Neo 需要 | 建议落点 |
| --- | --- | --- |
| MediaAsset 统一对象 | Neo 的图片、附件、tool result、artifact image 分散在不同组件里；用户看到的是同一类素材，但操作和来源不一致 | P0：统一 session/turn/message/tool/source 归属，附件、markdown image、tool output、artifact media 都投到同一层 |
| Thread-safe placeholder | Alma v0.0.814 明确修复 placeholder 串 thread；这是用户会立刻感知的信任问题 | P0：pending/ready/failed asset key 必带 sessionId、turnId、toolCallId，session 切换只隐藏非当前资产，不销毁任务状态 |
| Lightbox + copy/open/save/reveal | Alma 把图片当成可处理对象；Neo 现在不同入口的操作不统一 | P0：统一 MediaActionBar 和 lightbox，本地 path、remote URL、cache URL、base64 都有清楚降级 |
| Base64 / 大图缓存边界 | Alma v0.0.823 的 app-wide lag 修复说明 heavy base64 会拖垮全局交互；Neo 生成图未保存时也有 embedded base64 风险 | P0：超阈值 data URL 写入 media cache，renderer 长期状态只保留 path/cacheUrl/metadata |
| Clean final answer 边界 | Alma v0.0.811 的 clean conversation text 证明 terminal clutter 会直接伤害扫读 | P0：继续保住 tool/system 不进最终 markdown，并补长回复、tool、媒体混合 fixture |
| Artifact/media 一行描述 | Alma v0.0.814 给 artifact card 加 description line，价值是降低识别成本 | P0：对图片/视频/生成物显示一句来源和动作，不把卡片做重 |
| 生成/编辑图输入输出关系 | Alma 已有多图编辑和编辑 fallback 证据；Neo 的 imageProcess/annotate 有数据，但主会话表达弱 | P1：parentAssetIds 可见化，展示输入缩略图、处理动作、输出图、失败 fallback |
| Thread-scoped gallery | Alma gallery/lightbox 能从图片回 thread；Neo 会话内素材目前没有连续浏览面 | P1：先做当前 thread 的轻量 gallery，不先做全局素材库 |
| 视频/音频懒加载和统一操作 | Alma bundle 有 AudioPreview/VideoPreview；Neo 局部已有 controls，但归属和操作不统一 | P1：纳入 MediaAsset，补 poster、duration、download/open/reveal，一律懒加载 |

### 只借一半

| Alma 做法 | Neo 该借的部分 | Neo 不该照抄的部分 |
| --- | --- | --- |
| Lightbox/gallery 独立体验 | 借统一查看、翻页、回源、保存 | 不把会话主区变成素材库入口，P0 只服务当前消息和当前 thread |
| Tool/status 弱化为辅助层 | 借「不污染最终答复」 | 不隐藏 Neo 的 trace 能力，工具过程仍要可展开、可调试、可验收 |
| Artifact card description | 借一行说明降低识别成本 | 不把每个 artifact 都做成大卡，文件多时会把正文挤没 |
| 图片编辑 fallback | 借 parent/fallback 数据模型 | 不先做完整图片编辑工作台；Neo 当前更需要把已有 imageProcess/annotate 关系表达清楚 |
| Gallery cache 自动嵌入 | 借缓存化和发送稳定性 | 不先做全局同步图库；先保证会话里的本地图片不丢、不串、不阻塞 |

### 没必要借鉴

| 不建议借鉴 | 原因 |
| --- | --- |
| 重写 Neo 的消息渲染结构 | Neo 的 markdown、代码、表格、mermaid、contentParts、reasoning/tool 分组比 Alma 更强，问题不在正文 renderer 本身 |
| 用 Alma 风格替换 Neo 的 trace/projection | Neo 的 turn projection、deltaSeq、snapshot replacement、artifact ownership 是核心优势，应在上面叠 media projection |
| 把所有工具过程都压成极简 indicator | Neo 的目标用户需要知道工具做了什么、失败在哪；正确做法是默认折叠和摘要，不是消失 |
| P0 做全局 gallery / 素材库 | 当前风险是会话主区素材归属和操作不清；全局库会扩大范围，且会引入权限、清理、跨项目隐私问题 |
| P0 支持所有媒体类型同等完整 | 图片是最强证据和最高频风险；视频/音频先纳入模型并懒加载，细节体验放 P1 |
| 全量迁移历史 base64 消息 | 风险和成本高；先做新消息阈值和读取时降级，旧消息按需缓存化 |
| 在消息里内嵌复杂轮播 | 会打断正文扫读；统一 lightbox 翻页更合适 |
| 复制 Alma 的视觉密度 | Neo 的会话主区已经承载 trace、tool、artifact、review 等信息，继续加重视觉装饰会降低可读性 |

判断一句话：Neo 要借 Alma 的「素材归属和操作一致性」，不要借 Alma 的「整体消息 UI 形态」。P0 应该让用户确信素材没串、没丢、可打开、可保存、不会拖慢会话；P1 再让素材关系更好看、更连续。

## 研究边界与证据

本专项只研究会话主区域的内容组织和多媒体展示，不覆盖独立 artifacts delivery、外部渠道分发、插件市场或模型能力本身。

用户给定的 `/tmp/alma-update-20260613/release-notes-805-823.md`、旧/新 renderer、旧/新 main 在本 worktree 内未能读取到，`/tmp/alma-update-20260613` 不存在。为了不把缺失文件当作已读证据，本研究使用三类材料：

| 类型 | 证据 |
| --- | --- |
| Release notes | GitHub Releases: [v0.0.823](https://github.com/yetone/alma-releases/releases/tag/v0.0.823)、[v0.0.814](https://github.com/yetone/alma-releases/releases/tag/v0.0.814)、[v0.0.811](https://github.com/yetone/alma-releases/releases/tag/v0.0.811)、[v0.0.808](https://github.com/yetone/alma-releases/releases/tag/v0.0.808)、[v0.0.820](https://github.com/yetone/alma-releases/releases/tag/v0.0.820)；并与源线程 `019ec0fe-2f46-7aa2-8908-5f3e5fbf7d61` 的前序核验事实互校 |
| Alma bundle | `/Applications/Alma.app/Contents/Info.plist` 确认 `CFBundleShortVersionString = 0.0.823`；`app.asar` 解包到 `/tmp/alma-current-extract`；`out/renderer/index.html` 指向 `assets/index-lrtJ1hZ1.js`，另有 `gallery-DD4Sng8t.js`、`lightbox-DInt0hiF.js`、`ImagePreview-Y4onbdmK.js`、`VideoPreview-CmELcS54.js`、`AudioPreview-BdsjVvai.js` |
| Neo/code-agent | 当前仓库源码，重点核验 `src/renderer/components/ChatView.tsx`、`MessageBubble/*`、`TraceNodeRenderer.tsx`、`ToolStepGroup.tsx`、`artifactOwnership.ts`、streaming 相关 hooks/store、image/video generation tools |

文中标注为「Alma 证据」的是 release notes 或 bundle grep 能直接支撑的点；标注为「推断」的是从 minified bundle 的组件、API、IPC 和状态命名推出来的体验形态。

## Alma 会话主区域呈现方式

### 1. 文本和最终回复

Alma 证据：

- v0.0.811 修复 Claude CLI interactive mode 的长回复截断或重组错误，改为使用 clean conversation text，并移除 terminal footer / clutter。
- bundle 中主会话 renderer `index-lrtJ1hZ1.js` 使用独立的 message/content 渲染逻辑，并存在 image menu、optimized image、lightbox、tool/memory/skill indicators 等会话内组件命名。

判断：

- Alma 这条线优先解决「模型最终答复是否干净可读」。terminal 输出、tool 状态和 footer 被清出最终文本，减少用户扫读时被执行噪声打断。
- 它的内容结构没有 Neo 那样强的 trace/projection 表达，但最终答复层的用户感知更直接，尤其是长回复和 streaming 收尾时。

### 2. Markdown、代码、表格、引用

Alma 证据：

- bundle 含 `react-markdown`、`remark-gfm`、`rehype-katex` 等 markdown 依赖，renderer 中有代码高亮和 markdown 渲染相关符号。
- release notes 本身未单独强调 markdown/table/code 的变更，本专项不能把这一点推成 0.0.805 到 0.0.823 的新增能力。

判断：

- Alma 的会话内容能力更像「常规 markdown 渲染加媒体增强」。
- Neo 的 markdown/code/table 能力明显更完整，尤其是代码块行数、复制、折行、mermaid、chart/document/spreadsheet fence 的特殊渲染。

### 3. Reasoning、tool result、系统/错误/状态消息

Alma 证据：

- v0.0.811 的 clean transcript 明确指向「不要让 terminal footer / clutter 污染会话答复」。
- v0.0.820 提到更短的错误摘要、减少 Lark/Feishu 进度 spam，说明状态消息在表达层有克制方向。
- bundle 中存在 tool/memory/skill indicators，能支持会话内状态提示。

推断：

- Alma 更倾向把 tool/status 当作辅助层，而非主回复正文的一部分。
- 对用户来说，核心收益是最终答复更容易扫读，失败时看到短错误摘要，工具过程不会抢占主内容。

### 4. Artifact card 和媒体素材分层

Alma 证据：

- v0.0.814 给 artifact cards 增加 description line。
- v0.0.814 同时修复 image generation placeholder 只出现在正确 thread、image editing fallback 到之前生成图、多图编辑支持。
- bundle 里 gallery、lightbox、image menu 是独立 renderer chunk，不只是普通 markdown `<img>`。

判断：

- Alma 对 artifact card 和媒体素材都在做「对象化」：卡片需要多一行描述，媒体需要来源、placeholder、打开、保存、复制、thread 归属。
- description line 的价值不在文案长度，而在让用户一眼知道卡片是什么、来自哪次动作、下一步能做什么。

## Alma 多媒体展示证据

| 能力 | Alma 证据 | 用户感知 |
| --- | --- | --- |
| 图片复制/打开/保存 | `ThemeContext-Crr5E0So.js` 有 `chat.imageMenu.copyImage/openImage/saveImage` 多语言文案；`index-lrtJ1hZ1.js` 有 `copyImageToClipboard`、`openImageInLightbox`、`saveImageToDisk`、`handleImageMenuAction` | 图片是可操作对象，右键或菜单能直接处理 |
| 会话内图片优化 | `index-lrtJ1hZ1.js` 有 `OptimizedImage`，并在 image part / thinking image 上接入 lightbox 和 context menu | 大图显示更顺，不需要用户等 base64 DOM 卡住 |
| Gallery cache | v0.0.808 提到 gallery cache 图片发送前自动嵌入；main bundle 有 `gallery_cache`、`extractAndPersistImages`、`persistInlineDataUrlToCache`、`/api/gallery/cache`、`/api/gallery/images` | 本地 gallery 图片发送不易失败，图片 URL 可以稳定回放 |
| Placeholder | v0.0.814 修复 image generation placeholder 只在正确 thread 出现；gallery chunk 有 `showPlaceholder`、`aspect-square`、`animate-pulse` | 生成中状态不串会话，加载空洞有稳定占位 |
| Lightbox | `lightbox.html` 加载 `lightbox-DInt0hiF.js`；lightbox chunk 有 `window.lightboxWindow.onUpdate/getInitialParams/close`，支持 `/api/gallery/images/:id` 和分页加载 | 点击图片进入沉浸查看，能在 gallery 中翻页 |
| 归属和回跳 | `lightbox-DInt0hiF.js` 有 `imageMetadata.threadId` 和 `navigateToThread(imageMetadata.threadId)` | 图片不只是孤立文件，能回到产生它的会话 |
| 生成图失败恢复 | v0.0.814 提到 image editing fallback 到 previously generated image；main bundle 有 `generation_error` broadcast 和 image generation 失败消息路径 | 编辑失败时仍能找到上一张可用图，失败不会把上下文打断 |
| 多图编辑 | v0.0.814 明确提到 multi-image editing support | 多张输入图和输出图应该在同一会话动作里被理解 |
| Base64 性能 | v0.0.823 移除 heavy base64 processing 导致的 app-wide lag；main bundle 有 base64 写入 gallery cache，`jpegEncoder.worker.js` 使用 worker_thread | 大图处理不阻塞主会话和数据库响应 |
| 音视频预览 | bundle 有 `AudioPreview-BdsjVvai.js`、`VideoPreview-CmELcS54.js`、`ImagePreview-Y4onbdmK.js` | 说明 Alma 不把媒体限定为图片，但本轮证据最强的是图片链路 |

## Streaming 稳定性

Alma 证据：

- v0.0.811：长回复不再被截断或重组错误，clean conversation text，移除 terminal footer / clutter。
- v0.0.814：image generation placeholder 只出现在正确 thread。
- v0.0.823：移除 heavy base64 processing，避免 app-wide lag，让 main process / database responsiveness 更稳。

判断：

- Alma streaming 稳定性的重点不是更复杂的事件模型，而是减少污染源：文本只保留 clean transcript，placeholder 绑定 thread，base64 从主交互路径移走。
- 对 Neo 的启发是：已有 delta/snapshot/projection 机制不等于用户就不会看到错乱。媒体 placeholder、tool 输出、base64 inline、final commit 的边界仍要做用户侧验收。

## Neo/code-agent 当前实现核验

### 会话入口与 streaming projection

- `src/renderer/components/ChatView.tsx`：引入 `useStreamingMessageAccumulatorStore`、`useTurnProjection`、`applyStreamingMessageDeltasToProjection`；`buildEnvelope(content, attachments)` 把输入与附件打包；`effectiveIsProcessing` 绑定当前 session；拖拽附件经 `collectDroppedAttachments`、`processFile`、`processFolderEntry`。
- `src/renderer/hooks/agent/effects/useConversationStreamEffects.ts`：处理 `turn_start`、`stream_chunk`、`message_delta`、`message_snapshot`、`message`、`stream_reasoning`；有 `mergeCommittedAssistantContent`，final commit 前 flush streaming buffers，并用 `isAgentEventForCurrentSession` 过滤跨 session 事件。
- `src/main/protocol/messageDeltaAccumulator.ts`：`message_delta` 支持 `replace`/append，`deltaSeq` 防旧 delta / 重复 delta。
- `src/renderer/utils/streamingProjectionOverlay.ts` 和 `src/renderer/stores/streamingMessageAccumulatorStore.ts`：把 active delta 叠到 assistant text / reasoning 节点上。

判断：Neo 的 streaming 结构比 Alma 更强，尤其是 session guard、deltaSeq、snapshot replacement。风险在媒体和 placeholder 还没有统一纳入同一个投影模型。

### MessageBubble / AssistantMessage / MessageContent

- `src/renderer/components/features/chat/MessageBubble/index.tsx`：`system` 不直接渲染；`tool` message 返回 null，注释明确避免 tool JSON fallthrough 到 assistant markdown。
- `AssistantMessage.tsx`：reasoning/thinking 折叠；`contentParts` 按 text/tool_call 交错顺序渲染，连续 tool_call 自动分组；hover action bar 支持 regenerate、fork、copy markdown、copy plain；artifact 以轻量 chips 呈现。
- `MessageContent.tsx`：`remark-gfm`、math、breaks、KaTeX；代码块有语言、行数、复制、折行、长代码折叠；mermaid / chart / document / spreadsheet fence 特殊渲染；`filterSystemTags` 清理系统标签和 tool_call XML 泄漏；streaming markdown 用 `shouldRenderStreamingContentAsMarkdown` 和 `useThrottledStreamingContent` 控制节流。

判断：Neo 对「正文、代码、工具过程、reasoning」的结构隔离已经足够做 P0，不需要先重写消息渲染。扫读性问题更适合在 final answer anchor、tool group 默认折叠、artifact/media 卡片摘要上做。

### 附件和媒体预览

- `AttachmentPreview.tsx`：附件类别覆盖 image/audio/video/pdf/excel/presentation/archive/code/data/html/text/folder；图片用 `thumbnail/data/path` 和 `resolveFileUrl` 预览，点击进入 modal lightbox；audio/video 使用原生 controls；excel/docx 有结构化 block；folder 大量附件会折叠。
- `ToolDetails.tsx`：`image_generate` 的 `imagePath/imageBase64` 会渲染成图片结果，支持 expand、Open、Finder；`video_generate` 支持 cover、inline play、download、open、Finder。
- `FileArtifactCard.tsx`：主会话 artifact 卡片更偏文件卡，图片后缀只得到图标/路径，不会变成统一图片预览。

判断：Neo 已有媒体能力，但分散在附件预览、tool 详情、artifact ownership 和 markdown image 里。用户看会话主区域时，会感到「能显示，但对象关系和操作入口不统一」。

### Artifact ownership / trace

- `artifactOwnership.ts`：从 assistant artifacts、tool outputPath、tool metadata 里的 `filePath/imagePath/videoPath/outputPath` 等收集交付物，过滤 read-only 和非 deliverable。
- `useCurrentTurnArtifactOwnership.ts`：把当前 turn 的 artifact ownership 和 timeline ownership 合并去重。
- `TraceNodeRenderer.tsx`：支持 user/assistant_text/tool_call/system/swarm_launch/turn_timeline；隐藏部分工作台快照噪声；展示 artifact ownership、routing evidence、hook/skill activity。
- `ToolStepGroup.tsx`：工具组有 streaming/partial/error/ok 状态，失败和 partial 默认展开，成功可折叠；能识别 tool output artifact。

判断：Neo 的 artifact ownership 数据底座可复用，但目前它表达的是「交付文件」，没有上升为「会话里的媒体素材」。

### 图片/视频生成工具

- `src/main/plugins/builtin/imageCreation/imageGenerate.ts`：返回 `artifact`、`originalPrompt`、`expandedPrompt`、`imagePath`、`imageBase64`、`aspectRatio`、`generationTimeMs`；有 `createFileArtifact` 和 virtual artifact，未保存时可能返回 embedded base64。
- `imageAnnotate.ts`：读取图片，OCR/vision 分析，可输出 annotated image artifact，metadata 含 `imagePath/annotatedPath/regions/ocrMethod`。
- `imageProcess.ts`：对输入图片执行 resize/crop/convert 等处理，metadata 含 inputPath 和输出 artifact。
- `videoGenerate.ts`：返回 `videoUrl/coverUrl/videoPath/duration/aspectRatio/expandedPrompt`，tool result UI 有下载/打开能力。

判断：Neo 已有生成和处理能力，但缺一个 session-level media projection，把 prompt、输入图、输出图、fallback、父子关系、保存路径和预览操作串起来。

## 对标矩阵

| Alma 体验点 | 用户感知 | Neo 现状 | 差距类型 | 优先级 | 开发/设计建议 |
| --- | --- | --- | --- | --- | --- |
| Clean conversation text | 长回复像最终答复，不像 terminal dump | `MessageContent` 会过滤系统标签，tool message 不落正文 | 已有能力，需验收强化 | P0 | 加长回复 streaming fixture，验证 tool/status/footer 不进入最终 markdown |
| 长回复不截断/不重组 | 回复完整，streaming 收尾不跳 | deltaSeq、snapshot、final flush 较完整 | 已有能力，需媒体一起验收 | P0 | 把媒体 placeholder 和 final asset 加进 streaming e2e |
| Reasoning 折叠 | 思考过程不抢正文 | `AssistantMessage` 有 reasoning/thinking 折叠 | Neo 更强 | P1 | 保持默认折叠，补一行摘要和错误态可见性 |
| Tool result 分组 | 工具过程可看，但不污染答案 | `ToolCallGroupList`、`ToolStepGroup` 已有折叠和状态 | Neo 更强 | P0 | 确保 tool result 图片不只藏在折叠深处，关键结果提升为 media card |
| Artifact card description | 卡片一眼知道用途 | assistant artifacts 目前是小 chips，FileArtifactCard 偏文件路径 | 表达弱 | P0 | artifact/media card 加 description/source/action，不扩大成重型面板 |
| 图片右键 copy/open/save | 图片可直接带走 | attachment lightbox 没有统一 copy/save/open；tool image 有 Open/Finder | 操作不一致 | P0 | 做统一 MediaActionBar：copy image/path、open、save/download、reveal |
| Lightbox / gallery | 点击看大图，能翻页回源 | attachment 图片有 modal，tool/markdown/artifact 没有统一 lightbox | 能力分散 | P0 | Lightbox 接收 MediaAsset 列表，支持回到 turn/message/tool |
| Gallery cache 自动嵌入 | 本地图发送不失败 | 目前未见统一 gallery cache；image_generate 未保存时会回 embedded base64 | 能力缺口 | P0 | main/renderer 边界落 media cache，替换大 base64 为 file/cache URL |
| Placeholder thread safety | 生成中状态不串会话 | session event guard 已有，但媒体 placeholder 未统一建模 | 结构缺口 | P0 | placeholder key 使用 sessionId + turnId + toolCallId + assetId |
| 生成图 fallback | 编辑失败还能回到上一张 | imageProcess/annotate 有输入输出，但 image edit fallback 不明显 | 多媒体流程缺口 | P1 | 记录 parentAssetIds，失败卡片显示可恢复上一张 |
| 多图编辑 | 多张输入图到输出图关系可见 | 多图关系未作为会话对象表达 | 表达缺口 | P1 | MediaRelationStrip：输入缩略图 + 箭头 + 输出图 + tool/prompt |
| 视频/音频素材 | 能预览和下载 | attachment audio/video 有 controls；video_generate tool result 有 download/open | 局部已有 | P1 | 统一到 MediaAsset，补 poster、duration、文件大小和懒加载 |
| Thread/source attribution | 图片能回到来源会话 | artifact ownership 有 owner，但 lightbox 没有统一 source action | 表达缺口 | P0 | MediaAsset 存 session/turn/message/tool，lightbox 提供定位来源 |
| Base64 性能 | 大图不拖慢会话 | image_generate 可返回 embedded base64，markdown/attachment 可 inline data | 性能风险 | P0 | 设置 inline size 上限，缓存化、懒加载、object URL 回收 |
| 窄屏媒体布局 | 图片不挤压正文 | attachment/tool 预览各自控制 max height，缺统一响应式策略 | 体验缺口 | P1 | 窄屏统一单列，actions 收进菜单，正文宽度优先 |

## P0 开发切片

### P0.1 Session MediaAsset 投影

目标：把会话里的媒体素材统一成可渲染、可操作、可验收的对象。

建议字段：

```ts
type SessionMediaAsset = {
  assetId: string;
  sessionId: string;
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
  source: 'attachment' | 'markdown' | 'tool_result' | 'artifact' | 'generated' | 'processed';
  role: 'input' | 'output' | 'intermediate';
  mimeType: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  url?: string;
  path?: string;
  cacheUrl?: string;
  dataUrl?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  prompt?: string;
  model?: string;
  parentAssetIds?: string[];
  state: 'pending' | 'ready' | 'failed';
  error?: string;
};
```

验收：

- 同一张生成图在 tool result、artifact ownership、markdown image 中只投影一次。
- 切换 session 后，不显示其他 session 的 pending/ready asset。
- image_generate 返回 base64、path、URL 三种形态都能进入同一投影。

风险：

- 去重键如果只用 path/url，virtual artifact 和缓存 URL 可能重复。
- 本地路径显示要控制隐私，默认展示 filename，完整路径放 tooltip 或 Finder action。

### P0.2 统一 lightbox 和媒体操作

目标：把 attachment image、tool image、markdown image、artifact image 的查看和操作统一。

设计建议：

- 主图点击打开 lightbox。
- 卡片 action 支持 copy image、copy path/url、save/download、open、reveal in Finder、go to source turn。
- 无 path 的 base64/remote URL 先缓存后保存，避免直接把巨大 data URL 塞进 DOM 或 clipboard。
- 操作按钮窄屏收进 menu，避免压缩正文。

验收：

- 从附件、tool result、markdown image、artifact image 四个入口打开的是同一个 lightbox 组件。
- copy/save/open 对本地 path、remote URL、cache URL、base64 都有明确成功/失败提示。
- lightbox 能定位到来源 turn/message/tool。

风险：

- Electron clipboard 写图片和浏览器环境能力不同，Web mode 需要降级成复制路径/URL。
- 大图保存时要避免一次性把多份 base64 留在 renderer memory。

### P0.3 Base64 和大素材性能边界

目标：借鉴 Alma 0.0.823，把 heavy base64 processing 从会话主渲染路径移开。

实现建议：

- image_generate / image_process / attachment upload 返回 data URL 时，main 进程或 workspace 服务持久化到 media cache，renderer 使用 cache URL。
- 超过阈值的 `data:image/*;base64` 不进入 React state 的长期消息对象。
- object URL 引用计数或 LRU 回收，避免长会话内存积累。
- video/audio 使用 metadata + poster/controls 懒加载，避免打开会话就加载整段素材。

验收：

- 10MB 图片生成结果不会让消息列表明显卡顿。
- 会话 JSON 中不保留超阈值 base64。
- 切换 thread 和滚动长会话时，renderer memory 不持续上涨。

风险：

- 旧消息里已有 base64，需要迁移或按需 rewrite。
- cache 清理策略如果过猛，会造成历史会话图片失效。

### P0.4 Turn-safe placeholder

目标：媒体生成中状态必须绑定正确 session 和 turn。

实现建议：

- pending asset 使用 `sessionId + turnId + toolCallId + assetId` 做 key。
- `message_delta`、`message_snapshot`、tool result、final message 都通过同一 reducer 更新 asset state。
- session 切换时隐藏非当前 session 的 pending asset，不销毁真实任务状态。

验收：

- 同时在两个 session 触发 image_generate，placeholder 不互串。
- 生成失败时，错误卡片停留在发起它的 turn。
- retry 或 regenerate 不复用旧 placeholder。

风险：

- toolCallId 缺失时需要稳定 fallback，不能退回 Date.now 这种不可追踪 key。

### P0.5 最终结论可识别

目标：工具和媒体丰富后，最终答复仍然可扫读。

实现建议：

- AssistantMessage 保留正文优先，media cards 插在与文本语义相邻的位置，但 tool raw output 默认折叠。
- 对包含工具结果的回复，在最终文本底部提供轻量「交付物」条，展示关键媒体/文件，不把所有 trace 展开。
- 对长回复使用现有 markdown/code 能力，避免媒体卡片夹断段落。

验收：

- 一条含 5 个 tool call、2 张生成图、1 段最终建议的回复，首屏能看清最终结论。
- tool JSON、系统状态、进度 spam 不出现在最终 markdown。
- 复制 markdown/plain text 不带 media 操作 UI 文案。

风险：

- 媒体卡片和 artifact chips 同时出现会重复，需要统一 projection 后再渲染。

## P1 开发切片

### P1.1 Thread-scoped gallery

把当前 thread 里的 MediaAsset 做成轻量 gallery，可从 lightbox 翻页，也可按输入/输出/失败筛选。优先 thread-scoped，不先做全局素材库。

验收：当前会话生成/上传过的图片能在 gallery 中按时间看到，点击能回到来源 turn。

### P1.2 多图和编辑图关系

把 `parentAssetIds` 做成可见关系：输入图缩略图、处理工具、输出图、失败 fallback。对 imageProcess/annotate 先支持，后续接 image edit。

验收：用户能看出「这张输出图来自哪几张输入图和哪次编辑」。

### P1.3 媒体卡片详情

生成图显示 prompt、model、aspect ratio、尺寸、耗时；视频显示 duration、poster、下载状态；失败卡片显示可重试、可恢复上一张。

验收：不展开 tool details 也能理解素材来源和生成参数。

### P1.4 窄屏和移动布局

统一媒体宽度、max-height、action menu 和 lightbox toolbar。窄屏正文优先，媒体不把文本挤到不可读。

验收：375px 宽度下，图片、视频、代码块和操作按钮不横向溢出；action 菜单可触达。

## 重点风险

| 风险 | 影响 | 控制方式 |
| --- | --- | --- |
| 媒体对象重复 | 用户看到同一张图出现多次 | projection 层统一去重，渲染层只消费 MediaAsset |
| base64 留在消息对象 | 长会话卡顿、数据库膨胀 | 超阈值缓存化，旧消息按需迁移 |
| placeholder 串 session | 用户误以为图生成到别的会话 | asset key 必带 sessionId/turnId/toolCallId |
| 本地路径暴露 | 截图或分享时泄露目录 | 默认 filename，路径放操作或 tooltip |
| cache 清理误删 | 历史图片打不开 | 引用计数/最近访问时间/消息引用索引 |
| copy/save 权限差异 | Electron/Web mode 行为不一致 | action capability 检测和降级提示 |
| artifact/media 双渲染 | 主区域变吵 | artifact ownership 与 media projection 合并展示 |
| 视频大文件加载 | 首屏慢、内存涨 | poster 懒加载，用户点击后加载视频 |

## 验收方式

建议用 fixture 和 renderer 测试组合，不依赖真实模型：

- Unit：MediaAsset projection 从 attachment、markdown image、tool metadata、artifact ownership 收敛成稳定对象；重复 path/url/base64 不重复渲染。
- Unit：streaming delta、snapshot、final message 中媒体状态按 session/turn 更新，不跨 session。
- Renderer：attachment image、tool result image、markdown image、artifact image 都能打开统一 lightbox，并显示一致 action。
- Renderer：image_generate base64 结果被缓存 URL 替代，DOM 不出现超阈值 data URL。
- Renderer：失败 placeholder 留在正确 turn，显示错误和 retry/fallback 入口。
- E2E：两个 session 同时生成图片，pending/ready/failed 状态互不串。
- E2E：10MB 图片、远程 URL 图片、本地 path 图片、video result 在长会话里滚动不卡顿。
- Visual：375px、768px、1440px 三档宽度下，媒体卡片不压缩正文，action menu 不溢出。

## 借鉴优先级

P0 借鉴的是 Alma 的「媒体对象化」和「streaming 干净边界」：thread-safe placeholder、统一 lightbox、copy/open/save、gallery cache/base64 性能、最终答复不被 tool/status 污染。

P1 借鉴的是 Alma 的「素材连续性」：gallery、输入输出关系、多图编辑、编辑失败 fallback、素材详情。

Neo 不需要照搬 Alma 的整体消息 UI。更合理的路径是保留 Neo 现有 trace/projection 优势，在会话主区域补一层 MediaAsset，让用户看到的图片、视频、附件和生成物拥有同一套归属、状态和操作规则。
