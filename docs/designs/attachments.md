# 附件管线 v2 设计（多类型附件 → 摘要 → 模型上下文）

> Status: 🚧 WIP（已落 main commit `162f54f5`，**未经逐行 review，待后续处理**）· Owner: 林晨 · Created: 2026-05-26
> 来源：验收迭代（爸/艾克斯）在 `feat/appshots-p34` worktree 累积的附件处理重构，按意见独立成支后落 main。
> 本文据 `162f54f5` 的 as-built 代码梳理；`tsc` 通过、自带 5 测试文件 46 例全过，但实现仍可能在 review 后调整。

## 1. 实现状态（as-built，2026-05-26）

| 能力 | 状态 | 位置 |
|------|------|------|
| 新增 4 类附件：`audio` / `video` / `presentation` / `archive`；`document` 收窄为 DOCX | ✅ main | `src/shared/contract/message.ts` |
| 端侧摘要提取：PPTX 逐页文字/图/表 + ZIP 目录清单（含 zip-slip 检测，不自动解压） | ✅ main | `src/renderer/.../ChatInput/attachmentSummaries.ts` |
| 模型上下文序列化：各类附件渲染成结构化文本 + 工具引导 | ✅ main | `src/main/agent/messageHandling/converter.ts` |
| `<attachment>` 块 strip（对用户隐藏、对模型可见）+ 持久化瘦身（剥离大 data URL） | ✅ main | `src/shared/utils/messageAttachments.ts` |
| 持久化接线：desktop + web 双链路统一走 strip/sanitize | ✅ main | `SessionRepository.ts` / `web/{routes/agent,helpers/sessionCache}.ts` |

**核心文件**：

| 文件 | 侧 | 职责 |
|------|----|------|
| `src/shared/contract/message.ts` | shared | `MessageAttachment.category` 扩类；`PresentationSummary` / `PresentationSlideSummary` / `ArchiveManifest` / `ArchiveEntrySummary` 类型；附件新增字段 `pptJson` / `archiveManifest` |
| `src/shared/utils/messageAttachments.ts` | shared | `stripInlineAttachmentBlocks()` 渲染剥离；`sanitizeAttachment(s)ForPersistence()` 入库前剥离重数据 |
| `src/renderer/.../ChatInput/attachmentSummaries.ts` | renderer | 上传时端侧解析：`buildPresentationSummary()`（PPTX）/ `buildArchiveManifest()`（ZIP） |
| `src/main/agent/messageHandling/converter.ts` | main | `buildMultimodalContent()` 把每类附件转成喂给模型的 `text`/`image` 内容块 |
| `src/main/services/core/repositories/SessionRepository.ts` | main | 桌面端会话持久化：写入前 sanitize、读取时 strip |
| `src/web/routes/agent.ts` · `src/web/helpers/sessionCache.ts` | web | webServer 链路同样 strip/sanitize（与桌面端对齐） |
| `src/renderer/.../ChatInput/AttachmentBar.tsx` · `MessageBubble/AttachmentPreview.tsx` | renderer | 输入框附件条 + 消息气泡内附件预览（新类型图标 / 摘要呈现） |

---

## 2. 背景与目标

v1 附件只稳妥支持图片 / PDF / Excel / 代码 / 文本 / 文件夹，PPTX/DOCX 标"暂不支持"，压缩包、音视频缺失。本轮目标：

1. **扩类型**：补齐 `audio` / `video` / `presentation`(PPTX) / `archive`(ZIP)，让模型至少拿到结构化元数据与可读摘要。
2. **省 token / 省存储**：大二进制（PPT、压缩包）**不进模型上下文、不进 DB**，只留上传时提取的轻量摘要。
3. **统一隐藏注入模式**：复用 Appshots 的"`<…>` 块对用户隐藏、对模型可见"思路，把附件内联块用同一套 strip 规则处理。

核心设计原则：**重数据在端侧提炼成摘要，二进制本体不沉淀**——既不喂给模型（省 token、避免把 data URL 当文本），也不写库（省空间）。

## 3. 附件分类与契约（`message.ts`）

`MessageAttachment.category` 扩充：

```
新增  audio        音频 MP3/WAV/M4A
新增  video        视频 MP4/WebM/MOV
新增  presentation 演示文稿 PPTX/PPT
新增  archive      压缩包 ZIP/TAR/GZ/RAR/7Z
收窄  document     从「DOCX/PPTX(暂不支持)」改为只剩 DOCX
```

新增摘要类型（均为可选、轻量）：

- **`PresentationSummary`**：`format('pptx'|'ppt')` / `slideCount` / `slides: PresentationSlideSummary[]`（`index` / `title` / `textPreview` / `textRuns` / `imageCount` / `tableCount`）/ `truncated` / `parseError`。
- **`ArchiveManifest`**：`format` / `supported` / `totalFiles` / `totalDirectories` / `totalUncompressedSize` / `totalCompressedSize` / `entries: ArchiveEntrySummary[]`（`path` / `size` / `compressedSize` / `isDirectory`）/ `dangerousEntries` / `truncated` / `note`。

附件本体新增字段：`pptJson`（`PresentationSummary` 的 **JSON 字符串**，供预览与模型上下文复用）、`archiveManifest`（结构化对象，不自动解压）。

## 4. 端侧摘要提取（`attachmentSummaries.ts`，上传时在 renderer 跑）

**`buildPresentationSummary(file)`**：
- 仅 PPTX（`.pptx` / MIME 含 `presentationml`）；legacy `.ppt` 二进制不在上传预览路径解析，直接返回 `parseError`。
- 用 `jszip` 动态导入解包，筛 `ppt/slides/slideN.xml` 按页码排序，逐页用正则取 `<a:t>` 文本运行（`extractTextRuns` + `decodeXmlEntities` 还原实体），数 `<a:blip>`（图）/ `<a:tbl>`（表）。
- 上限 **`MAX_PRESENTATION_SLIDES = 20`** 页；每页 `textPreview` 截 700 字；超限置 `truncated`。

**`buildArchiveManifest(file)`**：
- 仅 ZIP 走内联清单提取（`archiveFormatFor` 按扩展名/MIME 判 zip/tar/gz/7z/rar）；非 ZIP → `supported:false` + `note`，仅作文件附件持久化，**不内联解压**。
- ZIP：列全部 entry，算 `totalFiles` / `totalDirectories` / 解压前后总大小；上限 **`MAX_ARCHIVE_ENTRIES = 200`** 条，超限置 `truncated`。
- **zip-slip 安全检测**（`isDangerousArchivePath`）：含 `\0` / 绝对路径 / 盘符 `X:/` / 路径段含 `..` 的 entry 收进 `dangerousEntries`。

> 关键点：**两个 builder 都只产摘要、不解压、不留二进制**。模型与持久化层只见摘要。

## 5. 模型上下文序列化（`converter.ts` → `buildMultimodalContent`）

每类附件转成喂模型的内容块。准入闸 `canProcessAttachmentWithoutData` 让 audio/video/presentation/archive 即使没有 `data` 也能凭 `pptJson` / `archiveManifest` / `path` 元数据流过。

| category | 处理函数 | 产出 |
|----------|----------|------|
| `image` | `processImageAttachment` | 图片块 + 文本引导；**appshot 感知**：`appshot-` 前缀附件引导模型优先用同条消息的 `<appshot>` 文本，不要求读本地图片路径 |
| `audio` / `video` | `processMediaAttachment` | 仅元数据（名/大小/MIME/路径）+ 引导（音频可走 `speech_to_text`；不要把二进制 data URL 当文本） |
| `presentation` | `processPresentationAttachment` | 解析 `pptJson` → 页数/格式 + **前 8 页预览**（标题/图表计数/文字预览）+ 引导（完整分析走 `ppt_edit` 的 `analyze` 动作） |
| `archive` | `processArchiveAttachment` | manifest 统计 + **前 20 条 entry 预览** + 可疑路径告警 + 引导（不自动解压，解压前确认安全目标目录） |
| `pdf`/`excel`/`code`/`text`/`data`/`folder` | 各自 `process*` | （v1 既有逻辑，未变） |

`stripImagesFromMessages`（不支持视觉的模型降级路径）也做了 appshot 感知：占位文本区分"普通图片（引导走 `image_analyze`）"与"appshot（窗口文字已在 `<appshot>` 上下文里）"。

全程受 `MAX_TOTAL_ATTACHMENT_CHARS` 总量闸约束，超限停止追加。

## 6. `<attachment>` 块 strip + 持久化瘦身（`messageAttachments.ts`）

**`stripInlineAttachmentBlocks(content)`**：用正则剥掉内联 `<attachment category=…>…</attachment>` 块（镜像 Appshots 的 `stripAppshotBlocks`），收敛多余空行——**对用户隐藏、对模型可见**：展示文本不含块，但持久化/发送前的原始 content 在剥离前对模型可见。

**`sanitizeAttachmentForPersistence(attachment)`**（入库前瘦身）：
- 非图片的 `presentation` / `archive` 若 `data` 是 data URL → **剥离 `data`**（只留摘要 `pptJson` / `archiveManifest`）。
- `appshot-` 前缀附件 → 同时剥离 `path`。
- 图片 → 保留 `thumbnail`（缺省回退 `data`），不留大图原始 `data`。
- 始终保留轻量摘要字段：`sheetsJson` / `docxJson` / `pptJson` / `archiveManifest` / `folderStats` / `language` 等。

净效果：**DB 里不沉淀多 MB 的 base64 二进制，只留几 KB 摘要**，重开会话仍能渲染预览与还原模型上下文。

## 7. 持久化接线（desktop / web 双链路对齐）

`strip`（展示内容）与 `sanitize`（附件数组）成对出现在两条链路，行为一致：

- **桌面端** `SessionRepository.ts`：写入前 `sanitizeAttachmentsForPersistence`；读取行时 `stripInlineAttachmentBlocks(content)` + `sanitizeAttachmentsForPersistence(attachments)`。
- **webServer** `web/routes/agent.ts`（`/api/run` 与历史回放）+ `web/helpers/sessionCache.ts`：同样在持久化/缓存边界 strip content + sanitize attachments；`web/helpers/upload.ts` 配合附件上传。

## 8. 限制与后续

- **仅 ZIP 做内联清单 / 仅 PPTX 做内联摘要**；TAR/GZ/RAR/7Z 与 legacy `.ppt` 只作文件附件落盘，靠系统工具二次处理。
- **音视频不转写**：当前只给元数据，转写需模型/工具侧另行调用（音频引导走 `speech_to_text`）。
- **🚧 未经逐行 review**：本特性整体待 review，序列化文案、各类上限常量（20 页 / 200 条 / 8·20 预览）与 sanitize 策略均可能调整。
- 端侧解析跑在 renderer（`jszip` 动态导入）：超大 PPTX/ZIP 的解析耗时与内存占用未做压测。
