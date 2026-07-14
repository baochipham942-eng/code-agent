# ADR-040 — Artifact Locator 契约：预览定点与编辑目标统一对账

- **状态**: Proposed（等待产品负责人拍板；本 ADR 不授权施工）
- **日期**: 2026-07-14
- **产品边界**: Agent Neo 是以方案、PPT、表格、文档等产物为主轴的 cowork 人机协作产品；默认操作者不会读代码，也不应承担坐标换算和误改排查成本。
- **基线**: `fix/attachment-spreadsheet-filepath` @ `aa66f25dc`；保留 `3e6575b40` 与 `aa66f25dc`，不改 `DocEdit` / `ppt_edit` 工具实现。
- **相关**: `src/shared/livePreview/localityFeedback.ts`、`src/host/ipc/settings.ipc.ts`、`src/host/ipc/workspaceArchive.ipc.ts`、`src/host/tools/modules/document/docxEditCore.ts`、`src/host/tools/modules/network/pptEdit.ts`

## 问题与证据基线

当前定点反馈把 `filePath + slideIndex/cell` 拼进自然语言，再由模型选择编辑工具；共享类型只有 PPT 和 Sheet 两种锚，发送通道只接收字符串（`src/shared/livePreview/localityFeedback.ts:8-67`，`src/renderer/stores/messageActionStore.ts:16-29`、`48-52`）。这条链缺少结构化 locator、写前 revision 校验和目标一致性闸。

| 产物 | 预览侧已核实行为 | 编辑侧已核实行为 | 当前判断 |
|---|---|---|---|
| Excel | UI 用列号和数据行生成 A1 引用；当前 active sheet 已在组件状态中，但发送锚点时只传 `cell`，没有传现成的 `sheet.name`（`src/renderer/components/features/chat/MessageBubble/SpreadsheetBlock.tsx:190-218`、`395-435`、`464-465`） | `set_cell` 直接以 `op.cell` 取单元格；缺省 `sheet` 时取 workbook 第一张表（`src/host/tools/excel/excelEdit.ts:104-123`） | A1 坐标可直接沿用；新契约应把已知 sheetName 一并带上，避免多 sheet 时退回第一张表 |
| Word | `mammoth` HTML 经 `<h1-6\|p\|li>` 正则抽取，空文本直接跳过且 `idx` 不增长（`src/host/ipc/settings.ipc.ts:700-745`）；Workspace 预览还会再次过滤空文本（`src/renderer/components/PreviewPanel.tsx:150-169`） | `replace_paragraph` / `delete_paragraph` 按 `word/document.xml` 中全部 `<w:p>` 的序数执行（`src/host/tools/modules/document/docxEditCore.ts:123-164`）；`replace_text` 只在单个 `<w:t>` 内执行 `includes`（同文件 `92-116`） | 预览序号不能进入 index 操作；纯文本匹配可见失败但不可靠 |
| 上传 PPTX | 上传摘要和 Workspace inspection 都按 `slideN.xml` 文件名排序；上传消息只展示前两页摘要，Workspace fallback 是不可点的文字大纲（`src/renderer/components/features/chat/ChatInput/attachmentSummaries.ts:97-135`，`src/host/ipc/workspaceArchive.ipc.ts:237-291`，`src/renderer/components/features/chat/MessageBubble/AttachmentPreview.tsx:401-426`，`src/renderer/components/PreviewPanel.tsx:317-352`） | 页内文本操作把 `slide_index` 直接换算成 `slide${slide_index + 1}.xml`（`src/host/tools/modules/network/pptEdit.ts:145-193`） | 显示页与物理 slide part 没有共同真源 |
| 生成 PPTX | design artifact 保存 screenshots 数组，UI 用数组下标作为 `selectedIndex` 并原样发送为 `slideIndex`（`src/host/tools/modules/network/pptGenerate.ts:102-125`，`src/renderer/components/workspacePreview/parts.tsx:285-357`） | 同上，写入目标是 `slide${slide_index + 1}.xml`（`src/host/tools/modules/network/pptEdit.ts:145-193`） | 当前连续同序的生成链可继续使用；迁移不得改变既有 prompt 中的 `slide_index` |

写侧额外边界也已核实：`ppt_edit` 执行代码接受 9 个 action（`src/host/tools/modules/network/pptEdit.ts:24-56`）；`insert_slide` 只返回提示（同文件 `219-223`）；`delete_slide` 用 `rId${slide_index + 2}` 猜 presentation 关系（同文件 `197-215`）；`update_notes` 用 `notesSlide${slide_index + 1}.xml` 猜备注 part（同文件 `419-440`）。因此 locator 首批只承诺把页内 `replace_title` / `replace_content` / `replace_slide` 定到正确 slide part；删除、重排、备注属于结构动作，不进入首批定点反馈授权面。本 ADR 记录边界，不修改工具。

## 决策草案

采用一个版本化 envelope，加三种 kind-specific target。公共层只统一产物身份、revision、显示标签和失败语义；坐标保持各自领域原生语义，不造一个跨 Excel/PPT/Word 的通用 `index`。

```ts
type ArtifactLocatorV1 = {
  version: 1;
  artifact: {
    kind: 'spreadsheet' | 'presentation' | 'document';
    filePath: string;
    revision: { algorithm: 'sha256'; value: string };
  };
  target:
    | {
        kind: 'sheet-range';
        sheetName: string;
        a1: string; // B7 或 A1:C2
      }
    | {
        kind: 'ppt-slide';
        displayIndex: number; // 0-based，只用于 UI 与对账
        relationshipId: string;
        slidePartName: string; // ppt/slides/slide7.xml
        textFingerprint: string;
      }
    | {
        kind: 'docx-paragraph';
        partName: 'word/document.xml';
        paragraphIndex: number; // document.xml 全部 <w:p> 的 0-based 序数
        textFingerprint: string;
        previousTextFingerprint?: string;
        nextTextFingerprint?: string;
      };
  display: { label: string; excerpt?: string };
};
```

这段 TypeScript 是规范形状，不是本轮实现代码。`WorkspacePreviewRevision` 已有 `filePath` / `sha256` 字段，可作为 revision 语义的现有落点参考（`src/shared/contract/workspacePreview.ts:72-81`）；仓内也已有流式 SHA-256 文件计算实现（`src/host/tools/artifacts/artifactMeta.ts:86-93`）。新 locator 生产者必须给 revision；legacy adapter 只在迁移期允许无 revision 输入，并在 host 侧补算后再生成 V1。

### 公共不变量

1. **本地文件身份**：`filePath` 必须解析为本地源文件；HTTP(S) URL 不得进入可编辑 locator。现有附件层已经只向 Excel/Word 传递以 `/` 开头的路径，并有 URL 负向测试（`src/renderer/components/features/chat/MessageBubble/AttachmentPreview.tsx:222-226`、`393-399`，`tests/renderer/components/attachmentPreview.spreadsheetFilePath.test.tsx:29-49`）。正式实现应在 host resolver 再校验一次，renderer 判断不作为安全边界。
2. **revision fail-closed**：点击后、写入前重新计算 revision；不一致时停止并显示“文件已变化，请刷新预览后再改”，禁止靠旧 index 猜目标。
3. **显示坐标不可执行**：`displayIndex`、`display.label` 只服务非程序员识别位置；写入参数只能由 resolver 从 kind-specific target 推导。
4. **模型不能改坐标**：locator 作为结构化消息 metadata 持久化；自然语言 prompt 仍保留人可读位置和 tool 参数，执行前 guard 核对模型提交的 `file_path` 与坐标是否等于 resolver 结果。当前 `MessageMetadata` 没有 locator 字段，`sendPrompt` 也只接收字符串（`src/shared/contract/message.ts:235-243`，`src/renderer/stores/messageActionStore.ts:16-29`、`48-52`），这部分属于真实开发，不按接线估算。
5. **失败可见且不落盘**：revision、fingerprint、relationship、范围任一校验失败时都不调用写工具；错误要指向“刷新预览”或“重新选择位置”，不把内部 XML 名称丢给用户。

## 各产物坐标

### Excel：`sheetName + A1`

Excel 保留 A1，不做抽象翻译。新生产者必须发送当前 `sheet.name`；当前组件已有 active sheet 与 `sheet` 对象，只缺锚点接线（`src/renderer/components/features/chat/MessageBubble/SpreadsheetBlock.tsx:201-230`、`430-435`）。resolver 输出 `DocEdit` 的 `sheet` 与 `cell/range`，仍走现有 `getWorksheet(..., sheetName)` 和 `ws.getCell(op.cell)`（`src/host/tools/excel/excelEdit.ts:104-123`）。

兼容规则：旧 `{kind:'sheet', cell}` 保持可用；单 sheet 文件补成第一张 sheet，多 sheet 文件必须从当前 UI 状态补 `sheetName` 后再发。现有 A1 prompt 的可读文本与 `DocEdit` 引导保持不变，已有正向测试继续作为回归门（`tests/unit/shared/localityFeedback.test.ts:29-50`）。

### Word：真实 XML 序号作为执行坐标，复合指纹作为安全闸

#### 方案取舍

| 方案 | 收益 | 代价与风险 | 决策 |
|---|---|---|---|
| 继续用 mammoth 可见序号 | 零开发 | 已核实会跳过空段落，且写侧统计全部 `<w:p>`（`src/host/ipc/settings.ipc.ts:719-740`，`src/host/tools/modules/document/docxEditCore.ts:123-164`） | 否决 |
| 只换成 `document.xml` 的 `<w:p>` 序号 | 与当前 index executor 对齐 | 预览后文件发生增删时，旧序号仍可能指向另一段 | 不单独采用 |
| 只用原文或文本指纹 | 对插入空段较耐受，可检测 drift | 当前 `replace_text` 只能匹配单个 `<w:t>`；Word run 拆分时会得到 0 occurrences（`src/host/tools/modules/document/docxEditCore.ts:92-116`），重复段落也缺少唯一执行坐标 | 只作校验，不作主坐标 |
| 稳定 id | 若源文件有稳定 id，重排后仍可追踪 | 当前 executor 只消费 index，已核实现有代码没有 id 到 index 的 resolver（`src/host/tools/modules/document/docxEditCore.ts:123-164`、`321-365`）；是否所有目标文档都带可用 id，本轮未核实 | 暂不作为必填字段 |
| XML 序号 + 当前/邻居文本指纹 + 文件 revision | 直接复用现有 index executor，同时在调用前识别 stale locator、重复文本和错位 | 需要新的 OOXML reader/resolver 与契约测试 | **推荐** |

#### 读取与解析规则

预览 extractor 改为读取 `word/document.xml`，按写侧同一谓词枚举全部 `<w:p>`。每个可见段落保留原始 `paragraphIndex`；空段落可以不渲染，但不能压缩后续 index。表格单元格内的 `<w:p>` 也进入同一序列并可显示，确保用户看到的可点条目能回到写侧同一 paragraph。

段落文本从该 `<w:p>` 内全部 `<w:t>` 聚合后规范化；heading 类型读取 `<w:pPr>/<w:pStyle>`，list 类型读取 `<w:pPr>/<w:numPr>`。mammoth 可继续负责富文本 HTML 展示，但不再生产可执行坐标。当前 extractor 同时生成 HTML、raw text 和 paragraph 数组，替换 paragraph 数组来源不会要求改 `DocumentBlock` 的渲染协议（`src/host/ipc/settings.ipc.ts:700-745`，`src/renderer/components/features/chat/MessageBubble/DocumentBlock.tsx:13-25`）。

点击时保存当前段、前一可见段、后一可见段的规范化文本指纹。resolver 写前执行四步：revision 相同；`paragraphIndex` 仍存在；当前段指纹相同；存在邻居指纹时邻居关系仍相同。任一步失败都 fail-closed。通过后把 `paragraphIndex` 原样交给现有 `replace_paragraph` / `delete_paragraph` / `insert_paragraph.after`；工具实现保持不动（`src/host/tools/modules/document/docxEditCore.ts:123-164`、`329-365`）。

当前 `DocumentBlock` 已显式禁止把 mammoth 序号用于 index 操作（`src/renderer/components/features/chat/MessageBubble/DocumentBlock.tsx:187-199`）。迁移完成前保留这条止血；只有 XML locator resolver 与契约测试同时通过后，才允许 prompt 使用 `paragraphIndex`。

### PPT：显示顺序和写入 part 同时入锚

#### 坐标规则

本 ADR 把 `<p:sldIdLst>` 顺序定义为 `displayIndex`，再从 `ppt/_rels/presentation.xml.rels` 把每个 `relationshipId` 解析到 `slidePartName`。`slidePartName` 是执行身份，`displayIndex` 是人类标签。当前上传读侧只按文件名排序并返回 `offset + 1`（`src/host/ipc/workspaceArchive.ipc.ts:237-291`），当前写侧页内操作直接拼 `slide${slide_index + 1}.xml`（`src/host/tools/modules/network/pptEdit.ts:145-193`），两边都要改为消费同一个 package index resolver。

写前 resolver 重新打开 PPTX，校验 revision、`relationshipId -> slidePartName` 映射和 slide 文本指纹；通过后从 `slidePartName` 中提取文件序号并输出当前工具需要的 `slide_index = 文件序号 - 1`。例如用户看到第 2 页，而该页 relationship 指向 `ppt/slides/slide7.xml`，prompt 与 guard 都固定 `slide_index=6`。`ppt_edit` 不改签名。

#### 上传 PPT 的选页 UI

首批采用可点文字大纲：按 resolver 给出的真实显示顺序渲染所有已加载页，点击卡片后展示 `LocalityFeedbackBar`。这能复用现有 outline 数据形态和反馈栏，属于 resolver 之后的接线；当前 outline 已渲染标题与文本，但没有选中态和反馈入口（`src/renderer/components/PreviewPanel.tsx:317-352`）。上传消息当前只显示前两页摘要（`src/renderer/components/features/chat/MessageBubble/AttachmentPreview.tsx:401-426`），应复用同一个 `PresentationPagePicker`，避免聊天附件与 Workspace 再长出两套页坐标。

视觉预览作为下一批增强：LibreOffice 可用时，对上传 PPTX 调现有 `convertToScreenshots`，截图数组按显示顺序绑定同一组 locator；不可用、转换失败或只有 qlmanage 单页降级时，继续使用文字大纲，不关闭选页能力。现有能力已经有 `isLibreOfficeAvailable` 闸和 PPTX→PDF→逐页图片管线（`src/host/tools/media/ppt/visualReview.ts:23-41`、`61-110`），但当前 upload preview 没有接这条管线（`src/renderer/components/PreviewPanel.tsx:447-468`）。

产品取舍：非程序员通常靠版式和画面识别页面，截图是目标体验；LibreOffice 是可选本机依赖，不能成为“能否选页”的硬门。文字大纲负责可用性，截图负责识别效率。

## 两侧对账机制

预览 producer、prompt serializer、tool-call guard 共用 `ArtifactLocatorV1` 与同一个 host resolver：

1. host parser 从源文件生成 `revision + targets`；renderer 只选择 target，不自行做 `+1/-1` 或按文件名重排。
2. 提交反馈时，结构化 locator 写入 user message metadata；同一 serializer 生成可读 prompt，保留当前对话体验。
3. 模型给出 `DocEdit` / `ppt_edit` 调用后，guard 重新 resolve locator，核对文件路径和工具坐标。
4. guard 通过才执行现有工具；工具结果落盘后该 locator 自动 stale，预览刷新生成新 revision。

当前链路只做第 2 步的字符串部分（`src/shared/livePreview/localityFeedback.ts:33-67`，`src/renderer/components/LivePreview/LocalityFeedbackBar.tsx:20-35`），所以“新增 union type”单独落地不算完成 locator 契约。

## 契约测试与 fixtures

fixtures 使用测试代码生成最小 OOXML zip，保留 XML 明文和 sentinel，避免二进制 fixture 难审。现有 PPT test 已用 JSZip 生成连续 `slide1..3.xml`，但 presentation 列表也是连续 `rId2..4`，覆盖不了乱序和缺号（`tests/unit/tools/modules/network/pptEdit.test.ts:57-87`）；现有 Workspace inspection fixture甚至没有 `presentation.xml` / relationships（`tests/unit/ipc/workspace.ipc.test.ts:173-216`）。

| Fixture / 测试 | 构造 | 必须有的正向断言 | 非目标保护断言 |
|---|---|---|---|
| `locator-multi-sheet.xlsx` | `Sheet1!B7=FIRST`、`Summary!B7=TARGET` | 预览选择 Summary/B7，resolver 输出 `sheet=Summary, cell=B7`，执行后 `Summary!B7` 变更 | `Sheet1!B7` 仍为 `FIRST` |
| `locator-word-complex.docx` | heading；跨两个 `<w:t>` 的正文；空 `<w:p>`；表格内段落；带 `<w:numPr>` 的列表；重复文本段 | extractor 输出真实 index 间隙、heading/list 类型；选择表格段或空段后的正文，resolver 输出与 writer 同一 index；执行后目标 sentinel 变更 | 相邻段、同文本重复段和表格外段保持原值；revision/fingerprint 改动后工具 mock 调用次数为 0 |
| `locator-ppt-reordered-gapped.pptx` | `slide2.xml`、`slide7.xml`、`slide11.xml`；`sldIdLst` 顺序故意为 7→2→11；relationships 使用非连续 rId | preview 第 1/2/3 页标题按 7→2→11；选择显示第 2 页，resolver 输出 `slide_index=1` 并成功修改 `slide2.xml` | `slide7.xml`、`slide11.xml` 不变；relationship 或 revision 漂移后工具 mock 调用次数为 0 |
| legacy locality regression | 现有 sheet anchor、生成 PPT 的连续 screenshot anchor | prompt 仍包含原 `file_path`、A1、`slide_index` 与用户反馈（现有正向断言见 `tests/unit/shared/localityFeedback.test.ts:4-58`） | Excel URL/无路径仍不显示编辑入口，且正文/表格保持渲染（`tests/renderer/components/attachmentPreview.spreadsheetFilePath.test.tsx:29-49`，`tests/renderer/components/documentBlock.filePathGating.test.tsx:18-35`） |
| UI picker regression | 上传 PPT outline 与可选 screenshots 两种输入 | 组件本体、目标页标题、选中态、反馈入口都必须 `toContain` | 只有正向渲染已成立后，才断言 fallback 不含截图或缺路径不含反馈入口；现有 PPT 预览测试的正向模式可复用（`tests/renderer/components/pptxVisualPreview.test.tsx:31-52`） |

Word 写侧的目标测试当前只 mock `docxEditCore` 并验证一次 `'a' -> 'b'` delegation（`tests/unit/tools/modules/document/docEdit.test.ts:16-25`、`182-210`），所以 `locator-word-complex.docx` 必须直接调用真实 `executeDocxEdit` 或通过不 mock core 的 integration seam，不能继续停在 schema/dispatch 测试。

所有实现期 Vitest 命令统一使用：

```bash
env -u FORCE_COLOR -u NO_COLOR npx vitest run <path>
```

## 迁移与分期工单

量级是单人相对估算：XS ≤ 0.5 天，S = 0.5~1 天，M = 2~3 天；开工前按当时 HEAD 复核。

| 阶段 | 工单 | 性质 | 量级 | 验收证据 |
|---|---|---:|---:|---|
| P0 契约地基 | A1. 新增 `ArtifactLocatorV1`、runtime validator、revision helper、deterministic prompt serializer | 真开发 | M | union 三 kind 正反例；非法 path/revision/target fail-closed |
| P0 契约地基 | A2. 打通 `sendPrompt(content, metadata)`、message persistence 与 locator guard；工具本体零改动 | 真开发 | M | user message 回读仍有 locator；错 file/index 的 tool call 被 guard 阻断，正确调用通过 |
| P0 零回归 | A3. legacy `LocalityAnchor` compatibility adapter；生成 PPT prompt 与 Excel A1 prompt 保持；Excel 补传现成 `sheet.name` | 接线 | S | 现有 locality / attachment path tests 全绿；multi-sheet fixture 正确 |
| P1 Word | B1. `document.xml` paragraph parser：同谓词 index、聚合 `<w:t>`、`pStyle`、`numPr`、指纹 | 真开发 | M | complex DOCX extractor contract 全绿 |
| P1 Word | B2. `DocumentBlock` 改用 XML locator；通过 resolver 后解除 index 禁令；保留无路径门禁 | 接线 | S | 点击目标段产生结构化 locator；真实 core 只改目标 paragraph |
| P1 PPT | C1. presentation package index resolver：`sldIdLst + presentation.xml.rels + slide part` | 真开发 | M | reordered/gapped PPT fixture 全绿；旧连续 deck 解析结果不变 |
| P1 PPT | C2. 上传附件与 Workspace 共用可点 outline picker + locality bar | 接线 | M | 两入口对同一页生成相同 locator；缺本地路径时保持只读 |
| P1 收口 | C3. 生成 PPT producer 切到 resolver locator；保留 screenshot `selectedIndex` 体验与旧 prompt | 接线 | S | 现有生成 PPT 正向测试 + legacy prompt snapshot 全绿 |
| P2 视觉体验 | D1. 上传 PPT 截图缓存 IPC，复用 `convertToScreenshots`，把 screenshot 按 displayIndex 绑定 locator | 真开发 | M | LibreOffice 有/无/转换失败三态；无 LO 时 outline 仍可选页 |
| P2 硬化 | D2. locator telemetry：resolved / stale / blocked reason；只记 kind 与 reason，不记文档正文 | 接线 | S | 单测验证不落 excerpt/file content；dogfood 可定位 stale 原因 |

施工顺序是 A1→A2→A3，再并行 B1/B2 与 C1/C2/C3，最后 D1/D2。P0 只建契约并保护现有 Excel/生成 PPT；Word 的 index prompt 继续禁用，上传 PPT 继续只读，直到各自 P1 fixture 通过。任一 kind 可独立回滚到 legacy producer，不要求三种产物同批上线。

## 拍板项

1. **D1 Word 锚**：批准“XML 序号 + 当前/邻居文本指纹 + revision”的复合锚；不选纯 index、纯文本或必填稳定 id。
2. **D2 PPT 坐标**：批准 `displayIndex + relationshipId + slidePartName + revision`；现有 `slide_index` 只作为 resolver 输出，不再代表用户看到的页序。
3. **D3 上传 PPT UI**：批准“可点文字大纲先上线，LibreOffice 截图后增强”；截图缺失不关闭选页。
4. **D4 首批工具面**：locator 首批只放行 Excel cell/range、Word paragraph、PPT 页内 replace 三类；PPT delete/reorder/notes 不搭车。
5. **D5 stale 行为**：文件 revision 或局部指纹不一致一律阻断并要求刷新，不做 best-effort 猜测。

## 代价与后果

- 新增一个 host 侧 OOXML locator resolver 和一个 tool-call guard，消息 metadata 也要扩展；这比只改 prompt 多一层，但可靠性从“模型照抄数字”提升为“写前可验证契约”。当前纯字符串通道见 `src/renderer/stores/messageActionStore.ts:16-29`、`48-52`。
- Word preview 的段落数组来源会从 mammoth HTML 改为 XML；mammoth HTML 可保留视觉展示，坐标权威移到 `document.xml`。当前双来源都集中在同一个 extractor handler（`src/host/ipc/settings.ipc.ts:700-745`）。
- PPT package index resolver 会替换上传摘要、Workspace inspection 各自的文件名排序；共享 resolver 能消除两套读侧继续漂移的入口（`src/renderer/components/features/chat/ChatInput/attachmentSummaries.ts:97-135`，`src/host/ipc/workspaceArchive.ipc.ts:253-291`）。
- revision fail-closed 会让外部修改后的旧预览多一次刷新，但不会静默改错非程序员的文档。

## 明确不做

- 本 ADR 不修改 `DocEdit` / `ppt_edit` schema、executor 或文件写算法。
- 不把 Excel A1 改成通用数字 index。
- 不把 LibreOffice 设为上传 PPT 选页的必需依赖。
- 不在 locator 首批顺手修 PPT 删除、重排、备注的 package mutation 语义；相关行为已在“问题与证据基线”记录，另立工具工单。
- 不在产品负责人拍板前写实现代码。
