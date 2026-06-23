# Design Mode 架构（设计工作区 as-built）

> **范围**：Neo/code-agent 顶层「设计」工作区的完整技术架构——网页(HTML) + 图(设计稿/信息图) + 演示稿(厚版 PPT) + 视频 + 设计质量自检。基于 2026-06 多轮迭代（Kun 借鉴打底 + Cowart 式画布 + OpenDesign/Lovart 借鉴 T1-T6 + CD-Parity 四特性 + P2/P3 视频）提炼，2026-06-22 追加 **Tab 4 媒介重规划 + 厚版演示稿全链路（§15）** 与 **统一画布历史批次（UC：参考图垫图 §5.13 + 统一历史 §5.14）**。
> **状态**：T1-T6 已合 main（PR #258 `b377aa424`）；CD-Parity 四特性已合（§5.9-5.12）；P2/P3 视频已合；**Tab 重规划 + 厚版演示稿 + 4 增强已合（PR #260 `4c9a6fda4`，详见 §15）**。
> **统一画布历史批次（UC，2026-06-22，随 v0.20.0 合 main）**：参考图垫图（§5.13）+ 统一历史（§5.14，proto 版本控件并入左侧 composer + 历史 role-aware）+ `CanvasNode/Variant` 加 `role` 角色字段。对抗审计 0 遗留 HIGH，真 key dogfood 实锤参考图垫图可用。
> **Agent 操作画布（人审批，2026-06-23 合 main，§5.15）**：新增第三方「agent 提议 → 人审批 → renderer 落地」（[ADR-026](../decisions/026-agent-operated-design-canvas.md) 三刀：一刀只读提议 PR #277 / 三刀取舍+软删 + 二刀含付费生成 PR #278）。agent 永不直接改画布；含付费生成的提议付费前置审批（预估==实际，dogfood 实锤）。二刀经 4 轮对抗审计收敛。详见 [2026-06-23 spec](../specs/2026-06-23-agent-operated-design-canvas.md)。
> **配套文档**：产品 spec `docs/designs/design-mode-spec.md`；画布深度设计 `docs/designs/design-canvas-cowart.md`；演示稿计划 `docs/plans/design-tab-restructure-and-slides.md`；UC 实施计划 `docs/plans/design-unified-canvas-history.md`；PPT 引擎 `docs/guides/ppt-capability.md`；竞品来源 `docs/competitive/kun-设计tab-借鉴清单.md` 与 `docs/competitive/opendesign-lovart-借鉴清单.md`。

---

## 1. 概览

Design Mode 是覆盖在 Code 工作区之上的**全屏设计工作台**。UI 按**交付媒介**分 4 个 tab（2026-06-22 重规划，对齐 Canva/Lovart），内部仍用 `DesignOutputType`（`'prototype' | 'mockup' | 'infographic' | 'slides' | 'video'`，UI 聚合，数据模型零破坏）：

| 媒介 tab | `DesignOutputType` | 本质 | 生成方式 | Surface |
|---------|------|------|---------|---------|
| **网页** | `prototype` | 单文件可交互 HTML | **agent 编排**（写文件 + 轮询）| iframe `srcDoc` |
| **图**（二级：设计稿/信息图）| `mockup` / `infographic` | 静态 UI 图 / 信息图 | **renderer 直连 IPC** → 多模型可切(wanx/cogview/flux/gpt-image-2) + 标注重绘 | konva 无限画布 |
| **演示稿** | `slides` | 真排版多页 PPT（厚版）| **renderer 直连 IPC** → 引擎从 agent 工具抽出的 service（§15）| 大纲编辑器 / 像素预览 |
| **视频** | `video` | t2v / i2v 视频 | renderer 直连 IPC（通义万相 / 海螺，§6.5）| konva 画布（视频节点）|

横切能力：**设计质量自检 hook**（PostToolUse，对 agent 写出的前端源码扫 AI 痕迹，advisory 回注）。

**数据流的根本差异**：网页走 agent loop（模型增量写 HTML）；图/视频/演示稿走 renderer 直连 IPC（无需 agent 推理，直连更确定且可显式选引擎）。

> **媒介聚合映射**：`DesignWorkspace.tsx` 的 `outputToMedia` / `mediaToOutput`（纯函数，`tests/renderer/design/mediaTabs.test.ts` 守护）。「图」聚合 mockup+infographic、切媒介保留子类。预览路由 `isCanvasOutput`(图+视频→canvas) / `isSlidesOutput`(→演示稿编辑器) / 网页→iframe。

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
DesignImportButtons.tsx    UC：自由画布导入按钮组(「添加图片」=产物节点 / 「添加参考图」=role=reference 节点)，自包含 refs+importFiles
DesignProtoHistory.tsx     UC：左侧 composer 的 proto 统一历史面板(版本看/对比/定稿) + useProtoVersionActions hook(看版/回最新/设主版/淘汰，预览面对比浮层共用)
```

> 注：交互原型用的澄清表单 `QuestionFormPreview.tsx` 在 `src/renderer/components/`（非 design/ 子目录），由 T5 复用。

非组件模块：

```
designTypes.ts             纯类型 + prompt 构造（无 React，可单测）：
                           DesignOutputType / DesignSurface / DesignAspectRatio /
                           formatDesignContextLines / buildPrototypePrompt(T6: picsum seed 真图规则) /
                           buildContinueEditPrompt / buildImagePrompt
designCanvasTypes.ts       画布文档模型 + 序列化容错：CanvasImageNode(新增 chosen/discarded/label/
                           consistency:RegionLockReport / **UC: role:'reference'|'output'**) / DesignCanvasDoc /
                           serialize|deserializeCanvasDoc(role 仅 reference 落字段) / nextNodePlacement / **isReferenceNode**
designCanvasMask.ts        圈选→mask：worldRectToImageRegion(纯,求交裁剪) / normalizeDragRect /
                           buildMaskDataUrl(DOM canvas 黑底白区)
variantSpine.ts            T1 非破坏性 variant spine（无 React，可单测）：Variant/VariantSpine 模型(+ **UC: role**) +
                           append/pin/discard/restore + groupKey(=parentId??id 版本槽) + serialize/deserialize
variantAdapters.ts         T1 适配层：canvasNodeToVariant(chosen→pinned，**UC: role 透传**) / makeProtoVariant / protoGroupId
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
- 版本/对比（不持久）：`versions / viewingVersionPath / spine`；**UC：`compareIds / comparing`（proto 对比状态提升到 store，左侧 DesignProtoHistory 选版 + 右侧 VariantCompareView 浮层共享；切 run 自动 clearCompare）**
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

### 5.13 参考图垫图（UC，`useDesignCanvasGeneration.generate` + `generateImageFromReference`）
生成前在预览区（图像模式下本就是画布）贴入参考图，作为视觉参考喂给模型出图。**关键事实：图像/信息图/视频模式的预览区从一开始就是 `<DesignCanvas/>`（§3 PreviewPane 分流），故"生成前贴图"的画布基础早已存在**，本批次补的是 reference **语义 + 喂模型链路**。

```
[贴入] Composer「添加参考图」按钮 / 画布粘贴·拖拽 → useDesignCanvasImport.importFiles(files, {role:'reference'})
   → 落 assets/import-*.png，节点 role='reference'（画布上 sky 虚线框 + 「参考」徽章区分产物）
[喂图] 点生成 → generate() 收集画布首张 role=reference 节点（万相单图，多张取第一张，与 UI 提示一致）
   → readWorkspaceImageAsDataUrl 读底图；★读失败 → setError(errReferenceRead) 显式报错并中止
     （不静默退化成纯文生图，否则用户误以为用了参考图——审计 HIGH#2）
   → IPC generateDesignImage{prompt, ..., referenceImageDataUrl}
[路由] handleGenerateDesignImage：有 referenceImageDataUrl → generateImageFromReference
   → 校验 DashScope key（service 首步，付费调用前）→ editImageByDescription
     (wanx2.1-imageedit function=description_edit，base+prompt 无需 mask，DashScope 文档钦定)
   → 下载结果 → 写盘 → 回 {path, actualModel='wanx2.1-imageedit', costCny=0.14}
   无 referenceImageDataUrl → 原纯文生图路径（§5.2）零变化
```
- **role 字段**（`designCanvasTypes.ts` `CanvasNodeBase.role:'reference'|'output'`，紧凑落盘仅 reference 落字段）：reference 是生成前视觉输入、无版本序号、免费导入；`Variant.role` 透传（`canvasNodeToVariant`）。守卫 `isReferenceNode`。
- **参考图不开放编辑工具栏**（`selectedImageNode` 排除 role=reference）：参考图是输入，不应圈选重绘/扩图/去水印（审计 HIGH#1）。
- **硬门**：万相是单 `base_image`；多参考图融合需 `wan2.5-image-edit`（记为升级路径，本批次未接）。

### 5.14 统一历史面板（UC，左侧 composer 一处收口）
把分散两处的历史（图像/视频在左侧 `DesignCostHistory`、原型在预览区工具栏 `VersionControl/VersionComparePicker`）统一为**左侧 composer 一处**，底层共用 T1 `variant spine` 抽象。

```
[图像/视频] DesignCostHistory（§5 T2，role-aware）：
   nodes 按 role 分流——参考图剔出版本时间线、单独成「参考图 ×N」分组（不占版本序号/不计累计花费）；
   版本时间线只认产物节点。
[原型] DesignProtoHistory（新建，左侧 composer）：版本下拉(看版/回最新) + 对比选择(选版/定稿)，
   复用现有 VersionControl/VersionComparePicker 纯组件；动作走 useProtoVersionActions(看版/回最新/设主版/淘汰)。
   compare 状态（compareIds/comparing）提升到 designStore：左侧选版、右侧对比浮层(VariantCompareView)共享同一状态；
   切 run（selectRun/startGenerating/startEditing/reset）自动 clearCompare；toggleCompareId 选版上限 2 FIFO。
   PreviewPane 移除工具栏版本控件，改 useEffect「看历史版时退圈选/就地编辑态」。
```
- **持久化对称性**：canvas 的 pin/discard 内联 `canvas.json` 节点字段（chosen/discarded），proto 在 `spine.json`——两种形态的回滚路径都正确（canvas 走 setChosen re-pin、proto 走 pin/discard）。故"对称化"作为"读写回滚正确性"已满足，**不需新建 canvas 侧 spine.json**。
- **故意保留的 UX 差异**：proto 多了 discard/compare/定稿（其特有交互），未强行对称到 canvas（避免过度工程）；两者数据模型同源、视觉语言一致、同处左侧。
- 渲染分流：DesignWorkspace composer 按 `imageMode → DesignCostHistory` / `protoMode(=!canvas && !slides) → DesignProtoHistory`。

### 5.15 Agent 操作画布（人审批，[ADR-026](../decisions/026-agent-operated-design-canvas.md)，2026-06-23 三刀合 main）

前述 §5.1-5.14 都是**用户直接操作 + AI 直连出图**。本节是新增的第三方：**agent 也能提议改画布，人点头后由 renderer 落地**。铁律——**agent 只提议、不直接落地**，真正改 store 的永远是 renderer（守"人主导"）；**main 进程永不直接 mutate 画布**。详细产品契约见 [2026-06-23 spec](../specs/2026-06-23-agent-operated-design-canvas.md)。

#### 数据流（提议 → 审批 → 落地）
```
[注入] design 模式每轮把 store 画布快照（节点 id/label/坐标 + 连线 + 形状计数，限长截断、排除 discarded）
        注入 agent 上下文（formatCanvasSnapshotForPrompt）——agent 只能引用快照里的真实节点 id。
[提议] agent 调 ProposeCanvasOps 工具 → 阻塞，main 经 CANVAS_PROPOSAL_ASK 推提议给 renderer。
[预览] renderer 持 pending（canvasProposalStore）→ CanvasProposalGhostLayer 在 Konva 画蓝色虚影（改）/红色叉（淘汰），
        含付费生成的 op 在 CanvasProposalReviewBar 显示预估 ¥（付费闸）。
[审批] 用户逐 op 勾选 → Apply/Reject。Apply 经 applyProposal 落地，结果（applied/skipped/真实花费）
        经 CANVAS_PROPOSAL_RESPONSE 回灌阻塞的工具 → agent 拿到地面真相。
[取消] agent abort / 工具超时 → main 广播 CANVAS_PROPOSAL_CANCEL → renderer 撤审批条（防孤儿提议被事后误点付费）。
```

#### op 契约（`src/shared/contract/canvasProposal.ts`，main 产出与 renderer 消费共用校验）
`CanvasProposalOp` 判别联合：`moveNode`/`addConnector`/`addShape`/`renameNode`（Layer1，一刀）+ `discardNode`（软删，三刀）+ `generateImage`（文生图，含付费，二刀）。`normalizeProposalOp` 剥离破损/越权 op——**硬删 `deleteNode` 永不在白名单**；`generateImage` 只留 `{prompt, model?, aspectRatio?}`（model 白名单校验在 renderer）。

#### 落地双相（`canvasProposalController.applyProposal`，二刀混批顺序写死）
| 相 | 内容 | 历史语义 |
|----|------|----------|
| Phase A（同步） | Layer1（move/connector/shape/rename）经 `store.applyProposalBatch` → 一次快照、一次 Cmd+Z 撤完 | 整批原子撤销单元 |
| discard | `discardNode` 软删（不进 Cmd+Z，靠"已淘汰·恢复"托盘找回） | 非破坏，variant spine 兜底 |
| Phase B（异步） | `generateImage` 串行付费出图（`designProposedImageGen.generateProposedImage` → 复用 `generateDesignImage` IPC，不落盘不清史，controller 收尾）；每张成功后**增量落盘** | 跨快照边界 |
| 收尾 | **当且仅当 ≥1 张生成真落地**才 `clearEditHistory`（全失败则保 Layer1 undo） | #274 边界不变量 |

- **Layer1 严格先于 Layer2，永不交错**：Layer2 加节点跨快照数组边界，收尾清史会销毁 Layer1 undo frame；若 Layer2 先跑则 Layer1 快照在节点集已变后才拍 → reconcile 错配重蹈"跨生成 undo 删节点"。
- **付费前置审批（红线①）**：预估 ¥ 由 renderer 查价表（`estimateImageCostCny`，pricing.ts 唯一真源）算并显示，**不信 agent 报价**；阻塞工具等待期间零付费调用，用户 Apply 后才真出图。拒绝/超时零花费。dogfood 实锤预估==实际（wanx t2i 0.14）。
- **模型/落位边界（红线②③）**：agent 提议 model 仅当是注册表内 t2i 模型才采纳，否则回退表单默认（`resolveProposedImageModel`）——不让 agent 引入新端点；生成图落位由 renderer 自动定（忽略 agent 坐标）。
- **并发锁（审计 R3）**：`applyingRequestId` 提升到 `canvasProposalStore`（全局单例、跨组件重挂存活），在 apply/reject/clear/cancel 每个边界按 requestId 校验——防双击 Apply 双付费、付费期间 CANCEL 撤 UI、并发提议互相误清。付费生成期间画布盖忙态遮罩（绑 `applying`）拦 konva 指针，防手动编辑被收尾清史误清。

#### 文件 / IPC / 测试
| 层 | 落点 |
|----|------|
| 契约 | `src/shared/contract/canvasProposal.ts`（op 联合 + normalizer + 快照格式化） |
| 工具（main） | `src/main/tools/modules/design/proposeCanvasOps.ts`(+`.schema.ts`)：阻塞往返 + 超时（含生成批按张数抬升）+ abort/超时广播 CANCEL |
| 控制器（renderer） | `canvasProposalController.ts`（双相 applyProposal）+ `applyCanvasProposal.ts`（纯应用引擎 + stale-target 防御）+ `designProposedImageGen.ts`（Layer2 付费出图核） |
| 状态/UI | `canvasProposalStore.ts`（pending + applyingRequestId 锁）+ `useCanvasProposalReview.ts`（订阅/应用/取消）+ `CanvasProposalReviewBar.tsx`（逐 op 勾选 + 付费闸）+ `CanvasProposalGhostLayer.tsx`（Konva 虚影） |
| IPC | `CANVAS_PROPOSAL_ASK`（main→renderer 提议）/ `CANVAS_PROPOSAL_RESPONSE`（裁决回灌）/ `CANVAS_PROPOSAL_CANCEL`（abort/超时撤 UI） |
| 测试 | `tests/unit/shared/canvasProposal.test.ts`、`tests/unit/design/{canvasProposalController,applyCanvasProposal,proposedImageModel}.test.ts`、`tests/unit/tools/modules/design/proposeCanvasOps.test.ts`、`tests/renderer/design/designCanvasStoreProposal.test.ts` |

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
| **`editImageByDescription({apiKey, prompt, baseImageDataUrl})`** | **参考图垫图原语（UC，§5.13）：wanx `function=description_edit`，base+prompt 无需 mask → `{url}`** |
| **`generateImageFromReference({prompt, referenceImageDataUrl})`** | **参考图垫图编排（UC，IPC 调用）：key 校验(付费前) → editImageByDescription → 下载 → `{imageData, actualModel='wanx2.1-imageedit'}`** |
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
| **通义万相** (DashScope) | `wanx2.1-t2i-turbo`（+ **参考图垫图 `function=description_edit`**，UC §5.13）| **`wanx2.1-imageedit` / description_edit_with_mask** | **`function=expand` / `remove_watermark`** | ❌ | `dashscope /api/v1/services/aigc/...` | 免 |
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
| `generateDesignImage` | `{prompt, aspectRatio?, outputPath, model?, **referenceImageDataUrl?**}` | `{path, actualModel, costCny}` | 按注册表 `model` 路由 engine(缺省 wanx)文生图→下载→写盘（T2：回传实际模型+花费）；空白 prompt 拦截防付费空调用。**UC §5.13：带 `referenceImageDataUrl` 时改走 `generateImageFromReference`(wanx description_edit 垫图，actualModel=wanx2.1-imageedit/costCny0.14)，key 校验在 service 首步、付费前** |
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
| UC §5.13 | 参考图垫图 | 生成前贴参考图（role=reference 节点，画布本就在故复用导入链路）→ 生成时首张喂 wanx `description_edit`(单图、base+prompt 无需 mask)；读失败显式报错不静默退化；参考图不开放编辑工具栏。多图融合需 wan2.5-image-edit（未接）。详见 §5.13 |
| UC §5.14 | 统一历史 | 历史收口到左侧 composer 一处：图像/视频 DesignCostHistory(role-aware，参考图单独分组不占版本序号)、原型 DesignProtoHistory(版本控件从预览工具栏并入左侧，compare 状态提升 store 与浮层共享)；底层共用 T1 spine。canvas 内联字段/proto spine.json 两种持久化回滚都正确，不强行对称 discard/compare 到 canvas。详见 §5.14 |

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

**前端**：`src/renderer/components/design/*`（含 T1 `variantSpine/variantAdapters/protoSpine/VariantCompareView`、T2 `variantHistory/DesignCostHistory`、T3 `DesignImageEditOps`、T6 `designPreviewInject`、**P1 `ImageModelPicker`、标注重绘 `AnnotationLayer/annotComposite`、CD-Parity `BrandManager`(§1)/`DesignVersionUI`(版本 UI 抽出)/`inlineTextEdit`(§3)、UC `DesignImportButtons`(导入/参考图按钮组)/`DesignProtoHistory`(proto 统一历史+useProtoVersionActions)**）、`src/renderer/components/QuestionFormPreview.tsx`(T5)、`stores/workspaceModeStore.ts`、`i18n/{zh,en}.ts(design)`、`App.tsx:776`
**主进程**：`main/ipc/workspace.ipc.ts`(design actions：含 T3 `handleExpandDesignImage`/`handleRemoveWatermarkDesignImage`、T4 region-lock 接线、**P1 `handleListVisualImageModels`+`generateDesignImage` model 路由、标注重绘 `handleEditImageByAnnotation`、CD-Parity brand `handleListBrands`/`handleSaveBrand`/`handleDeleteBrand`/`handleSetActiveBrand`/`handleExtractBrandFromImage` + 导出 `handleExportPrototypePdf`/`handleExportImagePdf`/`handleExportCanvasPptx`**)、`main/ipc/workspaceSaveExport.ts`(CD-Parity §2/§4 `saveBinaryToDownloads` 落盘出口)、`main/services/design/{brandRegistry,brandExtract,pdfExport,pptxExport}.ts`(CD-Parity §1/§2/§4)、`main/app/workbenchTurnContext.ts`(CD-Parity §1 `enrichDesignBriefForPrompt` 品牌强制注入)、`main/services/media/imageGenerationService.ts`(T3 `expandImage`/`expandScalesForDirection`/`removeWatermark`、**P1 gptimage 分支+`getGptImageConfig`+`isSafeImageUrl`、标注重绘 `editImageByAnnotation`**)、`main/services/media/imageConsistency.ts`(T4 `runRegionLockGate`)、`main/prompts/questionForm.ts`(T5)、`main/prompts/selfCritique.ts`+`design/critique/prompt.ts`(CD-Parity §1 brandContract 注入点)、`main/plugins/builtin/imageCreation/imageGenerate.ts`、`main/quality/*`(T6 `slop-gray-image-placeholder` lint)、`main/shellCapabilities.ts`(WORKSPACE 能力登记)、`main/agent/runtime/toolExecutionEngine.ts:911`(质量 hook 触发)
**共享/契约**：`shared/media/imageCost.ts`(T2)、`shared/constants/pricing.ts`(IMAGE_PRICING_CNY/DESIGN_IMAGE_MODELS/DESIGN_FLUX_MODEL)、**`shared/constants/visualModels.ts`(P1 视觉模型注册表 D1 单源)**、`shared/contract/imageConsistency.ts`(T4 RegionLockReport)、`shared/contract/designBrief.ts`(T5；CD-Parity §1 新增 `brandContract` 字段)、**`shared/contract/brandContract.ts`(CD-Parity §1 BrandContract + normalize + projection)**、`artifacts/question-form.ts`(T5)
**常量**：`shared/constants/designWorkspace.ts`(含 `DESIGN_SPINE_FILE`、`REGION_LOCK.{EPSILON=8,DIFF_SUFFIX}`)、`shared/constants/providers.ts`(MODEL_API_ENDPOINTS.dashscope)
**测试**：`tests/renderer/design/{variantSpine,variantAdapters,protoSpine,variantHistory,designPreviewInject,buildVariantNode,designStoreSpine,VariantCompareView,DesignCostHistory,DesignImageEditOps,designTypes,designCanvasTypes,designCanvasMask,designCanvasStore,designStore,imageModelPicker,annotationLayer,annotComposite,**DesignProtoHistory**}.test.*`（UC：`designCanvasTypes`+role/`variantAdapters`+role 透传/`DesignCostHistory`+role-aware 分组/`designStore`+compare FIFO/startEditing 清对比/`DesignProtoHistory` 渲染冒烟）、`tests/shared/constants/visualModels.test.ts`、`tests/unit/ipc/workspaceDesignImage.test.ts`(含 model 路由+listVisualImageModels+editImageByAnnotation+**UC 参考图 generateImageFromReference 路由/落盘/防 no-op**)、`tests/unit/services/media/imageGenerationService.test.ts`(含 gptimage+SSRF+editImageByAnnotation)、`tests/renderer/components/questionFormPreview.test.ts`、`tests/shared/media/imageCost.test.ts`、`tests/unit/main/services/media/imageConsistency.test.ts`、`tests/main/quality/designQuality.test.ts`
> **测试基建坑**：react-konva→`konva/index-node` 在 node 测试环境 `require('canvas')` 崩溃 → `tests/__mocks__/react-konva.ts` stub + `vitest.config.ts` alias（同 keytar 范式）。

---

## 15. 厚版演示稿（PR #260，2026-06-22）

「演示稿」从「画布有图才右上角导出 PPTX」的薄能力（§5.12 仍保留，是「图」tab 的画布工具）升级为**独立厚版生成链路**：真排版多页 deck，**SlideData[] 作为单一真源**，大纲编辑器 / 逐页预览 / 就地改字是它的三种视图。

### 15.1 引擎解耦（R1）
已有 PPT 引擎（`src/main/tools/media/ppt/*`，详见 `docs/guides/ppt-capability.md`）原本只被 agent 工具 `executePptGenerate` 调用。抽出可被设计 tab IPC 直调的纯 service：

- **`services/design/slidesGenerator.ts`** — `generateSlidesDeck(input) → {buffer, slidesCount}`：复刻 `pptGenerate.ts` legacy 路径（`outlineToSlideData`/`parseContentToSlides → registerSlideMasters → selectMasterAndLayout → fillSlide → pptx.write(nodebuffer)`），去掉 ToolContext/modelCallback/artifact/权限耦合。`buildSlidesOutline(topic,count)` 导出确定性 SCQA 大纲。内容通道优先级：已编辑 `slides` > Markdown `content` > topic 模板。**service 保持纯净（不发网络），付费编排全在 IPC 层，故单测不误触付费。**
- 引擎纯核函数零拷贝复用：`outlineToSlideData`/`registerSlideMasters`/`selectMasterAndLayout`/`fillSlide`。

### 15.2 流程与状态
```
填需求(topic) → [生成大纲] → 右侧大纲编辑器(逐页改/增删/排序) → [生成演示稿] → 真排版 PPTX 导出下载
                  generateSlidesOutline IPC          designSlidesStore               generateSlidesDeck IPC
```
- **`designSlidesStore.ts`**（zustand）：`outline: SlideOutlineItem[]` 单一真源 + 状态（buildingOutline/generating/previewing/result/error）。大纲修改包装 **`slidesOutlineOps.ts`** 纯不可变操作（updateSlide/addSlideAfter/removeSlide/moveSlide/updatePoint/addPoint/removePoint/sanitizeOutline），`applyEdit` 共享 setter 改大纲即清像素预览（防过时）。
- **`DesignSlidesPanel.tsx`**（侧栏）：页数 slider + AI 大纲 opt-in + AI 配图 opt-in + 生成大纲/生成演示稿两步。
- **`SlideOutlineEditor.tsx`**（右侧预览面板）：「大纲编辑 ↔ 像素预览」模式切换；编辑态逐页卡片（标题/副标题/要点就地改字 + 增删/上下移/插入），预览态懒加载渲染图。

### 15.3 四增强（均 opt-in，付费路径成本前置）
| 增强 | 模块 | 要点 |
|------|------|------|
| **#3 品牌色注入** | `services/design/brandTheme.ts` | OKLCH→sRGB 标准矩阵（`color.ts` 不转 oklch、tinycolor2 不支持；黑/白精确锚点验证数学）；`themeConfigFromBrand` 把品牌契约色板(primary/surface/accent/muted/contrast)/字体栈映射进 `ThemeConfig`。`slidesGenerator.resolveTheme`：显式 theme 优先，否则 `getActiveBrandSync()` 自动注入。**免费、自动**。 |
| **#1 AI 大纲** | `services/design/slidesAiOutline.ts` | lazy `new ModelRouter()`（无构造参数）+ 默认 provider(xiaomi/mimo)/`getApiKey`，对齐 `compactModel.ts`；调文本模型 → `parseContentToSlides`。**opt-in 付费**，无 key/失败/空响应降级确定性模板（`aiUsed` 反映）。 |
| **#2 像素预览** | IPC `generateSlidesPreview` | 据 topic/大纲生成 deck → 写 design 临时目录 → 复用 `visualReview.convertToScreenshots`（LibreOffice→PDF→pdftoppm JPEG 150DPI）。**本地免费**；LibreOffice 未装 `libreOfficeMissing=true` 引导安装。 |
| **#4 AI 配图** | `services/design/slidesIllustrator.ts` | 内容页（纯函数选目标：跳封面/结尾/空标题，封顶 maxImages）调设计 tab 同款生图（`imageEngineForModel` 解析 wanx/cogview/flux/gptimage，与 `handleGenerateDesignImage` 同源）→ 写盘 `SlideImage[]` → `generateSlidesDeck` 的 `images` 入参喂 `fillSlide` 走 `CONTENT_IMAGE` 图文母版。**opt-in 付费**，**模型用户在页面选**（复用 `<ImageModelPicker>` 读写 `designStore.imageModel`），出图前预估 + 事后实际 `costCny`；单页失败不阻塞。 |

### 15.4 IPC 契约（WORKSPACE domain，新增）
| action | handler（`ipc/workspaceSlidesExport.ts`） | 入/出 |
|--------|------|------|
| `generateSlidesOutline` | `handleGenerateSlidesOutline` | `{topic, slidesCount, ai?}` → `{slides, aiUsed}` |
| `generateSlidesDeck` | `handleGenerateSlidesDeck` | `{topic?/slides?, content?, theme?, illustrate?, imageModel?, maxImages?, outputName}` → `{filePath, slidesCount, costCny}` |
| `generateSlidesPreview` | `handleGenerateSlidesPreview` | `{topic?/slides?...}` → `{screenshots[], slidesCount, libreOfficeMissing?}` |

> **godfile 纪律**：slides handler 拆 `workspaceSlidesExport.ts`（含一并迁入的 `handleExportCanvasPptx`），路径守卫 `assertWithinDesignDir` 拆 `workspaceDesignPaths.ts`，把 `workspace.ipc.ts` 压回 ≤1000 effective 行（eslint max-lines skipBlank+skipComment）。

### 15.5 文件 + 测试
- **service**：`services/design/{slidesGenerator,slidesAiOutline,slidesIllustrator,brandTheme}.ts`
- **IPC**：`ipc/{workspaceSlidesExport,workspaceDesignPaths}.ts`；`shellCapabilities.ts` 登记 `generateSlides{Outline,Deck,Preview}`
- **前端**：`components/design/{DesignSlidesPanel,SlideOutlineEditor,designSlidesStore,slidesOutlineOps}.ts(x)`；`DesignWorkspace.tsx`（媒介聚合 + 路由 + slides 占位/编辑器）；`designFiles.ts`（client）；`i18n/{zh,en}.ts`
- **测试**：`tests/unit/services/design/{slidesGenerator,slidesAiOutline,slidesIllustrator,brandTheme}.test.ts` + `tests/renderer/design/{mediaTabs,slidesOutlineOps}.test.ts`（纯逻辑；真 LLM/出图付费不进单测）
- **端到端验收**（直打 HTTP IPC + 截图）：媒介切换/图二级 ✓ · 大纲→改→渲染 PPTX 反映编辑 ✓ · 品牌注入(同页绿黑→蓝白) ✓ · 像素预览(渲染真排版页) ✓ · AI 大纲(aiUsed:true 主题定制) ✓ · AI 配图(wanx 1280×720 嵌图文母版,costCny 0.14 准确) ✓

> **dogfood 坑**：演示稿生成按钮被 `fixed inset-0 z-50` 预览 overlay 拦截点击 + React 受控 textarea 的 evaluate setter 回退 → 可靠法=坐标 `page.mouse.click(x,y)`+keyboard.type，或直打 `POST /api/domain/workspace/<action>`（Bearer=.dev-token，body `{payload,requestId}`）。`build:web` 只构建服务端，renderer 要 `npx vite build` 单独。
