# Design Mode 架构（设计工作区 as-built）

> **范围**：Neo/code-agent 顶层「设计」工作区的完整技术架构——交互原型(HTML) + 设计稿/信息图(图像无限画布) + 设计质量自检。基于 2026-06 两轮迭代（Kun 借鉴打底 + Cowart 式画布）提炼。
> **状态**：as-built（feat/design-canvas-cowart，PR #257）。
> **配套文档**：产品 spec `docs/designs/design-mode-spec.md`；画布深度设计 `docs/designs/design-canvas-cowart.md`；竞品来源 `docs/competitive/kun-设计tab-借鉴清单.md`。

---

## 1. 概览

Design Mode 是覆盖在 Code 工作区之上的**全屏设计工作台**，用同一套 `agent + 工具 + surface` 骨架支撑**三条产品路径**：

| 产物类型 | 本质 | 生成方式 | Surface |
|---------|------|---------|---------|
| **交互原型** (`prototype`) | 单文件可交互 HTML | **agent 编排**（写文件 + 轮询）| iframe `srcDoc` |
| **设计稿** (`mockup`) | 静态 UI 图 | **renderer 直连 IPC** → 通义万相 | konva 无限画布 |
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
DesignCanvas.tsx           konva 无限画布：平移/缩放/图节点/选择/圈选标注/局部重绘面板/导入(粘贴·拖拽)
DesignCompareOverlay.tsx   A/B 版本对比浮层：两版等高并排 + 设为主版/淘汰
WorkspaceModeSwitch.tsx    顶层 Code/设计 切换
```

非组件模块：

```
designTypes.ts             纯类型 + prompt 构造（无 React，可单测）：
                           DesignOutputType / DesignSurface / DesignAspectRatio /
                           formatDesignContextLines / buildPrototypePrompt / buildImagePrompt
designCanvasTypes.ts       画布文档模型 + 序列化容错：CanvasImageNode / DesignCanvasDoc /
                           serialize|deserializeCanvasDoc / nextNodePlacement
designCanvasMask.ts        圈选→mask：worldRectToImageRegion(纯,求交裁剪) / normalizeDragRect /
                           buildMaskDataUrl(DOM canvas 黑底白区)
designStore.ts             表单 + 原型运行态 + 历史（zustand persist）
designCanvasStore.ts       画布运行态：nodes/camera/selectedIds/generating（persist 仅 runDir）
designFiles.ts             renderer 文件工具：readWorkspaceFile / findRunHtml / readRunHtml /
                           resolveDesignDir / readWorkspaceImageAsDataUrl
designCanvasPersistence.ts canvas.json 读写 + ensureCanvasRun（生成/导入共用建 run）
useDesignGeneration.ts     原型生成 hook（agent 编排 + 轮询 html）
useDesignCanvasGeneration.ts 画布出图 hook：generate(文生图) + editRegion(局部重绘)
useDesignCanvasImport.ts   自由画布导入 hook：importFiles(File[] → 落 assets → 节点)
```

---

## 4. 状态层

### designStore（`code-agent-design`，persist 表单/历史/选中）
- 表单：`requirement / brandColor / tone[] / surface / outputType / aspectRatio`
- 原型运行态（不持久）：`status / error / previewPath / previewHtml`
- 历史：`history[] / selectedRunDir`

### designCanvasStore（`code-agent-design-canvas`，**persist 仅 `runDir`**）
- 运行态：`runDir / nodes[] / camera / selectedIds / generating / error`
- 真理源是磁盘 `canvas.json`——节点/相机不进 localStorage，刷新后由 `runDir` 回读磁盘恢复（见 §10），避免双源。
- 关键 action：`loadDoc / addNode / updateNode / deleteNode / setChosen(标主版+清同 parentId 组) / setCamera / setSelected / toDoc`

---

## 5. 三条数据流

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
→ IPC WORKSPACE/generateDesignImage{prompt, aspectRatio, outputPath} → 主进程调通义万相文生图
→ 落盘 assets/gen-*.png → readWorkspaceImageAsDataUrl 读回 → 量原始尺寸
→ nextNodePlacement 落点(最右节点右侧+gap) → addNode → saveCanvasDoc
```

### 5.3 圈选局部重绘（`useDesignCanvasGeneration.editRegion`）
```
选图 → 圈红框标注(世界坐标) + 写指令 → worldRectToImageRegion 映射成图内局部像素矩形
→ buildMaskDataUrl(黑底白区) → IPC WORKSPACE/editDesignImage{prompt, baseImagePath, maskDataUrl, outputPath}
→ 主进程读底图 base64 + mask → 通义万相 wanx2.1-imageedit inpaint → 落盘 assets/edit-*.png
→ 回读 → 新节点(parentId=底图,记血缘) 放底图右侧 → addNode → saveCanvasDoc
```

### 5.4 自由画布导入（`useDesignCanvasImport.importFiles`）
```
添加图片 / ⌘V 粘贴 / 拖拽 → File→dataURL → ensureCanvasRun
→ IPC WORKSPACE/importDesignImage{dataUrl, outputPath} 写盘 assets/import-*.png
→ 量尺寸 → addNode（与生成图同构，选中即可圈选重绘）
```

---

## 6. 图像引擎层（`src/main/services/media/imageGenerationService.ts`）

host 可直调的纯原语（不感知 ToolContext/权限）：

| 函数 | 作用 |
|------|------|
| `generateImage(engine, fluxModel, prompt, aspectRatio)` | 文生图，engine ∈ `cogview\|flux\|wanx` |
| `editImageWithMask({apiKey, prompt, baseImageDataUrl, maskImageDataUrl})` | 局部重绘（wanx2.1-imageedit）|
| `submitAndPollWanx(apiKey, path, body)` | 通义万相异步任务通用 helper（提交+轮询 /tasks）|
| `determineImageEngine()` | 引擎优先级：智谱官方 key→cogview；OpenRouter→flux；**否则抛错（不含 wanx）** |
| `getDashscopeApiKey()` | env `DASHSCOPE_API_KEY` 优先 → `qwen`/`dashscope` 槽位 |
| `downloadImageAsBase64 / isImageUrl` | URL 产物下载转 base64 |

引擎矩阵：

| 引擎 | 文生图 | 局部重绘(mask) | 端点 | 代理 |
|------|--------|------|------|------|
| 智谱 CogView-4 | ✅ | ❌ | `zhipuOfficial /images/generations` | 免 |
| FLUX.2 (OpenRouter) | ✅ | ❌（仅参考图编辑）| `openrouter /chat/completions` | 需 |
| **通义万相** (DashScope) | `wanx2.1-t2i-turbo` | **`wanx2.1-imageedit` / description_edit_with_mask** | `dashscope /api/v1/services/aigc/...` | 免 |

**两条调用入口（重要区分）**：
- **agent-facing 工具** `plugins/builtin/imageCreation/imageGenerate.ts`（`image_generate`）：走 `determineImageEngine()`（cogview/flux）。PPT 插图 / 通用 agent 用。**设计画布不走它**。
- **设计画布直连**：`generateDesignImage`/`editDesignImage` IPC **固定通义万相**（spec D2 钦定），与上面解耦——故未改 `determineImageEngine`，对 PPT/CogView/FLUX 零回归。

> 设计场景出图**保留文字**（不追加"禁止文字"后缀），因信息图/设计稿需要文字。

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
| `generateDesignImage` | `{prompt, aspectRatio?, outputPath}` | `{path}` | 固定 wanx 文生图→下载→写盘 |
| `editDesignImage` | `{prompt, baseImagePath, maskDataUrl, outputPath}` | `{path}` | 读底图 base64 + mask → wanx inpaint→写盘 |
| `importDesignImage` | `{dataUrl, outputPath}` | `{path}` | base64 dataURL → 写盘 |
| `getDesignMdSummary` | `{cwd?}` | `string\|null` | 读 design.md 摘要 |

复用的通用文件 action：`readFile / writeFile / readBinary({base64,mimeType}) / listFiles / createFolder`。

---

## 10. 持久化与文件布局

```
~/.code-agent/design/                       resolveDesignDir(getUserConfigDir()/design)
└── run-<ts>/                               每次画布会话/原型生成一个 run
    ├── canvas.json                         画布真理源(stage 节点+相机；图片只存相对路径)
    ├── assets/                             gen-*.png / edit-*.png / import-*.png
    └── prototype.html                      交互原型产物（原型路径）
```

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

---

## 13. 扩展点

- **agent 自主多轮编辑**：暴露画布只读快照（`get_selection`/`canvas_snapshot`）+ 写回工具给 agent，实现"自己看结果再改"。
- **工作流历史链**：`parentId` 血缘已就绪，可视化版本树（星流亮点）。
- **新图像引擎**：`generateImage`/`editImageWithMask` 加 engine 分支即可（gpt-image edits 等）。
- **原型高级特性**：设备切换/圈选改/版本快照（独立分支 feat/design-proto-v0，未并入本分支）。

---

## 14. 文件索引 + 测试

**前端**：`src/renderer/components/design/*`、`stores/workspaceModeStore.ts`、`i18n/{zh,en}.ts(design)`、`App.tsx:776`
**主进程**：`main/ipc/workspace.ipc.ts`(design actions)、`main/services/media/imageGenerationService.ts`、`main/plugins/builtin/imageCreation/imageGenerate.ts`、`main/quality/*`、`main/agent/runtime/toolExecutionEngine.ts:911`(质量 hook 触发)
**常量**：`shared/constants/designWorkspace.ts`、`shared/constants/providers.ts`(MODEL_API_ENDPOINTS.dashscope)
**测试**：`tests/renderer/design/{designTypes,designCanvasTypes,designCanvasMask,designCanvasStore}.test.ts`、`tests/main/quality/designQuality.test.ts`
