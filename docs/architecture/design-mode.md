# Design Mode 架构（设计工作区 as-built）

> **范围**：Neo/code-agent 顶层「设计」工作区的完整技术架构——交互原型(HTML) + 设计稿/信息图(图像无限画布) + 设计质量自检。基于 2026-06 三轮迭代（Kun 借鉴打底 + Cowart 式画布 + OpenDesign/Lovart 借鉴 T1-T6）提炼，2026-06 末追加 CD-Parity 四特性。
> **状态**：T1-T6 已合 main，PR #258，merge `b377aa424`（前序：Cowart 画布 PR #257）。CD-Parity 四特性均已实现并合 main：①我的品牌契约（§5.9）②PDF 导出（§5.10）③原型就地文本编辑（§5.11）④PPTX 薄版（§5.12）。
> **配套文档**：产品 spec `docs/designs/design-mode-spec.md`；画布深度设计 `docs/designs/design-canvas-cowart.md`；竞品来源 `docs/competitive/kun-设计tab-借鉴清单.md` 与 `docs/competitive/opendesign-lovart-借鉴清单.md`（T1-T6 借鉴源）。

---

## 1. 概览

Design Mode 是覆盖在 Code 工作区之上的**全屏设计工作台**，用同一套 `agent + 工具 + surface` 骨架支撑**三条产品路径**：

| 产物类型 | 本质 | 生成方式 | Surface |
|---------|------|---------|---------|
| **交互原型** (`prototype`) | 单文件可交互 HTML | **agent 编排**（写文件 + 轮询）| iframe `srcDoc` |
| **设计稿** (`mockup`) | 静态 UI 图 | **renderer 直连 IPC** → 多模型可切(wanx/cogview/flux/gpt-image-2) + 标注重绘 | konva 无限画布 |
| **信息图** (`infographic`) | 静态信息图 | 同上 | konva 无限画布 |

横切能力：**设计质量自检 hook**（PostToolUse，对 agent 写出的前端源码扫 AI 痕迹，advisory 回注）。

**两条数据流的根本差异**：原型走 agent loop（需要模型增量写 HTML），图像走 renderer 直连 IPC（纯文生图/局部重绘无需 agent 推理，直连更确定且可显式选引擎）。

---

## 2. 顶层导航与挂载

- **状态**：`stores/workspaceModeStore.ts` — `workspaceMode: 'code' | 'design'`，zustand persist（`code-agent-workspace-mode`）。
- **切换器**：`components/design/WorkspaceModeSwitch.tsx` — 「通用 / 设计」两按钮，放 TitleBar 与设计页表头共用。
- **挂载**：`App.tsx:776` — `workspaceMode === 'design'` 时 `<React.Suspense><DesignWorkspace/></Suspense>` 全屏覆盖；Code 三列布局不卸载、行为不变。`DesignWorkspace` 懒加载（`App.tsx:80`）。

---

## 3. 组件地图（`src/renderer/components/design/`）

```
DesignWorkspace.tsx        全屏外壳：表头(WorkspaceModeSwitch) + 左 Composer + 右 PreviewPane
├─ Composer (内部组件)      表单：产物类型/需求/品牌色/语气/Surface/尺寸/生成/添加图片/历史
├─ PreviewPane (内部组件)    按 outputType 分流：image→<DesignCanvas/> ; prototype→iframe srcDoc
├─ HistorySection (内部组件) 原型历史（可折叠）
├─ VersionComparePicker (内部) proto 侧选两版进 VariantCompareView 的拣选器（T1）
DesignCanvas.tsx           konva 无限画布：平移/缩放/图节点/选择/圈选标注/局部重绘面板/导入(粘贴·拖拽)
                           /扩图·去水印面板(DesignImageEditOps)/成本历史(DesignCostHistory)
                           /标注重绘面板+AnnotationLayer(选中图节点时,模式开关+工具栏+指令+cap模型下拉+成本confirm)
VariantCompareView.tsx     通用 variant 并排对比浮层（T1，canvas+proto 共用）：两版等高并排，
                           按 kind 渲染 img/iframe srcDoc + 设为主版(pin)/淘汰(discard)，动作由调用方注入
DesignCompareOverlay.tsx   canvas 侧 A/B 浮层：薄封装 VariantCompareView，设主版→setChosen、淘汰→discardNode
DesignImageEditOps.tsx     扩图(方向 up/down/left/right/all + 比例 1-2×)/去水印 面板（T3，纯展示）
DesignCostHistory.tsx      成本历史面板（T2）：每步可逆命名 + 实际花费 + 累计 + 一键回滚前一版
ImageModelPicker.tsx       P1 生图模型下拉(View 纯展示/容器拆分,SSR 可测)：只列已配 key 视觉模型,灰显未配
AnnotationLayer.tsx        标注重绘 konva 层(笔/箭头/矩形/文字,红 ANNOT_COLOR) + 纯归约器 reduceAnnot(可单测)
WorkspaceModeSwitch.tsx    顶层 Code/设计 切换
BrandManager.tsx           我的品牌契约 UI(CD-Parity §1)：列/建/删/设 active 品牌 + 参考图提取草稿预填手填表单
DesignVersionUI.tsx        原型版本 UI(从 DesignWorkspace 抽出控体积)：VersionControl/ViewingBanner/VersionComparePicker 三纯展示组件
```

> 注：交互原型用的澄清表单 `QuestionFormPreview.tsx` 在 `src/renderer/components/`（非 design/ 子目录），由 T5 复用。

非组件模块：

```
designTypes.ts             纯类型 + prompt 构造（无 React，可单测）：
                           DesignOutputType / DesignSurface / DesignAspectRatio /
                           formatDesignContextLines / buildPrototypePrompt(T6: picsum seed 真图规则) /
                           buildContinueEditPrompt / buildImagePrompt
designCanvasTypes.ts       画布文档模型 + 序列化容错：CanvasImageNode(新增 chosen/discarded/label/
                           consistency:RegionLockReport) / DesignCanvasDoc /
                           serialize|deserializeCanvasDoc / nextNodePlacement
designCanvasMask.ts        圈选→mask：worldRectToImageRegion(纯,求交裁剪) / normalizeDragRect /
                           buildMaskDataUrl(DOM canvas 黑底白区)
variantSpine.ts            T1 非破坏性 variant spine（无 React，可单测）：Variant/VariantSpine 模型 +
                           append/pin/discard/restore + groupKey(=parentId??id 版本槽) + serialize/deserialize
variantAdapters.ts         T1 适配层：canvasNodeToVariant(chosen→pinned) / makeProtoVariant / protoGroupId
protoSpine.ts              T1 proto 侧 spine.json 落盘 + reconcileProtoSpine 与磁盘版本对账 + load/save
variantHistory.ts          T2 undo/redo 纯逻辑：slotTimeline / currentVariant / previous|nextVariantId /
                           canUndo/canRedo（回滚=移主版指针，非破坏）
designStore.ts             表单 + 原型运行态 + 历史（zustand persist；P1 加持久 imageModel + 标注重绘瞬时 annotMode/annotInstruction/annotModel）
designCanvasStore.ts       画布运行态：nodes/camera/selectedIds/generating（persist 仅 runDir）
annotComposite.ts          标注重绘合成（纯 composeAnnotOps 按原图分辨率换算坐标 + exportAnnotatedPng DOM canvas 拍扁 PNG）
designFiles.ts             renderer 文件工具：readWorkspaceFile / writeWorkspaceFile / listVersions /
                           findRunHtml / readRunHtml / resolveDesignDir / readWorkspaceImageAsDataUrl /
                           exportPrototypePdf / exportImagePdf / exportCanvasPptx(CD-Parity §2/§4 IPC 封装)
designPreviewInject.ts     proto 预览注入：injectPreviewStyle / injectThemeOverride(T6 换肤,PROTO_PALETTES
                           5 套色板 hue-rotate) / injectSelectionScript / parseProtoSelectMessage /
                           injectInlineEditScript + parseProtoTextEditMessage(CD-Parity §3) +
                           PATH_FN_SOURCE(圈选/内联共用 path(),始终追加 :nth-child)
inlineTextEdit.ts          就地文本编辑回写纯函数 applyTextEdit(CD-Parity §3)：零依赖 HTML tokenizer 自建轻量
                           元素树(不用 DOMParser)，仅 LEAF 文本元素改 + HTML 转义防注入，可单测
designCanvasPersistence.ts canvas.json 读写 + ensureCanvasRun（生成/导入共用建 run）
useDesignGeneration.ts     原型生成 hook（agent 编排 + 轮询 html + continueEdit）
useDesignCanvasGeneration.ts 画布出图 hook：generate(文生图,带 model) + editRegion(局部重绘) + expand + removeWatermark + editByAnnotation(标注重绘,§5.8)
useDesignCanvasImport.ts   自由画布导入 hook：importFiles(File[] → 落 assets → 节点)
```

共享/主进程侧 T1-T6 模块：

```
shared/media/imageCost.ts          T2 成本估算（纯）：estimateImageCostCny(查 IMAGE_PRICING_CNY) / formatCny('¥0.14')
shared/constants/pricing.ts        价表唯一源：IMAGE_PRICING_CNY(wanx 0.14 / cogview 0.06 / flux 0.10 / gpt-image-2 0.25) + DESIGN_IMAGE_MODELS + DESIGN_FLUX_MODEL
                                   + VIDEO_PRICING_CNY_PER_SEC(按秒,§6.5：通义万相 0.03/s 实测 / 海螺 0.42/s 粗估) + DESIGN_VIDEO_MODELS
shared/constants/visualModels.ts   视觉模型注册表(D1 单源,§6.0)：IMAGE_MODELS(§6.0) + VIDEO_MODELS(§6.5：4 模型/2 provider) + videoModelById/defaultVideoModelId/videoModelsWithCap/clampVideoDuration + VideoCap(t2v/i2v) + VisualProviderId(含 minimax)
shared/media/videoCost.ts          视频成本估算(纯)：estimateVideoCostCny(单价/秒 × 时长,查 VIDEO_PRICING_CNY_PER_SEC)
main/services/media/videoGenerationService.ts  视频生成原语(§6.5)：generateVideo 按 provider 路由(dashscope wanx / minimax 海螺) + downloadVideoAsBuffer(SSRF 守卫)
shared/contract/imageConsistency.ts T4 契约：RegionLockReport(passed/status/maxDelta/keepPixels/diffPath…)
shared/contract/designBrief.ts     T5 契约：DesignBrief(direction/directionTokens/referenceScreenshot…)
main/services/media/imageConsistency.ts T4 region-lock 闸：runRegionLockGate + diffOutsideMask /
                                   compositeRegionLock / buildDiffOverlay（纯像素函数，sharp 注入）
main/prompts/questionForm.ts       T5 澄清表单 prompt（首轮强制 + 方向卡 + 参考截图分支 + 逃生口）
artifacts/question-form.ts         T5 question-form artifact 校验 + 回流 DesignBrief
main/quality/rules.ts              新增 T6 lint：slop-gray-image-placeholder（禁灰图床/灰框，劝用 picsum seed）
shared/contract/brandContract.ts   CD-Parity §1：BrandContract/BrandMeta/BrandRegistryIndex + normalizeBrandContract +
                                   brandContractToBriefProjection（tokens 复用 DirectionTokens 形状，纯逻辑可单测）
main/services/design/brandRegistry.ts  CD-Parity §1：文件 registry CRUD + active 指针 + getActiveBrandSync(同步注入用) +
                                   withIndexLock(index.json 读改写串行锁)
main/services/design/brandExtract.ts   CD-Parity §1 B2：参考图 vision 提取 BrandDraft(ModelRouter 同 imageAnalyze) +
                                   parseBrandDraftJson(纯解析，容围栏/散文/缺字段)；不落盘
main/services/design/pdfExport.ts  CD-Parity §2：htmlToPdf(playwright page.pdf,JS-off+网络隔离) + imageToPdf(pdfkit+sharp 归一)
main/services/design/pptxExport.ts CD-Parity §4：imagesToPptx(全幅 16:9 contain，pptxgenjs 经 require 非 ESM import)
main/ipc/workspaceSaveExport.ts    saveTextToDownloads / saveBinaryToDownloads(去路径分隔符防穿越 + 重名 -N，导出共用落盘出口)
```

---

## 4. 状态层

### designStore（`code-agent-design`，persist 表单/历史/选中）
- 表单：`requirement / brandColor / tone[] / surface / outputType(prototype/mockup/infographic/**video**) / aspectRatio / imageModel / **videoModel / videoMode(t2v|i2v) / videoDurationSec**`
  - **`imageModel`（持久）**：生图模型选择键（默认 `defaultImageModelId()`=wanx-t2i），驱动 §5.2 文生图路由（模型切换器）。
  - **`videoModel / videoMode / videoDurationSec`（持久，P2/P3）**：视频产物的模型/模式/时长选择，驱动 §6.5 视频路由；`VideoModelPicker` 按 `videoMode` 的 cap 过滤下拉。
- 标注重绘瞬时态（**不持久**）：`annotMode / annotInstruction / annotModel`——标注模型独立于持久的 `imageModel`，避免切标注模型污染文生图默认。
- 原型运行态（不持久）：`status / error / previewPath / previewHtml`
- 历史：`history[] / selectedRunDir`

### designCanvasStore（`code-agent-design-canvas`，**persist 仅 `runDir`**）
- 运行态：`runDir / nodes[](CanvasNode=图\|视频判别联合,§6.5) / camera / selectedIds / generating / error`
- 真理源是磁盘 `canvas.json`——节点/相机不进 localStorage，刷新后由 `runDir` 回读磁盘恢复（见 §10），避免双源。
- 关键 action：`loadDoc / addNode / updateNode / deleteNode / setChosen(标主版+清同 parentId 组) / setCamera / setSelected / toDoc`

---

## 5. 数据流

### 5.1 交互原型（agent 编排，`useDesignGeneration`）
```
点生成 → 开独立 run 目录(app 托管) → buildPrototypePrompt(单文件/raw HTML/增量写<1.5KB/预留路径)
→ createSession(workingDirectory=runDir) 派给 agent loop（立即切回用户原会话，不抢占）
→ agent 用 write/edit 增量写 HTML → pollPreview 轮询目录最新 html，边长边刷 iframe
→ 会话从"处理中"转 idle 即定稿
```
要点：增量写防流式中断（dogfood：整页塞一次 Write 会在 ~1KB 截断）；完成判定以会话处理状态为准，非文件大小。

### 5.2 设计稿/信息图（renderer 直连 IPC，`useDesignCanvasGeneration.generate`）
```
点生成 → ensureCanvasRun(复用/新建 run) → buildImagePrompt(干净图像描述,非 agent 话术)
→ IPC WORKSPACE/generateDesignImage{prompt, aspectRatio, outputPath, model} → 主进程按注册表路由 engine
→ 落盘 assets/gen-*.png → readWorkspaceImageAsDataUrl 读回 → 量原始尺寸
→ nextNodePlacement 落点(最右节点右侧+gap) → addNode → saveCanvasDoc
```
> **模型切换器（P1）**：`model` 由 `designStore.imageModel` 给（`ImageModelPicker` 下拉，只列已配 key 的视觉模型，灰显未配）；主进程 `imageEngineForModel(model)` 经**视觉模型注册表**（§6）路由到 wanx / cogview / flux / gptimage；缺省回退 wanx。flux 需传 `DESIGN_FLUX_MODEL` 作模型串。mask 类 op（5.3/5.5/5.6）仍固定 wanx（cogview/flux/gpt-image 不支持 mask inpaint）。

### 5.3 圈选局部重绘 + 一致性锁定（`useDesignCanvasGeneration.editRegion`，T4）
```
选图 → 圈红框标注(世界坐标) + 写指令 → worldRectToImageRegion 映射成图内局部像素矩形
→ buildMaskDataUrl(黑底白区) → IPC WORKSPACE/editDesignImage{prompt, baseImagePath, maskDataUrl, outputPath}
→ 主进程读底图 base64 + mask → 通义万相 wanx2.1-imageedit inpaint → 模型输出
→ ★T4 region-lock 闸 runRegionLockGate：diff-gate 校验未选区(mask 黑)逐像素 ≤ ε(REGION_LOCK.EPSILON=8)
   · passed(clean) → 采用模型输出（重编码 PNG，不引入接缝）
   · 越界(locked) → compositeRegionLock 把原图未选区贴回 + buildDiffOverlay 落同目录 diff 证据图(<out>.diff.png)
→ 落盘 assets/edit-*.png → 返回 {path, actualModel, costCny, consistency:RegionLockReport}
→ 回读 → 新节点(parentId=底图,记血缘,挂 consistency) 放底图右侧 → addNode → saveCanvasDoc
```
> sharp 不可用/解码失败时降级为原模型输出（不阻断编辑，consistency 留空，退回 legacy 无徽章）。

### 5.4 自由画布导入（`useDesignCanvasImport.importFiles`）
```
添加图片 / ⌘V 粘贴 / 拖拽 → File→dataURL → ensureCanvasRun
→ IPC WORKSPACE/importDesignImage{dataUrl, outputPath} 写盘 assets/import-*.png
→ 量尺寸 → addNode（与生成图同构，选中即可圈选重绘）
```

### 5.5 扩图（`useDesignCanvasGeneration.expand`，T3）
```
选图 → 选方向(up/down/left/right/all) + 比例(1-2×) → IPC WORKSPACE/expandDesignImage
   {baseImagePath, outputPath, direction, ratio, prompt?}
→ 主进程校验 direction/ratio(M2 边界拦截) → 读底图 base64 → expandScalesForDirection(方向→四向单边 scale)
→ 通义万相 function=expand 外扩补绘 → 下载结果写盘 → 返回 {path}
→ 回读 → 新节点(挂 T1 spine) → addNode → saveCanvasDoc
```

### 5.6 去水印（`useDesignCanvasGeneration.removeWatermark`，T3）
```
选图 → IPC WORKSPACE/removeWatermarkDesignImage{baseImagePath, outputPath, prompt?}
→ 主进程读底图 base64 → 通义万相 function=remove_watermark 消除中英文文字水印
→ 下载结果写盘 → 返回 {path} → 回读 → 新节点(挂 T1 spine) → addNode → saveCanvasDoc
```

### 5.7 proto 运行时换肤（`injectThemeOverride`，T6，仅 proto）
```
proto 预览态选色板 → injectThemeOverride(html, paletteId) 往 srcDoc 注入一条 CSS：
   :root{filter:hue-rotate(deg)} + 图片/视频/矢量反向 -deg（保 seed 真图原色）
→ iframe 实时换肤，零重生成（5 套 PROTO_PALETTES）；导出/快照用 previewHtml 原文不含注入样式。
   canvas 栅格 PNG 是图片像素，CSS filter 套不进去 → 不做。
```

---

### 5.8 标注重绘（非 wanx 整图编辑，`useDesignCanvasGeneration.editByAnnotation`）
```
选图(image 节点) → 「标注重绘」模式 → 标注工具栏(笔/箭头/矩形/文字,红)在图上画标注 + 写文字指令
→ AnnotationLayer(konva,挂 Stage 内)收指针事件经 reduceAnnot 纯归约成 shapes(世界坐标)
→ shapesToNodeLocal 平移到节点内 + composeAnnotOps 按原图分辨率换算
→ exportAnnotatedPng 把 [原图+标注] 拍扁成一张 PNG dataURL
→ 估算 ¥ confirm → IPC WORKSPACE/editImageByAnnotation{model, annotatedImageDataUrl, instruction, outputPath}
→ 主进程 cap 守门(model 须带 annotEdit)+路径守卫+instruction 非空(全在付费调用前)
→ editImageByAnnotation(gptimage `/v1/images/edits` multipart)→ 取 b64 落盘 assets/annot-*.png
→ 回读 → 新节点(parentId=源图,记血缘,挂 spine) → addNode → saveCanvasDoc
```
要点：借鉴 Cowart「标注→截图整图→重绘」给非 wanx 模型(gpt-image-2)开**免 mask 编辑路径**；模型由注册表 `annotEdit` cap 驱动（`imageModelsWithCap('annotEdit')` ∩ 已配 key）；标注模型 `annotModel` 独立于文生图 `imageModel`。dogfood 实锤 gpt-image-2 真跟随红圈视觉标注（改 circled 区 + 抹标注 + 其余不变）。

---

### 5.9 我的品牌契约（注册表 + 强制注入，CD-Parity §1）
把「我的品牌」（色板/字体/气质 + Keep/Change/Do-not-copy 三桶）固化成一份可复用契约，强制注入每一次设计生成。**关键取舍：注入/护栏管线早已消费 `directionTokens`，故品牌 = 持久化 + 绑定 + 复用现成护栏**，不新增 prompt 路径。

```
[管理] BrandManager.tsx → IPC saveBrand/deleteBrand/setActiveBrand/listBrands
   → brandRegistry：文件 registry <userConfigDir>/design/brands/（index.json + <id>/brand.json）
      · CRUD + active 指针；saveBrand/deleteBrand/setActiveBrand 经 withIndexLock 串行锁
        （读改写 index.json 防并发丢更新；准原子写 tmp+rename 只保单写原子，挡不住读改写竞态）
[提取] BrandManager 选参考图 → IPC extractBrandFromImage（B2，vision 付费一次）
   → brandExtract：ModelRouter 识图模型(同 imageAnalyze 解析) → parseBrandDraftJson
      → 回 BrandDraft（不落盘、不自动保存）→ 预填手填表单，用户审改命名后走 saveBrand（human-in-loop 防 slop）
[注入] 每次设计生成 → workbenchTurnContext.enrichDesignBriefForPrompt
   → getActiveBrandSync()（同步 readFileSync 读 active）→ force-inject：
      · brief.directionTokens：仅当 brief 无显式 tokens/direction 时用品牌 tokens 兜底（per-task 胜出）
      · brief.brandContract（keep/change/doNotCopy）：仅当 brief 自身未带 brandContract 时并入 active 三桶
   → 复用现成三处：<design_brief_json>（workbenchTurnContext）+ selfCritique + critique/prompt
```

- **契约形状**（`shared/contract/brandContract.ts`，纯逻辑可单测）：`BrandContract`(id/name/tokens:DirectionTokens/keep/change/doNotCopy/logoPath?/source:'reference'|'manual'/createdAt/updatedAt) + `BrandMeta`(列表轻量元数据) + `normalizeBrandContract`（tokens 走与 brief 完全相同的 `normalizeDirectionTokens`）+ `brandContractToBriefProjection`（取 keep/change/doNotCopy+logo 切片喂进 brief.brandContract）。
- tokens 复用 `DirectionTokens` 形状（palette+fonts+posture+refs）→ 直接 hydrate 进 `brief.directionTokens`，复用 T5 已有的三处注入/护栏，故是「加法」非新管线。
- registry **不进业务 DB**（品牌是用户配置资产，非强一致会话/账本数据）；写路径取 `Date.now()` 是文件型配置资产，不触 no-Date.now 规则（该规则针对 `services/core/repositories`）。

### 5.10 PDF 导出（CD-Parity §2，`services/design/pdfExport.ts`）
```
[原型] exportPrototypePdf(html) → htmlToPdf：loadPlaywrightChromium → 启 headless
   → newContext({javaScriptEnabled:false})（静态打印隔离：关 JS 杜绝脚本 SSRF/exfil）
   → page.route 拦截只放行 data:/about:、其余 abort（阻断外链子资源回连网络）
   → setContent(waitUntil:'load') → page.pdf({printBackground,preferCSSPageSize}) → Buffer
   → saveBinaryToDownloads 落「下载」；chromium 不可用抛可读错误，renderer 降级导 .html
[栅格] exportImagePdf({dataUrl|imagePath}) → imageToPdf：sharp 归一化成非交错 8-bit PNG（消 pdfkit 解码畸形 PNG 兼容问题）
   → 量原图宽高 → pdfkit 单页(size=图尺寸,margin:0) → doc.image 全幅铺满 → Buffer → 落盘
```
- 矢量级（HTML）走 Playwright 文字可选体积小；栅格（画布/信息图/设计稿 PNG）走 pdfkit 纯 Node 零 chromium 依赖。
- `imagePath` 来源经 `assertWithinDesignDir` 防越界读任意本地文件；`dataUrl` 由 renderer 直接传 base64。

### 5.11 原型就地文本编辑（CD-Parity §3，`inlineTextEdit.ts` + `designPreviewInject.ts`）
```
开「就地编辑」模式 → injectInlineEditScript(html,true) 往预览 iframe 注入脚本
   → hover 高亮 LEAF 文本元素（有子元素的容器一律跳过）→ click 设 contentEditable + 聚焦
   → blur 取纯文本 + path() 算 selector → postMessage(PROTO_TEXT_EDIT_MESSAGE) 上报父侧
→ DesignWorkspace.applyInlineEdit：parseProtoTextEditMessage 校验（不信 origin，认 source+type+本 iframe contentWindow）
   → 读 *canonical* prototype.html 原文（非注入加工过的 srcDoc）→ applyTextEdit(canonical, selector, newText)
   → 命中即 writeWorkspaceFile 回写 prototype.html + 刷 previewHtml；未命中/叶子限制 no-op → alert 提示
```
- `applyTextEdit`（纯函数可单测）：零依赖 HTML tokenizer 自建轻量元素树（不用 DOMParser——vitest 跑纯 node 无 DOMParser/jsdom），仅覆盖 `path()` 产出的 selector 语义（`#id` / `tag.class` / `tag:nth-child(n)`，` > ` 连接最多 6 层）；**仅改 LEAF 文本元素**（含子元素 no-op，防重复后代文本/吐畸形标签的 corruption）；HTML 转义防注入。
- `path()` **始终追加 `:nth-child`**（不仅无 class 时）——同 tag 同 class 的兄弟靠位置区分，否则回写命中第一个改错元素；`PATH_FN_SOURCE` 在圈选/内联两段注入脚本共用，保证 selector 同源。
- **写 canonical prototype.html，不写 srcDoc**；**就地改不建新 variant**（免 AI、零 token；想留档由用户手动「存版本」）；与圈选模式**互斥**（开内联即关圈选，反之亦然，物理隔离不同 guard 标志 + 不同消息类型）。

### 5.12 PPTX 薄版（CD-Parity §4，`services/design/pptxExport.ts`）
```
画布多张产物 → exportCanvasPptx([{dataUrl|imagePath}]) → 逐张解析成 Buffer（imagePath 经 assertWithinDesignDir）
   → imagesToPptx：固定版面 LAYOUT_WIDE(13.33×7.5,16:9) → 每图 1 张全幅 slide
      (x:0,y:0,w:100%,h:100%,sizing.type:'contain') → pptx.write(nodebuffer) → 落盘
```
- **薄版**：只铺全幅图，不做文字层叠加/半透明遮罩/自动布局。抽自 frontend-slides skill 的「图→全幅 slide」核心（主进程不 spawn 技能层 .mjs，尊重工程层/技能层分层）。
- 版面固定 16:9 不按首图反推（画布产物宽高各异，按某张定全 deck 会让其余变形）；`sizing.type:'contain'` 而非 cover（异比例图 letterbox 留边而非裁切，干系人审阅「完整可见」优先）。
- **`pptxgenjs` 走 `require` 取构造器**（与 `pptGenerate.getPptxGenJS` 同款），**不用 ESM `import`**——Electron/esbuild 运行时 ESM 默认 import 得到非构造器（dogfood 实锤 `not a constructor`）。

---

## 6. 图像引擎层（`src/main/services/media/imageGenerationService.ts`）

### 6.0 视觉模型注册表（`src/shared/constants/visualModels.ts`，D1 单一真源）
能力标签化注册表是模型切换 + 路由 + 每模型可用 op 的**唯一真源**（取代散落 if-else）：
- `IMAGE_MODELS`：`{id, label, provider, engine, caps}[]`——`wanx-t2i`(caps t2i/maskEdit/expand) / `gpt-image-2`(caps **t2i/annotEdit**) / `cogview-4`(t2i) / `flux-2`(t2i)。
- 纯查询：`imageModelById` / `imageEngineForModel`(未知抛错) / `defaultImageModelId`(=wanx-t2i) / `imageModelsWithCap(cap)`（驱动 cap 过滤的下拉，如标注重绘只列带 `annotEdit` 的模型）。
- `ImageCap = 't2i'|'maskEdit'|'expand'|'annotEdit'`。只含视觉生成模型，绝不含聊天模型。

host 可直调的纯原语（不感知 ToolContext/权限）：

| 函数 | 作用 |
|------|------|
| `generateImage(engine, fluxModel, prompt, aspectRatio)` | 文生图，engine ∈ `cogview\|flux\|wanx\|gptimage`；返回 `{imageData, actualModel}`（T2 计价用）。gptimage 走 `/v1/images/generations` 取 b64（设计场景不加 NO_TEXT，文字/UI 渲染最强）|
| **`editImageByAnnotation({engine, annotatedImageDataUrl, instruction})`** | **标注重绘（非 wanx 整图编辑）：gptimage `/v1/images/edits` multipart(FormData+Blob)→b64；非 gptimage engine 抛不支持。详见 §5.8** |
| **`getGptImageConfig()`** | **gpt-image-2 自定义端点 base+key：env `GPTIMAGE_PROXY_BASE/_KEY` 优先 → config slot(`gptimage-base`/`gptimage`)；绝不进代码** |
| **`isSafeImageUrl(url)`** | **SSRF 守卫(D9)：仅 https 公网放行，拒 http/私网(127./10./172.16-31./192.168./169.254.)/localhost/IPv6 字面量(去方括号判 ::1/ULA/链路本地/::ffff: mapped)/metadata。`downloadImageAsBase64` 下载前强制校验（单一下载入口收口）** |
| `editImageWithMask({apiKey, prompt, baseImageDataUrl, maskImageDataUrl})` | 局部重绘（wanx2.1-imageedit）|
| **`expandImage({apiKey, prompt, baseImageDataUrl, top/bottom/left/rightScale})`** | **T3 扩图（wanx `function=expand`，四向单边 scale [1,2]）→ `{url}`** |
| **`expandScalesForDirection(direction, ratio)`** | **T3 方向(up/down/left/right/all)+比例 → 四向单边 scale（越界 clamp）** |
| **`removeWatermark({apiKey, baseImageDataUrl, prompt?})`** | **T3 去文字水印（wanx `function=remove_watermark`）→ `{url}`** |
| `submitAndPollWanx(apiKey, path, body)` | 通义万相异步任务通用 helper（提交+轮询 /tasks）；edit/expand/remove 共用 |
| `determineImageEngine()` | 引擎优先级：智谱官方 key→cogview；OpenRouter→flux；**否则抛错（不含 wanx）** |
| `getDashscopeApiKey()` | env `DASHSCOPE_API_KEY` 优先 → `qwen`/`dashscope` 槽位 |
| `downloadImageAsBase64 / isImageUrl` | URL 产物下载转 base64 |

引擎矩阵：

| 引擎 | 文生图 | 局部重绘(mask) | 扩图/去水印(T3) | 标注重绘(annotEdit) | 端点 | 代理 |
|------|--------|------|------|------|------|------|
| 智谱 CogView-4 | ✅ | ❌ | ❌ | ❌ | `zhipuOfficial /images/generations` | 免 |
| FLUX.2 (OpenRouter) | ✅ | ❌（仅参考图编辑）| ❌ | ❌ | `openrouter /chat/completions` | 需 |
| **通义万相** (DashScope) | `wanx2.1-t2i-turbo` | **`wanx2.1-imageedit` / description_edit_with_mask** | **`function=expand` / `remove_watermark`** | ❌ | `dashscope /api/v1/services/aigc/...` | 免 |
| **gpt-image-2**（自定义中转） | ✅ `/v1/images/generations`(b64) | ❌(不支持 mask) | ❌ | ✅ **`/v1/images/edits` multipart(整图编辑)** | `<GPTIMAGE_PROXY_BASE>/v1/...`(OpenAI 兼容) | 视中转 |

**两条调用入口（重要区分）**：
- **agent-facing 工具** `plugins/builtin/imageCreation/imageGenerate.ts`（`image_generate`）：走 `determineImageEngine()`（cogview/flux）。PPT 插图 / 通用 agent 用。**设计画布不走它**。
- **设计画布直连**：`generateDesignImage`/`editImageByAnnotation` IPC 经**视觉模型注册表（§6.0）按 `model` 路由 engine**（P1 模型切换器，缺省 wanx）；mask 类 op（`editDesignImage`/expand/remove）仍**固定通义万相**（spec D2，cogview/flux/gpt-image 不支持 mask inpaint）。与 `determineImageEngine` 解耦——对 PPT/CogView/FLUX 零回归。

> 设计场景出图**保留文字**（不追加"禁止文字"后缀），因信息图/设计稿需要文字。

---

## 6.5 视频生成（P2/P3 as-built）

设计画布的**净新视频能力**：文生视频(t2v) + 图生视频(i2v)，**4 模型 × 2 provider 可切**，产物为画布上的 `CanvasVideoNode`（与图节点同存 `canvas.json`，挂 variant spine）。

### 视频模型注册表（`VIDEO_MODELS`，visualModels.ts，§6.0 同源）

| id | provider | cap | 时长 | 端点/契约 |
|----|----------|-----|------|-----------|
| `wan2.7-t2v` | dashscope | t2v | 2–15s（默认 5）| 通义万相视频，`output.video_url` |
| `wanx2.1-i2v-turbo` | dashscope | i2v | 固定 5s | 底图字段 `img_url`(base64) |
| `MiniMax-Hailuo-02` | minimax | t2v | 固定 6s（MVP）| 海螺，三步 retrieve |
| `I2V-01` | minimax | i2v | 固定 6s（MVP）| 底图字段 `first_frame_image`(base64) |

- `VideoModelPicker`（View+容器）按 `designStore.videoMode` 的 cap 过滤；未配 key 的 provider 灰显（`listVisualVideoModels` 经 `providerKeyConfigured` 标 `available`，含 minimax 分支）。
- key：dashscope 复用 `getDashscopeApiKey`；minimax 用 `getMinimaxApiKey`（env `MINIMAX_API_KEY` → config `minimax` 槽）；海螺取文件需 `getMinimaxGroupId`（env `MINIMAX_GROUP_ID` → config `minimax-group`）。**key/GroupId 只在主进程解析，不进 renderer/不进代码**。

### 服务层路由（`videoGenerationService.generateVideo`，按 `model.provider` 分流）

- **dashscope（通义万相）**：`submitAndPollWanxVideo` — 复用 wanx「提交异步任务 → 轮询 `/tasks` → SUCCEEDED」骨架，但解析 `output.video_url`（≠图像的 `output.results[0].url`，故新写 `parseWanxVideoTask`）；头 `X-DashScope-Async:enable`。
- **minimax（海螺）**：`submitAndPollMinimaxVideo` — **三步**：① POST `/video_generation`{model, prompt | first_frame_image} → `{task_id, base_resp{status_code(0=ok/2013=bad/2056=额度满), status_msg}}`；② 轮询 GET `/query/video_generation?task_id=` → `status`(Queueing/Preparing/Processing/**Success**/Fail) + `file_id`；③ GET `/files/retrieve?file_id=&GroupId=` → `file.download_url`。复用 `MODEL_API_ENDPOINTS.minimax`。
- 两路返回 url 后由 IPC 经 `downloadVideoAsBuffer`（**复用 image service 的 `isSafeImageUrl` SSRF 守卫**）下载 mp4 落盘。
- 成本：`durationSec` 经 `clampVideoDuration` 按模型区间收敛；`costCny` 用 service **真实回传**的 actualModel+durationSec 查 `VIDEO_PRICING_CNY_PER_SEC`（T2 成本可见，生成前 composer 预估 + confirm 闸）。

### 画布节点（`CanvasNode = CanvasImageNode | CanvasVideoNode`，判别联合）

- `designCanvasTypes.ts`：抽 `CanvasNodeBase`（共享几何+variant 字段），图节点 `kind?:'image'`+`consistency?`，视频节点 `kind:'video'`+`durationSec`+`poster?`；守卫 `isVideoNode`(kind==='video' 或 src .mp4)/`isImageNode`；`normalizeNode` 容错（坏 durationSec→`DEFAULT_VIDEO_DURATION_SEC`，负 costCny 丢弃）。
- 渲染：`DesignCanvas` 的 `KonvaVideoNode`（缩略图/占位 + ▶ 播放徽标 + 时长 + 选中/主版高亮）+ `VideoPlayOverlay`（DOM `<video>` 就地播放，mp4 经 `readBinary` 返 `video/mp4` data URL）。图节点专属编辑（圈选重绘/扩图/去水印/导出/标注）经 `selectedImageNode` 收窄，**视频节点不可达图像专属 op**。
- i2v 入口：选画布图节点 →「生成视频」按钮 → 用其 src 作底图，视频节点 `parentId=groupKey(源图)`（血缘 + spine）。

### 验证

- **真 key dogfood 全通**（2026-06-22）：通义万相 t2v/i2v + 海螺 t2v/i2v 均真出片，full chain 落合法 mp4(ftyp 校验)。海螺 API 经**免费探针**核实（端点/模型名/必填字段/错误码），WebFetch 与 firecrawl 均拿不到可信文档（firecrawl JSON 模式会幻觉编造假契约）。
- **价表按真实账单校正**：通义万相 ¥0.14/5s → 0.03/s；海螺控制台粗估 ~¥5/2 条 6s → 0.42/s（待精确单价细调）。

---

## 7. 圈选标注 → mask 管线

- 画布节点 `width/height` = 图原始像素；相机 1:1 对应，故世界坐标 = 图像素坐标。
- 红框（世界坐标）→ `worldRectToImageRegion` 与节点求交并平移到图内局部坐标（越界裁剪，无重叠丢弃）。
- `buildMaskDataUrl(natW, natH, regions)` → DOM canvas 画黑底 + 白色编辑区 → base64 dataURL。
- 通义万相约定：**白=改 / 黑=留**；base 与 mask 均以 base64 data URI 传，无需上传 OSS。

---

## 8. 设计质量自检 hook（Kun 借鉴，`src/main/quality/`）

Neo 自有的「前端产出 linter」——确定性源码规则，标记 AI 生成痕迹与品味问题。

- 触发：`agent/runtime/toolExecutionEngine.ts:911` PostToolUse——agent 写完前端文件（`isFrontendPath`：HTML/CSS/JSX/TSX/SVG）后调 `runDesignQualityReview`，命中则 `injectSystemMessage('<design-quality-review>…')` 让模型**下一轮自我修正**。
- **纯 advisory**：不把工具标记失败、不拦截本轮。
- 规则集：`quality/rules.ts`（16 条，slop 痕迹 + 品味）；算法移植自 impeccable(Apache-2.0)，命名/文案自有；严格度分档 `DESIGN_STRICTNESS_LEVELS`。
- 复用：与 `formatDesignContextLines`（生成前 prompt 约束反 AI 审美）前后呼应——前置约束 + 事后自检双保险。

---

## 9. IPC 契约（WORKSPACE domain，`src/main/ipc/workspace.ipc.ts`）

设计专属 action：

| action | 入参 | 出参 | 说明 |
|--------|------|------|------|
| `resolveDesignDir` | — | `{dir}` | app 托管草稿根 `<home>/.code-agent/design`（确保存在）|
| `generateDesignImage` | `{prompt, aspectRatio?, outputPath, model?}` | `{path, actualModel, costCny}` | 按注册表 `model` 路由 engine(缺省 wanx)文生图→下载→写盘（T2：回传实际模型+花费）；空白 prompt 拦截防付费空调用 |
| **`listVisualImageModels`** | — | `{models:[{id,label,provider,available}]}` | **模型切换器：返回全视觉图像模型并按已配 key 标 `available`；key 逻辑只在主进程，绝不向 renderer 暴露 key 值** |
| **`generateDesignVideo`**（P2/P3）| `{mode:'t2v'\|'i2v', prompt?, baseImagePath?, outputPath, model, durationSec?}` | `{path, actualModel, costCny, durationSec}` | **视频生成(§6.5)：守门(t2v 需 prompt/i2v 需 baseImagePath+路径守卫+模型存在+cap 命中+i2v 读底图前 key 闸)→ generateVideo 按 provider 路由(wanx/海螺)→ downloadVideoAsBuffer 落 mp4；costCny 按真实回传时长×模型单价** |
| **`listVisualVideoModels`**（P2/P3）| — | `{models:[{id,label,provider,available,caps,minDurationSec,maxDurationSec,defaultDurationSec}]}` | **视频切换器：返回全视频模型+按已配 key(dashscope/minimax)标 `available`+cap/时长区间** |
| **`editImageByAnnotation`** | `{model, annotatedImageDataUrl, instruction, outputPath}` | `{path, actualModel, costCny}` | **标注重绘(§5.8)：cap 守门(annotEdit)+路径守卫+instruction 非空 → gptimage `/v1/images/edits`→写盘** |
| `editDesignImage` | `{prompt, baseImagePath, maskDataUrl, outputPath}` | `{path, actualModel, costCny, consistency?:RegionLockReport}` | 读底图+mask → wanx inpaint → **T4 region-lock 闸** → 写盘；consistency 挂 CanvasImageNode |
| **`expandDesignImage`** | `{baseImagePath, outputPath, direction, ratio, prompt?}` | `{path}` | **T3：方向(up/down/left/right/all)+比例[1,2] → wanx `function=expand` 外扩→写盘**；direction/ratio 越界主进程拦截 |
| **`removeWatermarkDesignImage`** | `{baseImagePath, outputPath, prompt?}` | `{path}` | **T3：wanx `function=remove_watermark` 去文字水印→写盘** |
| `importDesignImage` | `{dataUrl, outputPath}` | `{path}` | base64 dataURL → 写盘 |
| `getDesignMdSummary` | `{cwd?}` | `string\|null` | 读 design.md 摘要 |
| **`listBrands`** | — | `BrandRegistryIndex`(`{activeId?, brands:BrandMeta[]}`) | **品牌契约(§5.9)：列全部品牌元数据 + 当前 active id** |
| **`saveBrand`** | `{brand:Partial<BrandContract>}` | `{id}` | **新建/更新品牌（无 id 派生 slug+时戳尾缀，有 id 覆盖）；落 brand.json + upsert index；经 withIndexLock** |
| **`deleteBrand`** | `{id}` | `{ok:true}` | **删品牌目录 + index 条目；若 active 则清空；只删 index 登记的 id（防误删孤儿/穿越）** |
| **`setActiveBrand`** | `{id:string\|null}` | `{ok:true}` | **设/清 active 品牌；不存在的 id 视为清空（保 index 自洽）** |
| **`extractBrandFromImage`** | `{dataUrl?, imagePath?}` | `BrandDraft`(`{tokens,keep,change,doNotCopy}`) | **B2 vision 提取草稿（付费一次）：不落盘，回 renderer 预填手填表单；imagePath 经 assertWithinDesignDir** |
| **`exportPrototypePdf`** | `{html, outputName}` | `{filePath}` | **PDF 导出(§5.10)：htmlToPdf(playwright page.pdf,JS-off+网络隔离) → saveBinaryToDownloads** |
| **`exportImagePdf`** | `{imagePath?, dataUrl?, outputName}` | `{filePath}` | **PDF 导出(§5.10)：imageToPdf(pdfkit 单页+sharp 归一) → 落「下载」；imagePath 经 assertWithinDesignDir** |
| **`exportCanvasPptx`** | `{images:[{imagePath?,dataUrl?}], outputName}` | `{filePath}` | **PPTX 薄版(§5.12)：imagesToPptx(全幅 16:9 contain) → 落「下载」；每张 imagePath 经 assertWithinDesignDir** |
| **`saveBinaryToDownloads`** | `{fileName, base64}` | `{filePath}` | **二进制（PDF/PPTX/图）落「下载」：去路径分隔符防穿越 + 重名 -N 后缀；导出共用落盘出口** |

复用的通用文件 action：`readFile / writeFile / readBinary({base64,mimeType}) / listFiles / createFolder / saveTextToDownloads`。

> **能力闸**：上述全部 design action（含 `expandDesignImage` / `removeWatermarkDesignImage` / `listVisualImageModels` / `editImageByAnnotation` / `generateDesignVideo` / `listVisualVideoModels` / **`listBrands` / `saveBrand` / `deleteBrand` / `setActiveBrand` / `extractBrandFromImage` / `exportPrototypePdf` / `exportImagePdf` / `exportCanvasPptx` / `saveBinaryToDownloads`**）已登记 `src/main/shellCapabilities.ts` 的 `WORKSPACE` 数组——capability-diff 闸要求新增 renderer IPC 必须同步登记，否则被拦。

---

## 10. 持久化与文件布局

```
~/.code-agent/design/                       resolveDesignDir(getUserConfigDir()/design)
├── brands/                                 我的品牌契约 registry（CD-Parity §1，brandRegistry.ts）
│   ├── index.json                          { activeId?, brands: BrandMeta[] }（active 指针 + 列表元数据）
│   └── <id>/                               每个品牌一目录（id=name slug + 6 位时戳尾缀）
│       ├── brand.json                      完整 BrandContract（tokens/keep/change/doNotCopy/source…）
│       └── logo.png                        可选（registry 只管 json，logo 由调用方落盘）
└── run-<ts>/                               每次画布会话/原型生成一个 run
    ├── canvas.json                         画布真理源(stage 节点+相机；图片只存相对路径；
    │                                        节点含 chosen/discarded/label/consistency 等 T1/T4 字段)
    ├── spine.json                          T1 proto 侧 variant spine：版本 pin/discard 状态
    │                                        （DESIGN_SPINE_FILE；与磁盘 versions/ 经 reconcile 对账）
    ├── versions/v-*.html                   T1 proto 版本快照（append-only，非破坏性）
    ├── assets/                             gen-*.png / edit-*.png / expand-*.png / dewm-*.png(去水印) / import-*.png
    │                                        + edit-*.png.diff.png（T4 越界 diff 证据图）
    └── prototype.html                      交互原型产物（原型路径；CD-Parity §3 就地文本编辑回写此 canonical 文件）
```

> **品牌 registry 不进业务 DB**：品牌是用户配置性资产（非强一致会话/账本数据），落单机文件；`index.json` 读改写经 `withIndexLock` 模块级 promise 链串行化防并发丢更新，准原子写 `tmp+rename` 只保单写原子。读路径（listBrands/getBrand/getActiveBrandSync）不上锁。

- **T1 版本模型**：canvas 仍以 `canvas.json` 节点树为真理源（chosen→pinned）；proto 以 `spine.json` 持 pin/discard，`versions/v-*.html` 为快照存在性，二者经 `reconcileProtoSpine` 合并；任一 op 落新 pinned variant，永不覆盖，淘汰=软删 discarded 落盘。

- 画布恢复：`designCanvasStore` persist `runDir` → `DesignWorkspace` 挂载时若 `runDir` 在而 `nodes` 空 → `loadCanvasDoc` 回读磁盘。
- 图片不内嵌 base64 进 `canvas.json`（防膨胀），渲染时按相对路径经 `readBinary` 懒加载为 dataURL。
- 设计草稿目录有路径标记 `DESIGN_WORKSPACE.DRAFT_PATH_MARKER`，从聊天侧栏过滤（不当聊天项目）；并豁免 artifact 游戏校验（不破坏 `artifactRepairGuard`/`toolArtifactValidationLifecycle`）。

---

## 11. 横切约定

- **i18n**：全部文案走 `t.design.*`（`i18n/zh.ts` + `en.ts` 同步，en 是 Translations 类型源）。
- **禁硬编码**：端点/模型/尺寸/超时/间距入 `shared/constants/`（`MODEL_API_ENDPOINTS.dashscope`、`DESIGN_WORKSPACE.{POLL_*,CANVAS_*,DRAFT_PATH_MARKER}`）。
- **会话隔离**：原型/画布生成开独立设计会话，立即切回用户原会话，按 sessionId 全局跟踪处理状态，不抢占聊天。
- **架构取舍**：画布读写在 renderer、agent 只出图落盘（v1 解耦，最稳）；纯图像不过 agent（直连 IPC）。

---

## 12. 关键设计决策（详见 `design-canvas-cowart.md`）

| # | 决策 | 结论 |
|---|------|------|
| D1 | 画布库 | **konva + react-konva 自研**（弃 tldraw 规避 $6k/年或水印），undo/redo 复用 Zustand |
| D2 | 图像引擎 | **通义万相**真 inpaint（用户有百炼 key，免代理，base64 直传）|
| D3 | v1 范围 | 核心闭环 + A/B 对比 |
| — | 出图链路 | renderer 直连 IPC（非 agent 派发）——纯文生图无需 agent 推理 |
| — | 画布-agent 耦合 | renderer 持画布、agent 解耦（v1）；agent 自主多轮编辑留演进口子 |
| T1 | 版本模型 | 统一 canvas+proto 为**非破坏性 variant spine**：每 op 落新 pinned variant 永不覆盖，淘汰=软删 discarded，`groupKey=parentId??id` 槽内单主版；canvas 旧 chosen 升级为 spine，proto 新增 spine.json+reconcile 对账 |
| T2 | 成本透明 + undo/redo | 出图前预估 ¥（价表 `pricing.ts` 唯一源，wanx 0.14/张）；history 每步可逆命名+实际花费+累计+一键回滚前一版（回滚=移主版指针，非破坏）；IPC 回传 actualModel/costCny |
| T3 | wanx 扩图+去水印 | 复用 `submitAndPollWanx` 加 `function=expand`（四向比例 [1,2]）/`remove_watermark`；产物挂 spine——「加 wrapper 级」非改枚举 |
| T4 | 一致性锁定再编辑 | inpaint 输出落盘前过 region-lock + diff-gate：未选区(mask 黑)逐像素 ≤ ε(=8)，越界贴回原图保证「只改这块」+ 落 diff 证据；consistency 报告挂节点 |
| T5 | 方向卡 + 参考截图入口 | 成品向 artifact 首轮强制澄清表单 + direction-cards(色板+双字体+mood+refs) + 「Match a reference screenshot」分支 + 「直接生成」逃生口；回流 DesignBrief 约束生成 |
| T6 | Tweaks 换肤(仅 proto) + seed 真图 | proto 预览 iframe 注入 hue-rotate 换肤（5 套 PROTO_PALETTES，零重生成，canvas PNG 不适用）；buildPrototypePrompt + lint 规则用 `picsum.photos/seed` 真图，禁灰框/灰图床 |
| P1 | 生图模型切换器（spec `design-mode-model-switcher.md` D1–D9）| 能力标签化**视觉模型注册表**(§6.0)为单源；`generateDesignImage` 加 `model` 路由(wanx/cogview/flux/gptimage)；切换器只列已配 key 的视觉模型；gpt-image-2 自定义 OpenAI 兼容端点(D8，b64)；**SSRF 守卫(D9)**。mask 类 op 保持 wanx(D2) |
| 标注重绘 | 非 wanx 整图编辑（spec `design-mode-annotation-redraw.md` A1–A7）| 注册表 `annotEdit` cap 驱动、模型无关；标注烘进截图+文字指令(Cowart make-real)；gptimage `/v1/images/edits` multipart；完整标注工具栏(笔/箭头/矩形/文字)；产物挂 spine。详见 §5.8 |
| P2 | 视频生成 MVP（spec `design-mode-model-switcher.md` §6 P2）| 通义万相视频 t2v(wan2.7-t2v)+i2v(wanx2.1-i2v-turbo)；`videoGenerationService`(提交轮询解析 `output.video_url`)+`generateDesignVideo` IPC+`CanvasVideoNode`(判别联合)+composer 视频产物类型/模式/时长/成本预估。详见 §6.5 |
| P3 | 视频多 provider（spec §6 P3）| 接 MiniMax 海螺 t2v(MiniMax-Hailuo-02)+i2v(I2V-01)，`generateVideo` 按 `model.provider` 路由；海螺三步 submit→query→files/retrieve(需 GroupId)；视频下拉现 4 模型可切。详见 §6.5 |
| CD §1 | 我的品牌契约 | 品牌（tokens+keep/change/doNotCopy）固化成可复用契约，`getActiveBrandSync` force-inject 进 brief.directionTokens+brandContract，**复用 T5 既有三处注入/护栏**（=持久化+绑定，非新管线）；单机文件 registry 不进 DB，`withIndexLock` 防并发；B2 vision 提取草稿 human-in-loop。详见 §5.9 |
| CD §2 | PDF 导出 | HTML 原型走 playwright `page.pdf()`（矢量，JS-off + 网络拦截隔离）；栅格走 pdfkit 单页图嵌（sharp 归一）。详见 §5.10 |
| CD §3 | 原型就地文本编辑 | 注入脚本 contentEditable LEAF 文本 → 回写 **canonical prototype.html（非 srcDoc）**；`applyTextEdit` 零依赖 tokenizer 纯函数（不用 DOMParser 求可单测），**就地改不建 variant**，与圈选模式互斥。详见 §5.11 |
| CD §4 | PPTX 薄版 | N 图 → 全幅 16:9 contain slide（pptxgenjs 经 **require 非 ESM import**，避 Electron/esbuild not-a-constructor）；只铺图不做文字层/布局。详见 §5.12 |

---

## 13. 扩展点

- **agent 自主多轮编辑**：暴露画布只读快照（`get_selection`/`canvas_snapshot`）+ 写回工具给 agent，实现"自己看结果再改"。
- **工作流历史链**：`parentId` 血缘已就绪，可视化版本树（星流亮点）。
- ~~**新图像引擎**：`generateImage` 加 engine 分支~~ → **已落地**：gptimage engine（文生图 b64 + 标注重绘 edits）已接入，注册表(§6.0)驱动；再加新模型 = 注册表声明 + 实现该 engine 的端点分支（如 flux/cogview 的 annotEdit 整图编辑路径，本期未做，声明 cap + 实装即插入）。
- **原型高级特性**：设备切换/圈选改/版本快照（独立分支 feat/design-proto-v0，未并入本分支）。**就地文本编辑已落地**（CD-Parity §3，§5.11：点字直接改、回写 canonical prototype.html、免 AI）。
- ~~**设计产物导出**：PDF / PPTX 打包交付~~ → **已落地**：PDF 导出（§5.10，HTML 矢量 + 栅格 pdfkit）+ PPTX 薄版（§5.12，全幅 16:9）。
- ~~**品牌一致性复用**：把品牌色板/约束固化复用~~ → **已落地**：我的品牌契约（§5.9，registry + 强制注入，复用 T5 注入/护栏）。下一步可扩 logo 自动嵌入、品牌跨设备同步。

---

## 14. 文件索引 + 测试

**前端**：`src/renderer/components/design/*`（含 T1 `variantSpine/variantAdapters/protoSpine/VariantCompareView`、T2 `variantHistory/DesignCostHistory`、T3 `DesignImageEditOps`、T6 `designPreviewInject`、**P1 `ImageModelPicker`、标注重绘 `AnnotationLayer/annotComposite`、CD-Parity `BrandManager`(§1)/`DesignVersionUI`(版本 UI 抽出)/`inlineTextEdit`(§3)**）、`src/renderer/components/QuestionFormPreview.tsx`(T5)、`stores/workspaceModeStore.ts`、`i18n/{zh,en}.ts(design)`、`App.tsx:776`
**主进程**：`main/ipc/workspace.ipc.ts`(design actions：含 T3 `handleExpandDesignImage`/`handleRemoveWatermarkDesignImage`、T4 region-lock 接线、**P1 `handleListVisualImageModels`+`generateDesignImage` model 路由、标注重绘 `handleEditImageByAnnotation`、CD-Parity brand `handleListBrands`/`handleSaveBrand`/`handleDeleteBrand`/`handleSetActiveBrand`/`handleExtractBrandFromImage` + 导出 `handleExportPrototypePdf`/`handleExportImagePdf`/`handleExportCanvasPptx`**)、`main/ipc/workspaceSaveExport.ts`(CD-Parity §2/§4 `saveBinaryToDownloads` 落盘出口)、`main/services/design/{brandRegistry,brandExtract,pdfExport,pptxExport}.ts`(CD-Parity §1/§2/§4)、`main/app/workbenchTurnContext.ts`(CD-Parity §1 `enrichDesignBriefForPrompt` 品牌强制注入)、`main/services/media/imageGenerationService.ts`(T3 `expandImage`/`expandScalesForDirection`/`removeWatermark`、**P1 gptimage 分支+`getGptImageConfig`+`isSafeImageUrl`、标注重绘 `editImageByAnnotation`**)、`main/services/media/imageConsistency.ts`(T4 `runRegionLockGate`)、`main/prompts/questionForm.ts`(T5)、`main/prompts/selfCritique.ts`+`design/critique/prompt.ts`(CD-Parity §1 brandContract 注入点)、`main/plugins/builtin/imageCreation/imageGenerate.ts`、`main/quality/*`(T6 `slop-gray-image-placeholder` lint)、`main/shellCapabilities.ts`(WORKSPACE 能力登记)、`main/agent/runtime/toolExecutionEngine.ts:911`(质量 hook 触发)
**共享/契约**：`shared/media/imageCost.ts`(T2)、`shared/constants/pricing.ts`(IMAGE_PRICING_CNY/DESIGN_IMAGE_MODELS/DESIGN_FLUX_MODEL)、**`shared/constants/visualModels.ts`(P1 视觉模型注册表 D1 单源)**、`shared/contract/imageConsistency.ts`(T4 RegionLockReport)、`shared/contract/designBrief.ts`(T5；CD-Parity §1 新增 `brandContract` 字段)、**`shared/contract/brandContract.ts`(CD-Parity §1 BrandContract + normalize + projection)**、`artifacts/question-form.ts`(T5)
**常量**：`shared/constants/designWorkspace.ts`(含 `DESIGN_SPINE_FILE`、`REGION_LOCK.{EPSILON=8,DIFF_SUFFIX}`)、`shared/constants/providers.ts`(MODEL_API_ENDPOINTS.dashscope)
**测试**：`tests/renderer/design/{variantSpine,variantAdapters,protoSpine,variantHistory,designPreviewInject,buildVariantNode,designStoreSpine,VariantCompareView,DesignCostHistory,DesignImageEditOps,designTypes,designCanvasTypes,designCanvasMask,designCanvasStore,designStore,imageModelPicker,annotationLayer,annotComposite}.test.*`、`tests/shared/constants/visualModels.test.ts`、`tests/unit/ipc/workspaceDesignImage.test.ts`(含 model 路由+listVisualImageModels+editImageByAnnotation)、`tests/unit/services/media/imageGenerationService.test.ts`(含 gptimage+SSRF+editImageByAnnotation)、`tests/renderer/components/questionFormPreview.test.ts`、`tests/shared/media/imageCost.test.ts`、`tests/unit/main/services/media/imageConsistency.test.ts`、`tests/main/quality/designQuality.test.ts`
> **测试基建坑**：react-konva→`konva/index-node` 在 node 测试环境 `require('canvas')` 崩溃 → `tests/__mocks__/react-konva.ts` stub + `vitest.config.ts` alias（同 keytar 范式）。
