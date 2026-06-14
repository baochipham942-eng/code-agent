# Alma Artifacts Delivery 对标研究

日期：2026-06-13
范围：研究 Alma 0.0.805 到 0.0.823 的会话页 Artifacts / artifact cards / preview panel / 图片 artifact / 交付物生命周期，并映射到 code-agent 当前能力。本文先给对标判断；本分支已同步推进 P0 实现，状态见“实现推进记录”。

## 核心判断

Alma 值得借的点，是它把“模型生成的一段内容”升级成“会话里的交付物对象”。用户在聊天流里能看到 artifact card，点开进入 panel/preview，图片生成也被当作可归属、可复用、可编辑的产物处理。

code-agent 已有很多底座：`message.artifacts`、`ToolArtifact`、`WorkspacePreviewItem`、`PreviewPanel`、`WorkspacePreviewPanel`、TaskPanel outputs、verifier 和 `ArtifactIssue`。问题是这些能力还散在不同入口里，聊天主流里对交付物的表达不够强：有时是 badge，有时是文件行，有时在右侧 Workspace Preview，有时在 TaskPanel。用户很难在一个稳定心智里回答“刚才交付了什么、点哪里看、现在是什么状态、能不能继续改、能不能导出”。

P0 应该先补一条轻量统一的“交付物发现和打开路径”，复用现有 Preview/WorkspacePreview，不新建重面板。P1 再处理版本、编辑、导出、项目级资产中心和质量状态。

补充判断：Alma 直接借前四点就够，分别是 artifact card、一行描述、统一 preview/open、图片 artifact 生命周期。后面的版本、导出、项目级资产中心可以先放到 P1。优先级最高的是生成出来的东西靠不靠谱，交付物可见性服务于这个目标。

对 code-agent 来说，“可靠”要拆成两层：

1. **交付物外层可靠**：能发现、能打开、能预览、状态不乱、图片不串 session。
2. **生成过程可靠**：agent 拿到正确上下文，有明确交付契约，知道 source of truth，生成后能自检和修复。

Alma 更擅长第一层；code-agent 更应该把第二层做成自己的优势。

## 资料与证据

本次只使用本地资料：

| 来源 | 用途 |
|---|---|
| `/tmp/alma-update-20260613/release-notes-805-823.md` | 版本变化事实 |
| `/tmp/alma-update-20260613/old/extract/renderer-assets/index-DZO6LH4W.js` | Alma 0.0.805 renderer |
| `/tmp/alma-update-20260613/new/extract/renderer-assets/index-lrtJ1hZ1.js` | Alma 0.0.823 renderer |
| `/tmp/alma-update-20260613/old/extract/index.js` | Alma 0.0.805 main |
| `/tmp/alma-update-20260613/new/extract/index.js` | Alma 0.0.823 main |
| code-agent `src/shared/contract/*`, `src/renderer/components/*`, `src/renderer/utils/*`, `docs/architecture/*` | 当前能力盘点 |

关键 release notes：

- 0.0.814: artifact cards 增加短的一行描述，用于更快扫读。
- 0.0.814: 修复图片生成 placeholder，只出现在正确 chat thread。
- 0.0.814: 图片编辑在需要时 fallback 到之前生成的图片。
- 0.0.814: 修复多图编辑。
- 0.0.823: 减少主进程和数据库层卡顿，移除性能关键路径里的重 base64 处理。

## Alma Artifacts 模式与普通聊天 artifact 的关系

Alma 0.0.805 已经有 Artifacts 基础能力。renderer 里能看到：

- `WorkspaceSelectorAction` 有 `enableArtifacts` 和 `onArtifactsChange`，UI 文案走 `workspace.artifacts.title / description / enabled`。
- Chat 线程初始化 workspace 时，用 `currentThread.enableArtifacts && currentThread.artifactWorkspaceId ? artifactWorkspaceId : workspaceId`，说明 Artifact Mode 有独立 workspace 归属。
- `ArtifactWorkspaceContext` 管 file tree、selected file、streaming files、preview server、terminal sessions，并保留 `isArtifactModeEnabled`。
- `ChatMessageContent` 接收 `enableArtifacts`。当 `enableArtifacts` 为 true 时，它跳过普通 inline artifact parsing。

普通聊天 artifact 是另一条链：

- `parseXmlArtifacts()` 解析 `<artifact type="..." title="...">...</artifact>`。
- `parseExtendedCodeBlocks()` 解析 ` ```artifact:<type>:<title>` 代码块。
- `autoDetectArtifacts()` 从普通代码块里自动识别 html/react/mermaid/svg/script/code。
- `parseArtifactsWithCleanText()` 把 artifact 内容替换成 `<!--artifact:<id>-->` placeholder，并生成稳定 `artifact-${messageId}-${index}`。
- `TextWithArtifacts` 再把 placeholder 渲染成 `ArtifactIndicator`，点击后进入 `ArtifactPanel`。

关系可以概括为：

| 模式 | 入口 | 产物来源 | 展示方式 | 价值 |
|---|---|---|---|---|
| 普通聊天 artifact | assistant 文本 | XML / artifact code fence / 自动识别代码块 | 聊天正文里的 artifact indicator + 右侧 ArtifactPanel | 不打断聊天，适合偶发 HTML/React/Mermaid/SVG/code |
| Artifact Mode | workspace/thread 开关 | workspace 文件、streaming files、preview server、terminal | ArtifactWorkspace 侧栏/preview/workbench | 把会话转成围绕产物工作的模式，适合持续生成、调试、预览 |

这点对 code-agent 很关键：我们不该只做“Markdown 里解析 artifact”，也不该把所有交付物塞进 Workspace Preview 后让用户自己找。需要同时保留聊天内轻入口和右侧工作面板。

## Alma 交付物体验的产品价值

### 1. artifact card 的一行描述

release note 明确说 0.0.814 给 artifact cards 增加一行短描述。即便 minified bundle 里没有直接暴露 `artifact.description` 字段，这个产品动作本身很有价值。

一行描述解决的是扫读问题。只有标题和类型时，用户看到的是“HTML Preview / React Component / SVG Image”；有描述后，用户能知道它是“登录页 mockup”、“数据看板”、“编辑后的图片”、“生成的报告草稿”。这对会话页尤其重要，因为交付物通常夹在工具调用、思考、正文和错误之间。

code-agent 现在的 `AssistantMessage` 对 `message.artifacts` 只渲染小 badge：图标、标题、版本，没有点击动作，也没有摘要。`FileArtifactCard` 对文件有 created/modified 状态和 Preview 按钮，但只覆盖 turn timeline 里的文件输出。两者需要合并成同一套 card 语言。

### 2. preview / panel

Alma 的 `ArtifactPanel` 是独立右侧 panel，有：

- resizable width，默认约 420，最小约 300。
- 多 artifact tabs。
- code / preview view mode。
- copy、download、fullscreen、close。
- html/react/mermaid/svg/code/script 的 lazy preview renderer。

此外新包拆出了类型化 preview assets：`ImagePreview`、`PdfPreview`、`DocxPreview`、`ExcelPreview`、`PptxPreview`、`ZipPreview`、`AudioPreview`、`VideoPreview`、`HtmlRenderer`、`ReactRenderer`、`MermaidRenderer` 等。

code-agent 也有成熟预览底座：

- `PreviewPanel` 支持多 tab、LRU 8 个、编辑/保存、Markdown/CSV/CodeMirror、HTML iframe、图片/PDF data URL、Finder reveal/open。
- `WorkspacePreviewPanel` 是会话/项目级 artifact workbench，能展示 `design_ppt`、chart、spreadsheet、document、generic_html、question_form、gallery、Prompt Apps。
- `TaskPanel` outputs 能从当前 turn ownership 打开 Workspace Preview。

差距在入口一致性。Alma 的 artifact card 点开后就是 panel；code-agent 的入口分散在消息 badge、Trace outputs、TaskPanel outputs、Workspace Preview 列表、PreviewPanel 文件 tab。用户需要知道内部概念，才知道该去哪看。

### 3. 图片 artifact

Alma 0.0.814 的图片改动很说明问题。旧 main 的 `handleImageGenerationRequest()` 只从当前 user message 取 image parts 作为 reference images。新 main 抽了一个 `collect image parts` 逻辑：

- 先收当前消息里的 image parts。
- 如果当前消息没有图片，则向前找最近一条带图片的 user/assistant message，作为 fallback reference。
- OpenAI image edits 请求在多图时把 form 字段改为 `image[]`，单图仍用 `image`。
- 生成结果写入消息前走 `persistUIMessageImages()`。

placeholder 归属也有明确修复：

- 旧 renderer 使用 `isImageGenerating` 布尔值。
- 新 renderer 改成 `imageGeneratingThreadId`，并派生 `isImageGenerating = imageGeneratingThreadId != null && imageGeneratingThreadId === threadId`。
- `thread_generating` 和 `generation_error` 都按 thread id 清理这个状态。

这说明图片 artifact 的重点在生命周期，单纯显示图片只覆盖表层：

- 生成中状态绑定 thread。
- 生成结果持久化，避免 base64 在性能关键路径里反复跑。
- 图片编辑可以继承上一轮产物。
- 多图编辑要保存输入关系。
- 图片应该进入 artifact list，不能只停留为消息附件。

code-agent 当前图片相关能力较散：附件图片可内联，PreviewPanel 可预览本地图片，工具侧能通过 `createFileArtifact()` 标记 image 文件，ToolCallDisplay 能渲染 base64 image result，但还没有把图片作为可继续编辑/版本化的交付物对象贯穿起来。

## 产出可靠性主线

爸补的这个点更关键。artifact card、preview、panel 都是交付外壳；真正影响用户信任的是生成物本身是否对题、完整、可运行、可验收。这里 Alma 给的启发有限，code-agent 应该结合自己的工具链和验证链路做得更深。

可靠性可以按生成前、生成中、生成后三段拆。

| 阶段 | 现在容易出问题 | 应该补的能力 | 用户可感知结果 |
|---|---|---|---|
| 生成前 | 上下文散在聊天、文件、工具结果里，agent 容易拿错目标或漏掉约束 | 构造 `Context Pack`：目标、约束、相关文件、已有产物、source of truth、验收口径 | 产物更贴题，少返工 |
| 生成中 | 工具输出只是文件或文本，缺少产物契约 | 引入 `Deliverable Contract`：产物类型、预期用途、输入来源、必须满足的验收项 | agent 生成时有边界，不容易做偏 |
| 生成后 | 交付物能打开，但质量要靠用户自己判断 | 生成 `Evidence Pack`：运行结果、截图、校验、lint/test、文件 hash、已知风险 | 用户知道这份东西是否已经过验证 |
| 修复时 | 上一版产物和修改要求没有稳定绑定 | 维护 `Revision Context`：父产物、修改意图、差异、失败原因、下一轮约束 | 改图、改文档、改页面时能延续上一版 |

这条线比单纯借鉴 Alma 更适合我们。code-agent 已经有 verifier、PreviewPanel、TaskPanel、WorkspacePreview、工具元数据和本地文件访问能力，缺的是把这些东西组织成“交付前后都能复用的上下文”。

### Context Pack

每次产出交付物前，系统应该给 agent 一个薄的上下文包，避免把整段历史塞进去。建议结构：

- `goal`: 用户本轮真实目标。
- `deliverableType`: 文档、表格、图片、网页、报告、dashboard、代码变更等。
- `sourceOfTruth`: 用户点名文件、URL、数据列、设计稿、上一版产物。
- `constraints`: 不能改哪些文件、输出格式、语言、风格、权限、时间范围。
- `priorArtifacts`: 可复用的上一版产物和文件路径。
- `acceptance`: 用户或系统可验证的完成标准。
- `riskNotes`: 容易错的点，例如 base64 大图、跨 session 状态、路径归属、数据口径。

这能直接减少“看起来像，但偏离用户目标”的产物。

### Deliverable Contract

生成过程中需要一个比 `message.artifacts` 更面向任务的契约。P0 不必新建 DB 表，可以先作为 view/model 层对象：

- 产物要交付给谁看。
- 产物解决哪个用户问题。
- 输入来自哪些文件或工具结果。
- 输出应该长什么样。
- 哪些检查必须通过。
- 失败时应该暴露什么状态。

这个契约可以喂给 UI card，也可以喂给 verifier。这样 card 上的一行描述会来自真实任务语义，展示文案也更可验证。

### Evidence Pack

每个重要交付物都应该附一份轻量证据：

- 文件是否存在，路径是否可打开。
- 对应 preview 是否能渲染。
- 对网页/HTML/dashboard，是否有截图或浏览器 smoke。
- 对代码变更，是否跑过相关测试、typecheck 或 lint。
- 对表格/文档，是否能用解析器回读关键单元格或段落。
- 对图片，是否已经落盘，尺寸、mime、hash 是否记录。

这部分要避免做成复杂审核流。P0 可以先把 evidence 显示成 card 的验证状态，P1 再接 `ArtifactIssue` 和 Admin Review Queue。

### Revision Context

图片 artifact 和文档 artifact 最需要这块。用户说“继续改这张图”“把刚才那个报告换成中文”“上一版太散了”时，系统要知道：

- “刚才那个”指哪个 artifact。
- 这一轮改动基于哪个 parent。
- 上一版输入来源是什么。
- 上一版有哪些验证结果或失败原因。
- 新旧版本之间的差异如何描述。

Alma 的 previous image fallback 值得借，但 code-agent 应该泛化成所有交付物的 revision context。

## code-agent 当前能力盘点

### 已有底座

| 能力 | 现状 | 证据 |
|---|---|---|
| 消息内结构化 artifact | `Message.artifacts` 支持 chart/spreadsheet/document/generative_ui/mermaid/question_form，带 `version` 和 `parentId` | `src/shared/contract/message.ts` |
| 工具输出 artifact 元数据 | `ToolArtifact` 支持 text/binary/image/audio/video/document/spreadsheet/web/search/process-output/process-log，含 path/url/mime/size/hash/preview/sessionId | `src/shared/contract/artifactBlob.ts`、`src/main/tools/artifacts/artifactMeta.ts` |
| 右侧文件预览 | `PreviewPanel` 多 tab、HTML/Markdown/CSV/code/image/pdf、编辑保存、reveal/open | `src/renderer/components/PreviewPanel.tsx` |
| 会话/项目级预览 | `WorkspacePreviewPanel` 展示 preview item、Design PPT、chart、spreadsheet、document、generic_html、gallery | `src/renderer/components/WorkspacePreviewPanel.tsx` |
| 当前 turn outputs | `buildArtifactOwnershipItems()` 从 assistant artifact、tool outputPath、metadata path、metadata.artifact(s) 生成 ownership item | `src/renderer/utils/artifactOwnership.ts` |
| Workspace preview 聚合 | `buildWorkspacePreviewItems()` 合并 permission preview、current turn artifacts、tool outputs、message artifacts，并排序去重 | `src/renderer/utils/workspacePreview.ts` |
| TaskPanel 输出入口 | `CurrentTurnArtifactOwnershipCard` / `OutputFileRows` 可跳 `openWorkspacePreview(itemId)` | `src/renderer/components/TaskPanel/OutputArtifactRows.tsx` |
| 质量验证 | Game/Deck/Dashboard verifier、browser visual smoke、repair guard、`ArtifactIssue`、Admin Review Queue | `docs/architecture/artifact-verification.md` |
| 项目级产物容器 | Project Space 已把中心视图定义为项目维度产物列表，但 P1 留了“产物聚合纳入工具输出文件” | `docs/designs/project-space.md` |

### 还没有成体系的地方

1. **消息页发现弱**
   `AssistantMessage` 的 artifact bar 是不可点击 badge。Trace 里的 `FileArtifactCard` 可点，但只覆盖文件输出，而且出现位置依赖 turn timeline。

2. **三套对象模型没有统一面向用户**
   `Message.artifacts`、`ToolArtifact`、`WorkspacePreviewItem` 都像 artifact，但字段、状态、动作和 UI 入口不一致。`ArtifactIssue` 又是质量层对象，没有自然回挂到聊天卡片。

3. **preview 和 artifact card 的关系不稳定**
   有的 card 打开 PreviewPanel，有的打开 WorkspacePreview，有的只显示，不打开。用户看不到“交付物对象 -> 预览/编辑/导出/质量状态”的稳定路径。

4. **图片还停在文件/附件层**
   image 作为 `ToolArtifactKind` 已存在，PreviewPanel 也能看图片，但聊天中的图片生成、图片编辑、占位状态、上一轮图片 fallback、多图关系还没有统一产品模型。

5. **版本字段有，但版本体验没有闭环**
   `Message.Artifact` 有 `version` 和 `parentId`，但 UI 里只是显示 `vN`。文件输出更没有版本线。用户无法比较版本、回退版本、沿用上一版编辑。

6. **导出能力散落**
   PreviewPanel 可导出 HTML 长截图，ArtifactPanel 式下载在 code-agent 没有统一动作。DOCX/XLSX/PPTX/PDF 生成工具各自写文件，但会话页没有统一 export surface。

## 对标差异

| 维度 | Alma | code-agent 当前 | 借鉴方向 |
|---|---|---|---|
| 交付物发现 | 聊天里有 artifact card/indicator，Artifact Mode 有 workspace 侧栏 | 聊天 badge、Trace file card、TaskPanel outputs、WorkspacePreview 列表分散 | 建统一 DeliverableCard，聊天主流和 TaskPanel 共用 |
| 打开路径 | artifact -> ArtifactPanel，文件 -> 类型化 preview | 文件可 `openPreview`，WorkspacePreview 可选 item，但入口不一 | card 主按钮统一 `Preview/Open`，内部路由到现有面板 |
| 预览类型 | 专门拆 Image/PDF/Office/Zip/Audio/Video/HTML/React/Mermaid renderer | PreviewPanel 覆盖 HTML/MD/CSV/code/image/pdf；WorkspacePreview 覆盖部分结构化产物 | 先复用现有，P1 补 Office/Zip/Audio/Video 类型矩阵 |
| 图片 artifact | thread-scoped placeholder、persist image、fallback previous image、多图 edits | 图片可附件/文件预览，生成链路未统一为 artifact 生命周期 | P0 先让 image ToolArtifact 进 card/preview，P1 再做编辑 lineage |
| 状态 | generating/error/thread state 和 artifact panel 状态结合 | `WorkspacePreviewStatus` 有 draft/ready/applied/sent/failed，turn timeline 有 tone，但聊天卡片未统一显示 | Deliverable status 从现有字段派生，不先上新 DB |
| 版本 | inline artifact 有稳定 id、panel tabs，多版本能力从 UI 可感知 | `version/parentId` 存在但展示弱；文件缺 lineage | P0 只显示 latest/created/modified，P1 做 lineage |
| 质量 | release note 不突出，但 artifact panel 是交付入口 | verifier 和 `ArtifactIssue` 底座强 | P1 把 quality issue 显示回 deliverable card |
| 导出 | ArtifactPanel 有 download，图片/preview assets 自带操作 | PreviewPanel 有保存/打开/截图，工具文件本身可导出 | P0 用 open/reveal/save，P1 做统一 download/export |

## 推荐开发切片

优先级要调整：前四个 Alma 借鉴点做外层入口，同时把可靠性作为主线插进去。实际开发顺序建议是 `Context Pack -> Deliverable Contract -> DeliverableCard -> Preview/Open -> Evidence Pack -> Image lifecycle`。这样 UI 入口不会变成纯装饰。

### P0-0 上下文组织与交付契约

目标：让 agent 在生成产物前拿到正确上下文，并把交付要求结构化。

做法：

- 新增一个轻量 `DeliverableContext` / `ContextPack` adapter，先不持久化。
- 从当前 session、用户最新请求、tool outputs、workspace preview items、message artifacts、选中文件中提取上下文。
- 明确记录 `goal`、`deliverableType`、`sourceOfTruth`、`constraints`、`priorArtifacts`、`acceptance`。
- 把它提供给交付物生成链路和 card adapter。

验收：

- 用户点名文件或上一版产物时，Context Pack 能保留该引用。
- 生成 card 的描述能来自 Context Pack，避免只从文件扩展名猜。
- 对同一轮里多个产物，能区分各自的 source 和 expected output。

风险：

- 不能把完整聊天历史粗暴塞进 Context Pack。这里要做摘要和引用，不复制大段内容。
- source of truth 必须保留路径、列名、消息 id 或 artifact id，不能只保留自然语言描述。

### P0-1 Evidence Pack 最小闭环

目标：每个关键交付物都带一份最低限度验证证据。

做法：

- 对文件产物记录 exists、size、mime、sha256、previewable。
- 对 HTML/Markdown/image/pdf 等可预览产物记录 preview route。
- 对代码产物挂接已运行的 test/typecheck/lint 摘要。
- 对 dashboard/report/game/deck 这类已有 verifier 的产物，接入现有 evidence 摘要，不重做审核系统。

验收：

- card 能显示未验证、已验证、验证失败三类状态。
- 失败状态能展示具体原因，例如文件不存在、preview 失败、测试失败。
- evidence 不保存大 base64，只保存路径、hash、摘要和截图引用。

风险：

- P0 只做 evidence 摘要，不引入复杂质量评分。
- 验证失败不能阻塞用户打开产物，只提醒风险。

### P0-2 统一 Deliverable Descriptor 和 Card

目标：聊天主流里每个交付物都能被看见、扫读、点击。

做法：

- 新增一个纯前端 adapter，比如 `buildDeliverableCardsFromTurn()` 或复用/扩展 `buildWorkspacePreviewItems()`，把 `Message.artifacts`、`TurnArtifactOwnershipItem`、`ToolArtifact` 映射成统一 `DeliverableCardView`。
- 字段至少包括 `id`、`kind`、`title`、`description`、`status`、`sourceLabel`、`path/url`、`previewItemId`、`primaryAction`。
- `description` 先用确定性规则生成：`<kind label> · <source tool/agent> · <status/version/path summary>`。不引入 LLM 摘要。
- 替换 `AssistantMessage` 里的不可点击 artifact badge；Trace 的 `FileArtifactCard` 和 TaskPanel 的 Output rows 尽量共用同一张小卡。

验收：

- assistant `message.artifacts` 渲染为可点击 card，并能打开 Workspace Preview 对应 item。
- tool output file 渲染同样 card，HTML/MD/CSV/image/pdf 能打开 PreviewPanel 或 Workspace Preview。
- card 至少显示标题、类型、来源、状态或版本，不再只显示 `vN`。
- 单测覆盖 adapter 去重、排序、description fallback。

风险：

- 不要直接把三套 contract 合并成一个持久化模型，P0 先做 view adapter。
- read-only 工具输出仍要过滤，沿用 `isReadOnlyArtifactTool()`。

### P0-3 统一 Preview/Open 路由

目标：用户点任何交付物，都会进入一个合理预览位置。

做法：

- 对有 `WorkspacePreviewItem` 的对象，优先 `openWorkspacePreview(item.id)`。
- 对纯文件 path，走 `openPreview(path)`。
- 对 `generative_ui/chart/spreadsheet/document/question_form/mermaid` 这类 message artifact，优先构造 WorkspacePreview item 并选中。
- 对 url/link，先提供 copy/open external，不强行塞 PreviewPanel。

验收：

- chat card、Trace outputs、TaskPanel outputs 打开同一个目标时不会生成重复 preview tab。
- 相对路径按 `workingDirectory` 解析。
- 非 previewable 文件仍能 open/reveal，不出现死按钮。

风险：

- PreviewPanel 和 WorkspacePreviewPanel 都能处理 HTML，路由规则要明确，避免同一个 HTML 一会儿进 file tab，一会儿进 workspace item。

### P0-4 图片 artifact 最小闭环

目标：生成或工具产出的图片在会话里成为可预览交付物。

做法：

- 确保 metadata.artifact(s) 里 `kind: "image"` + `path` 的输出能进入 `TurnArtifactOwnershipItem` 和 `WorkspacePreviewItem`。
- `FileArtifactCard` / DeliverableCard 对图片扩展 previewable extensions，当前只列了 md/html/jsx/tsx/csv/tsv/txt，缺 png/jpg/webp/svg。
- 如果有 base64 image tool result，优先落盘或生成 virtual artifact，避免只停留在 ToolCallDisplay 里。
- 生成中占位状态必须带 session/thread id，不使用全局布尔。

验收：

- 一次截图、二维码、图表或图片生成工具输出后，聊天里出现 image card。
- 点击 image card 能在 PreviewPanel 看到图片。
- 切换到其他 session 不显示当前 session 的图片生成 placeholder。
- 多张图片输出按单个交付物组或多 card 展示，标题可区分。

风险：

- base64 不能进高频状态树，参考 Alma 0.0.823 的性能修复，图片应尽早变成文件引用或缓存引用。

### P0-5 交付物状态接线

目标：用户能知道交付物是生成中、已就绪、失败、已应用，还是只是草稿。

做法：

- 先复用 `WorkspacePreviewStatus`：draft/ready/applied/sent/failed。
- tool result success -> ready/failed。
- permission preview -> draft。
- current turn artifact -> ready 或根据 timeline tone 显示 warning/error。
- verifier issue 不进 P0 card 主流程，只预留 `qualityTone` 字段。

验收：

- 失败的工具输出 card 显示 failed，不能假装 ready。
- permission diff 显示 draft/review。
- 当前 turn 输出在 streaming 时不会闪成完成态。

风险：

- 状态来源多，P0 不要追求全局状态机，先做确定性映射。

## P1 借鉴方向

1. **版本与 lineage**
   把 `Message.Artifact.parentId/version` 和文件 path/hash 统一成 artifact revision。支持“查看上一版 / 比较 / 从这版继续改”。

2. **图片编辑生命周期**
   借 Alma 的 fallback previous image、多图 reference 关系，建立 image artifact 的 source images、edit prompt、result image、parent revision。

3. **质量状态回挂**
   把 `ArtifactIssue` 和 verifier evidence 显示到 DeliverableCard 上：needs review、request changes、validated、failed smoke。

4. **项目级资产中心补全工具输出**
   `project-space.md` 已注明 P1 留了“产物聚合纳入工具输出文件”。这里应该升级 `getProjectArtifacts/buildProjectArtifacts`，让工具输出文件、message artifacts、design_ppt、dashboard/game/deck verifier artifacts 都能跨 session 归并。

5. **统一导出**
   DeliverableCard 提供 download/export bundle。HTML 支持 screenshot/PDF，PPTX/DOCX/XLSX 直接打开/导出，图片支持 copy/download，dashboard/game 支持 zip/package。

6. **类型化 preview 矩阵**
   对齐 Alma 的 Office/Zip/Audio/Video preview assets。code-agent 可以先补 WorkspacePreviewPanel，避免重写 PreviewPanel。

7. **Artifact Mode 产品化**
   code-agent 已有 Project Space / Workspace Preview，未来可以给“产物模式”一个明确入口：会话进入以交付物为中心的布局，聊天是控制流，右侧是产物工作台。

## 验收方式

P0 文档转开发后，建议用四类验收：

| 类型 | 验收点 |
|---|---|
| Unit | deliverable adapter：message artifacts、tool artifacts、current turn outputs、read-only 过滤、路径归一、去重、状态映射 |
| Renderer | `AssistantMessage` / `TraceNodeRenderer` / `TaskPanel` 渲染 clickable card，点击触发 `openWorkspacePreview` 或 `openPreview` |
| Integration | 构造一轮含 HTML、Markdown、图片、失败 tool output、question_form 的消息，确认右侧工作面板选中正确 item |
| Manual smoke | 启动 app 或 web mode，跑一轮真实文件生成，确认聊天主流、TaskPanel、WorkspacePreview 三处看到同一个交付物 |

图片专项验收：

- 当前 session 生成图片时有 placeholder。
- 切到另一 session 没有 placeholder。
- 生成完成后 placeholder 消失，图片 card 出现。
- 多图输出时，每张图都有可打开路径，或以 gallery group 展示。
- image card 不保存大 base64 到 Zustand 高频状态。

## 风险与边界

- **不要先重构持久化模型**：`Message.artifacts`、`ToolArtifact`、`WorkspacePreviewItem`、`ArtifactIssue` 都已有调用方，P0 用 view adapter 收束 UI。
- **不要新建第三个大 preview 面板**：先复用 `PreviewPanel` 和 `WorkspacePreviewPanel`，只统一入口。
- **避免 base64 性能问题**：Alma 0.0.823 明确修过 heavy base64 卡顿，图片和大文件应走 path/cache/url。
- **版本线不要偷做半套**：P0 只显示现有版本/状态；P1 再做 revision model。
- **Artifact Mode 和普通 inline artifact 分属两条链路**：Alma 在 `enableArtifacts` 时跳过普通 inline parsing。code-agent 如果做“产物模式”，也要明确是布局/工作流模式，不能只落成 Markdown 语法。
- **质量验证不要塞进点击路径**：verifier 和 admin review 是质量层，P0 卡片只显示状态入口，避免用户点开预览前先被 review 流程挡住。

## 实现推进记录

本分支已把 P0 的外层入口和可靠性骨架落到代码里，但没有扩持久化表，也没有新建 preview 面板。

已落地：

- 新增 shared `Deliverable*` 契约：`Context Pack`、`Deliverable Contract`、`Evidence Pack`、`Revision Context`、打开目标和 card view model。
- `AssistantMessage`、`FileArtifactCard`、`TaskPanel` 当前 turn 产出统一渲染 `DeliverableCardList`，聊天主流和任务区共享一套 card 语言。
- card 有标题、一行描述、验证状态和统一打开动作；能路由到 `WorkspacePreviewPanel`、`PreviewPanel` 或外部链接。
- `WorkspacePreview` 聚合开始读取 tool metadata 的 `artifact/artifacts`，保留 path/url、mime、size、sha256、preview summary，图片 artifact 能成为可预览交付物。
- `image_generate` 不再默认把图片只留在 base64 结果里；未传 `output_path` 时自动保存到 `.code-agent/artifacts/images`，并返回带 path/size/hash 的 image file artifact。
- `ToolArtifact` 和 `WorkspacePreviewFileRef` 补齐 `sizeBytes`、`sha256`、`preview` 这类证据字段。
- `WorkspacePreviewItem` 和 `DeliverableCardView` 已能承载 revision、quality summary 和二级动作；card 可显示质量失败/待审/已验证，并提供 reveal/copy 这类继续处理入口。
- 项目级 `ProjectArtifact` 聚合已从 assistant inline artifact 扩展到 tool artifact metadata，工具生成的图片、文档、网页、日志等文件能进入跨 session 项目产物列表。
- artifact generation prompt 增加 `Context Pack`、`Deliverable Contract`、`Evidence Pack`、`Revision Context` 要求，让生成前上下文、交付契约、验证证据和继续修改关系进入 agent 工作流。
- 图片生成中的 pending card 已由当前 assistant message 的 running `image_generate` tool call 投影出来，天然跟 session/message 绑定；生成完成后 pending card 消失，真实 image artifact card 接管。
- 工具执行出口已增加通用 base64 图片持久化后处理；非 `image_generate` 工具只要返回 `imageBase64` / data URL，也会自动落到 `.code-agent/artifacts/images`，并补 artifact path、size、sha256，同时移除大 base64 metadata。
- `PreviewPanel` 已支持 audio/video data URL 预览；WorkspacePreview 类型矩阵已区分 image/audio/video/presentation/archive，Zip 走结构化 entry inspector。
- Office inline preview 已补齐到可用闭环：DOCX 复用 mammoth 段落提取并用 `DocumentBlock` 渲染，XLS/XLSX 复用表格 JSON 提取并用 `SpreadsheetBlock` 渲染，PPTX 走只读 slide outline inspector，展示 slide 列表和文本内容；旧 `.doc/.ppt` 仍走外部打开。
- `ArtifactIssueRepository` 已通过项目 IPC 提供只读 `artifactIssues` 查询，WorkspacePreview 会按 artifactId 拉取真实 issue 并回挂到质量状态。
- 已增加 `exportBundle` 工作区 IPC；deliverable card 和 WorkspacePreview 选中项都能把文件连同 manifest、context、evidence、revision、quality 信息打成 zip 交付包。
- Workspace Preview 已有 artifact revision 面板：同一 `parentId/version` 链路的 message/tool artifact 能保留历史版本、切换版本，并对 HTML/JSON/text 等内联内容展示 diff。
- 文件类交付物在有 message checkpoint 锚点时，Workspace Preview 能直接触发 checkpoint restore；该动作恢复的是该消息检查点及之后的文件变更，不伪装成单文件精准回滚。
- 测试覆盖 `deliverables` adapter、`workspacePreview` rich metadata、当前 turn ownership、workbench tabs 和 TaskMonitor 相关组件。

仍未落地：

- 单 artifact 精准回滚还没有独立 revision store；当前恢复能力复用文件 checkpoint，粒度是 message checkpoint。
- Office preview 目前是结构化内联预览，不做 PPTX 视觉还原，也不支持旧 `.doc/.ppt` 二进制格式。

## 结论

code-agent 的底座比 Alma 更宽，尤其是 verifier、TaskPanel、Project Space、本地文件预览和工具元数据。Alma 更连贯的是“交付物被用户看见并继续处理”。直接借鉴范围收束到前四点：artifact card、一行描述、统一 preview/open、图片 artifact 生命周期。

更大的目标是产出可靠性。card 和 preview 只能降低发现成本，真正减少返工的是 `Context Pack`、`Deliverable Contract`、`Evidence Pack` 和 `Revision Context`。

当前分支推进后的优先级判断：

1. P0 的上下文组织、交付契约、Evidence Pack、DeliverableCard、统一打开路由和 image artifact 最小闭环已经进入实现。
2. P1 的质量状态、项目级资产聚合、统一导出、类型化 preview 矩阵、版本查看/比较和 checkpoint restore 已经进入实现。
3. 后续真正值得继续补的是更深的可靠性：单 artifact revision store、精准回滚、图片多源编辑 lineage、PPTX 视觉级预览，以及生成后自动 smoke/evidence 的覆盖率。
