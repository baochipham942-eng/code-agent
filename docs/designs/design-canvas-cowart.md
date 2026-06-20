# 设计稿/信息图画布（Cowart 式无限画布 + 圈选标注迭代）· Spec

> **Status**: ✅ v1 已实现并真实端到端验证（2026-06-21）。P0 画布接入 / P1 文生图回灌 / P2 圈选标注→真 inpaint(wanx2.1-imageedit) / P3 A/B 对比 全部完成。6 提交在 worktree `code-agent-canvas`（feat/design-canvas-cowart），未推远程待拍板合并。引擎=通义万相；画布=konva 自研。后续可选：工作流历史链 / agent 自主多轮编辑 / aspect_ratio 选择。
> **来源**: `/competitor-borrow-analysis` 四路并行调研（tldraw 库 / make-real 架构 / Liblib 星流(Cowart) / 图像模型编辑能力）+ 我方 as-built 复核
> **分支**: `feat/design-canvas-cowart`（worktree `code-agent-canvas`，基于 `feature/kun-design-quality-hook`）
> **生成日期**: 2026-06-20
> **前序**: `docs/competitive/kun-设计tab-借鉴清单.md`（现有设计 tab = HTML 原型；本 spec 开"图像产物"新方向）

---

## 0. 一句话定性

> **本功能 = 把现有"设计 tab"的右侧预览面板，从"iframe 渲 HTML"换成"konva 无限画布"，产物从"单文件 HTML"换成"画布上的图像节点"，交互从"填表单一次性生成"升级为"圈选区域 + 标注 → 局部重绘(真 inpaint) → 结果回灌画布 → 在结果上继续圈选迭代"。**

骨架同构现有设计 tab：`agent + 工具 + surface`。本次只换 surface（预览面板 → 无限画布）与产物（HTML → 图像），agent 循环 / 会话隔离 / 图像生成基建全部复用。

**与竞品的范式差（我方差异化）**：Liblib 星流(Cowart) 把"选区编辑"刻意降级、靠 Agent 自动定位元素回避手画蒙版——代价是用户实测"无法选中某个区域精确修改"（最大软肋）。**我们反其道而行：把"用户精确圈选 + 区域级标注 ground 到模型"做成一等公民**，这正是星流主动让出的空地。

---

## 1. 调研结论汇总（去魅 + 证据）

### 1.1 tldraw（无限画布库）— 调研参考（⚠️ 因 license 最终未选，改用 konva，见 §2.1）

> 下表是 tldraw 能力调研。它能力最全但商用 $6,000/年或带水印，用户拍板改走 MIT 的 konva 自研；保留此表是因为 konva 要对照补齐这些能力（API 映射见 §2.1）。

| 能力 | tldraw API（shipped）| 用途 |
|------|------|------|
| 数据模型 | `store` / record（shape/asset/page 都是纯 JSON record）；`getSnapshot` / `loadSnapshot`；`.tldr` = snapshot JSON | 画布存档 |
| 命令式读写 | `<Tldraw onMount={(editor)=>...}>` 拿 editor，store 可在 React 外读写 | 我方编排可命令式操作画布 |
| 读选区 | `editor.getSelectedShapeIds()` / `getSelectedShapes()` / `getSelectionPageBounds()` | 拿圈选区域 + bounds |
| 导出选区为图 | `editor.toImage(ids, {format:'png'})` → `{blob}`；`toImageDataUrl` → dataURL | 选区截图喂视觉/图像模型 |
| 写 image shape | `AssetRecordType.createId()` + `editor.createAssets([{type:'image', props:{src, w, h, mimeType}}])` + `editor.createShape({type:'image', props:{assetId, w, h}})`；src 接受 **base64 dataURL 或 URL** | imagegen 结果回灌画布 |
| 自定义 shape | `ShapeUtil` 子类，`component()` 返回任意 React/HTML | "生成中"占位 shape / 对比 shape |
| 持久化 | 内置 IndexedDB（`persistenceKey`）或自定义（`getSnapshot` 落盘）| 我方改用 konva `stage.toJSON()` 落 `~/.code-agent/design/<run>/canvas.json` |

- **版本/兼容**：最新 `tldraw@5.x`，包名 `tldraw`，React 18/19 兼容，纯前端无后端依赖。**当前我方 node_modules 未安装**（需新增依赖）。
- **去魅**：tldraw **只提供画布，零 AI 能力**——模型、图像生成、prompt 编排全要我们自带（BYO model）。这对我们是好事：基建归 tldraw，AI 归我们已有的图像链路。
- ⚠️ **许可证（决策点）**：生产环境需 license key（`<Tldraw licenseKey=...>`）。三档：Trial（100 天免费评估）/ Commercial（商用付费，需谈价）/ Hobby（非商用免费但**画布带 "made with tldraw" 水印**）。
- 来源：tldraw.dev/docs/{persistence,shapes}、/sdk-features/{assets,image-export}、/community/license。

### 1.2 make-real 编排骨架 — ✅ 100% 可借鉴（只换产物层）

tldraw 官方 `make-real`（画布线框 → AI → HTML）的编排骨架，对我们做"画布 → 图像"几乎全可复用：

1. **选区获取**：`editor.getSelectedShapes()`，空选区报错。
2. **选区栅格化**：`editor.toImage(shapes, {format})` → base64，喂模型。
3. **标注语义提取（最该抄）**：`getTextFromSelectedShapes.ts` 遍历选区，把 `text/geo/arrow/note` 类 shape 按页面坐标排序抽文本；**红色 shape 前缀打 `Annotation:`**——把"红色=标注"从图像层提升到文本层，双通道冗余（截图里有红框 + 文本里有标注），防 vision 看不清小字。
4. **占位先建后填**：调 API 前先 `editor.createShape` 占位（放选区右侧 `x:maxX+60`），结果到达再 `updateShape`。
5. **产物是一等 shape**：生成结果本身是可再框选的 shape → "在结果上继续圈选标注再生成" 天然闭环。

**三处必须换（HTML 产物 → 图像产物）**：

| 环节 | make-real（HTML）| 我方（图像）|
|------|------|------|
| 回填 shape | 自定义 `PreviewShapeUtil`（iframe 渲 HTML）| tldraw **原生 image shape**（asset + createShape）|
| 后端 | `streamText` 返回 HTML 文本流 | 图像生成/编辑 API 返回图片二进制/URL |
| 迭代回灌 | 旧版 **HTML 源码文本** | 旧版**图片本身**当 init image + 标注转 prompt/mask（**正是 make-real 注释掉的那条 image 回灌通道**——对我们反而是主路径）|

- 来源：github.com/tldraw/make-real（`useMakeReal.ts` / `getTextFromSelectedShapes.ts` / `getMessages.ts` / `PreviewShape.tsx`）。

### 1.3 Liblib 星流(Cowart) — 范式参考（不照抄）

- **本质**：无限画布 + **对话式**（chat-driven）AI 设计 Agent。核心是"右侧对话框写需求 → Agent 铺多张结果 → 选中调工具/继续对话"，**不是**"圈选→改图"。圈选只是边缘能力。
- **圈选 ground 方式（去魅）**：多通道分流——Tab 快速编辑 = **整图** img2img（无 mask，实测"无法选区域"）；擦除/涂抹工具 = 真 inpaint（带 mask）；换元素 = Agent **自动生成 mask**（用户不手画）。官方话术"框选元素精修"= 营销整合，实测体验割裂。
- **底层模型**：自研 Star-3（官方承认与 **Flux.1 同架构**，社区定性"F.1 换皮微调"）；画布内支持 LoRA/ControlNet/多图参考。
- **可借鉴亮点**：① 无限画布 = 多方案铺陈场（并排比较）；② **每张图的处理过程打包成可回溯"工作流"历史链**（生成→擦除→换元素→放大 串成一条）。
- **用户软肋（= 我方机会）**：选区精度弱（控不住改哪块）、中文文字处理差、出图不稳/同 prompt 漂移大、无结构化 A/B 对比。
- **画布技术栈**：无法确认自研 vs 开源库（公开资料未触及）。
- 来源：硅星人/凤凰实测、aihub 产品页、liblib.art Star-3 模型评论区、小红书/B站声量。

### 1.4 图像编辑能力 — ⚠️ **可行性硬门**

核心闭环要的是"圈选区域 → 局部重绘"。现有两引擎到底支不支持：

| 引擎 | 文生图 | 参考图编辑(img2img) | mask 局部重绘(inpaint) | 结论 |
|------|--------|------|------|------|
| 智谱 CogView-4（**我方现接端点**）| ✅ | ❌ | ❌ | `/images/generations` **只吃 `{model,prompt,size}`**，无 image/mask 入参。**注**：智谱 GLM-Image 模型层面据称支持 image-to-image/编辑，但对应端点我方**未调研未接入，待核**——别把"我们没接"当成"智谱没有" |
| FLUX.2 / OpenRouter（现有）| ✅ | ✅（`messages` 塞 `image_url` 输入图）| ❌（全生态在 OpenRouter 这层无 mask 参数）| **能做"参考图整图编辑"，做不到像素锁定 mask**。非编辑区（含文字/品牌色）**可能明显漂移**。⚠️ `image_config.strength` 官方文档只见于 Recraft，**FLUX.2 能否吃待落地实测**，别当现成卖点。⚠️ 现有代码 content 是纯文本，要改成多模态数组塞 `image_url`——**不是零代码** |
| **通义万相 `wanx-x-painting`（B 路线新接）⭐** | — | ✅ | ✅ `base_image_url`+`mask_image_url` **真 inpaint** | 国产、**免代理**、异步任务（提交+轮询）。最对齐"框内精确改、框外不动"诉求 |
| fal.ai FLUX.1 Fill / Kontext（备选）| — | ✅ | ✅ 真 inpaint | 质量上限最高，**需代理**，按量计费 |

**硬门结论（修正后）**：
1. **图生图能做，但"框内精确局部重绘"是另一回事**：现有 FLUX.2/OpenRouter 能做"参考图整图编辑"（喂输入图 + 文字 → 出新图），但**无 mask = 整图会漂移**，文字/品牌色这些设计稿最在意的元素最易漂。
2. **整图图生图 = 与竞品（星流）软肋同级**：星流被吐槽的"无法选区域、整图 img2img"正是这个；若 v1 只做图生图，**§0 的"精确圈选"差异化卖点当期兑现不了**。
3. **真差异化（框内精确、框外不动）必须走 mask inpaint**：通义万相 `wanx-x-painting` 是国产里唯一文档清晰、免代理、原生 `base_image_url`+`mask_image_url` 的真 inpaint。**→ 本 spec 选定 B 路线：v1 直接接通义万相 inpaint。**
- 来源：docs.bigmodel.cn（CogView-4）、openrouter.ai（flux.2-pro，image editing $0.015/MP）、docs.bfl.ml（FLUX.2 editing 无 mask）、help.aliyun.com（wanx-x-painting）、ConsistEdit/Kontext 论文（FLUX 编辑漂移）、fal.ai。

---

## 2. 架构设计

### 2.1 画布库 — **已定：konva + react-konva（自研，非 tldraw）**

用户拍板规避 tldraw 的 $6,000/年商用 license / 水印，走 MIT 的 **konva**（配官方 React 绑定 `react-konva`，最贴我方 React 18 + Zustand 栈）。konva 原生提供选区(Transformer)/缩放/平移/hit-test/序列化/image 对象/导出，自研只需补 undo/redo（复用 Zustand state history，konva 官方亦推荐此法而非画布序列化）+ React 自定义 shape 桥接。

**make-real 的编排骨架（§1.2）仍 100% 借鉴**，只是 tldraw 专有 API 映射到 konva：

| 概念 | tldraw（make-real 用）| konva 等价（我方实现）|
|------|------|------|
| 读选区 | `editor.getSelectedShapeIds()` | Transformer 选中节点 / 自维护 selectedIds（Zustand）|
| 选区 bounds | `getSelectionPageBounds()` | `node.getClientRect()` |
| 导出选区为图 | `editor.toImage(ids)` | `stage.toDataURL({x,y,width,height,pixelRatio})` 或 `node.toDataURL()` |
| 写 image shape | `createAssets`+`createShape({type:'image'})` | `new Konva.Image({image})`（src 走 dataURL/URL 加载）|
| 画布存档 | `getSnapshot`/`.tldr` | `stage.toJSON()` + 自管 image src 引用（图片落盘，JSON 存路径）|
| 自定义占位/对比 shape | `ShapeUtil` | react-konva 组件 / Konva.Group |
| 标注红色分流 | `getTextFromSelectedShapes`（红→Annotation）| **业务逻辑，与库无关，直接移植** |

### 2.2 数据模型 — 画布存档同构现有 run 目录

复用现有 `resolveDesignDir`（`workspace.ipc.ts:666` → `getUserConfigDir()/design`，即 `~/.code-agent/design/`）。每次画布会话一个 run 目录，沿用现有 `run-<ts>` 约定：

```
~/.code-agent/design/run-<ts>/
├── canvas.json           # konva stage 存档（stage.toJSON + 图片路径引用，画布真理源）
├── assets/               # 画布上每张图的 PNG（image_generate/image_edit 落盘处）
│   ├── gen-<ts>.png
│   └── edit-<ts>.png
└── meta.json             # run 元数据（需求/上下文/版本树，可选）
```

- **画布状态真理源 = `canvas.json`**（konva `stage.toJSON()` + 自管图片 src 引用）。renderer 侧防抖序列化 → 经 WORKSPACE domain IPC 写盘；重开反序列化恢复。
- **图片真理源 = `assets/*.png` 文件**；`Konva.Image` 的图片**用文件路径加载**（canvas.json 只存相对路径，避免 JSON 内嵌 base64 膨胀；加载时回填 dataURL）。
- 设计草稿目录已豁免游戏校验 + 从聊天侧栏过滤（`DESIGN_WORKSPACE.DRAFT_PATH_MARKER`），不破坏现有 `artifactRepairGuard` / `toolArtifactValidationLifecycle` 隔离逻辑。

### 2.3 surface 替换 — `PreviewPane` → `DesignCanvas`

现 `DesignWorkspace.tsx` 右侧 `PreviewPane`（iframe srcDoc）替换为 `<DesignCanvas>`（konva/react-konva 包裹）。当 `outputType === 'mockup' | 'infographic'` 走画布；`prototype` 仍走现有 iframe（HTML 原型不变，不回退）。即产物类型选择器里的"设计稿/信息图"从"即将"转为画布模式。

---

## 3. 闭环设计（标注 → imagegen → 回填）

### 3.1 整体流（renderer 编排，借 make-real 骨架）

```
① 首次生成（文生图）
   用户填需求/品牌色/语气 → buildImagePrompt → image_generate(文生图)
   → 落盘 assets/gen-<ts>.png → renderer new Konva.Image 放上画布

② 圈选标注迭代（核心新增）
   用户在画布上：框选某张图 + 画红色矩形/箭头标注要改的区域 + 写文字
   → renderer:
      a. 取选中节点（Transformer / selectedIds）= 被选图 + 标注
      b. stage.toDataURL(选区 bounds) → 选区截图（base64）
      c. 抽标注文本（移植 getTextFromSelectedShapes：红色→"Annotation: 改这里"）
      d. 选区里的图 → 找到对应 assets/*.png 当底图（base_image）
      e. 红色矩形 bounds → 栅格化成 mask 图（通义万相 inpaint 必需）
   → 调 image_edit（见 §4，通义万相 wanx-x-painting）→ 落盘 assets/edit-<ts>.png
   → renderer 在原图右侧 new Konva.Image 放新版（占位先建后填）

③ 继续迭代 = 回到 ②（结果图也是画布节点，可再框选）
```

### 3.2 标注语义约定（移植 make-real，本地化）

- **红色矩形/箭头 = 标注区域**：bounds 进 mask（inpaint 引擎）；文字进 prompt 前缀 `标注:`。
- **非红色文字 = 全局指令**：进 prompt 正文。
- 与现有 `formatDesignContextLines`（品牌色/语气/反 AI 痕迹）拼接，保持设计上下文一致。

### 3.3 引擎能力分档（**本 spec 选定 B 路线：主引擎 = 通义万相 inpaint**）

| 档 | 引擎 | 用到的步 | 体验 | 本 spec 定位 |
|----|------|---------|------|------|
| **B（选定）⭐** | 通义万相 `wanx-x-painting` | d+e（init image + mask）| 真·像素锁定，**框外不变** | **v1 主路径**——红色矩形 bounds → mask → 框内精确改 |
| A（降级）| FLUX.2 / OpenRouter | d（init image），跳过 e | 整图参考重绘，**非编辑区（含文字/品牌色）可能明显漂移** | 仅"未配阿里云 key"时的兜底；与竞品软肋同级，**不作为差异化卖点** |
| C（最末降级）| 智谱 CogView-4 / MiniMax | 仅 c（标注文本拼 prompt）| 整图全部重生成 | 无任何编辑 key 时的最末兜底 |

> **决策依据**：用户现有图像 key（智谱/OpenRouter-FLUX/MiniMax）**没有一个**支持真 mask inpaint；"框内精确局部重绘"是本功能立意核心，故 v1 直接接通义万相。**关键利好：用户已有阿里云百炼（DashScope）key** → 通义万相 `wanx-x-painting` 走 DashScope，**零新增 key 成本、国内端点免代理**，B 路线外部依赖已清零。档 A/C 仅作 key 缺失时的优雅降级，不是产品主张。

---

## 4. 工具契约（image shape / 图像编辑）

### 4.1 agent-facing 工具：**新增 builtin `image_edit`**（不走 MCP）

与现有 `image_generate`（builtin）同构、同目录 `plugins/builtin/imageCreation/`。理由：MCP 是跨进程外部工具，图像生成是 host 原语（已在 `imageGenerationService`），builtin 直连最省。

```ts
// image_edit schema（草案）
{
  name: 'image_edit',
  params: {
    prompt: string,            // 编辑指令（含标注文本）
    input_image: string,       // 底图：文件路径 或 dataURL（base image）
    mask_image?: string,       // mask（白=改/黑=留）；B 路线主路径必传，降级档可省
    output_path?: string,      // 默认 assets/edit-<ts>.png
    strength?: number,         // 仅档 A FLUX.2 用（偏离强度）；⚠️ FLUX.2 是否吃待实测
    aspect_ratio?: ...,
  }
}
```

- **引擎路由**（B 优先，逐级降级）：扩展 `imageGenerationService` 新增 `editImage(...)`：
  1. **配了百炼 key（默认主路径）→ 通义万相 `wanx-x-painting`**：`base_image_url`+`mask_image_url`，DashScope **异步任务**（提交拿 task_id → 轮询 `GET /tasks/{id}`）。免代理。
  2. 否则配了 OpenRouter → 档 A FLUX.2 参考图编辑（`messages` content 改为数组塞 `image_url` 输入图；现有代码是纯文本 content，**需改造**；`strength` 落地实测后再决定是否暴露）。
  3. 否则（智谱/MiniMax）→ 档 C 拼 prompt 调 `image_generate` 整图重生成。
- **mask/底图上传**：通义万相收 URL（`base_image_url`/`mask_image_url`）。底图与 mask 需先变成 DashScope 可访问的 URL——优先用 DashScope 临时文件上传通道；落地时确认上传方式（这是 P2 主要新增工作量之一）。
- **产出契约对齐现有 `image_generate`**：落盘 PNG + 返回 `meta.artifact`(file) + `meta.imagePath`，renderer 据此回灌画布。
- **新常量进 `shared/constants`**：DashScope 端点、`wanx-x-painting` model id、轮询间隔/超时（禁硬编码）。

### 4.2 画布读写 = **renderer 职责，不做成 agent 工具**

agent 不"看见"画布。选区读取（`getSelectedShapeIds`/`toImage`）、image shape 写入（`createAssets`/`createShape`）、mask 栅格化全在 renderer 完成。agent 只负责"给 prompt + input/mask 路径 → 出一张图落盘"。这与现有 `useDesignGeneration`（renderer 编排 + 派给设计会话 + 轮询产物文件）架构一致，agent 与画布解耦。

> **这是 v1 阶段取舍，不是终局架构**（skeptic 点 3）。renderer 编排稳、快、与现状同构，是 v1 正确选择；但代价是 agent 永远"看不见"自己改的是哪块，**多步自主编辑（"自己看结果不满意→自己再框一块改"）这条 agentic 路被堵死**，永远需要人来圈。后续若要 agent 自主多轮编辑，演进口子是：把画布只读快照暴露给 agent（`get_selection`/`canvas_snapshot` 工具）+ 写回工具（`add_image_shape`）。对一个标榜"复刻 Claude Code"的 Agent 产品，这是值得留的演进方向，但**不在 v1 范围**。

---

## 5. 与现有链路怎么接

| 现有资产 | 复用方式 |
|------|------|
| `image_generate`（builtin，CogView/FLUX）| ① 首次文生图直接调；不改 |
| `imageGenerationService`（host 原语）| 新增 `editImage()` 兄弟函数（参考图编辑 + inpaint 路由）|
| `useDesignGeneration`（renderer 编排 + 设计会话隔离 + 轮询产物）| 扩展：从"轮询 html"改为"轮询 assets/*.png 并回灌画布" |
| `resolveDesignDir` / run 目录约定 | 直接复用，加 `canvas.json` + `assets/` |
| WORKSPACE domain IPC（readFile/listFiles/createFolder）| 复用读写画布存档与图片 |
| `workspaceModeStore`（code/design 顶层 tab）| 不动；设计模式内切 prototype/画布 |
| `formatDesignContextLines`（设计上下文）| 拼进编辑 prompt |
| 会话隔离 / artifact 豁免 | 不破坏；新引擎产物仍落设计草稿目录 |

---

## 6. 决策点（请用户拍板）

**全部拍板已定（用户 2026-06-20）**：

| # | 决策 | 拍板结果 | 影响 |
|---|------|---------|------|
| **D1** | 画布库 | **konva/fabric 自研**（MIT，零 license 成本）→ 选 **konva + react-konva**（官方 React 绑定，最贴我方 React 18 栈）| 放弃 tldraw（规避 $6,000/年或水印）；P0 工期更长：要自研 undo/redo（复用 Zustand state history，反而和我方架构更搭）+ React 自定义 shape 桥接。make-real 的编排骨架仍可借鉴，tldraw 专有 API 映射到 konva（见 §2.1）|
| **D2** | 引擎 | **B 档真 inpaint = 通义万相 `wanx-x-painting`**（用户已有百炼 key，免代理，零新增依赖）| v1 直接上真 inpaint，不做"先 A 后 B"过渡；档 A(FLUX.2)/C 仅作 key 缺失降级 |
| **D3** | v1 范围 | **核心闭环 + 结构化 A/B 版本对比**（星流的软肋=我方差异化）| A/B 对比进 v1（不再是 P4 增量）；工作流历史链留后续 |
| **D4** | 成本 | 通义万相 inpaint = DashScope 按量计费，仅画布显式"生成/编辑"触发 | UI 显示本 run 已用次数；迭代频繁时累积可控 |

---

## 7. 分期落地（待 D1/D3 拍板后细化）

| 阶段 | 做什么 | 关键文件 | 成本 |
|------|------|------|------|
| **P0 画布接入** | 装 konva + react-konva；新建 `DesignCanvas`（stage ref 存外部）；undo/redo（Zustand state history）；画布存档 `canvas.json`（`stage.toJSON` + 图片路径引用）读写（IPC）；产物类型"设计稿/信息图"→ 画布模式（去"即将"）| `package.json`、新建 `design/DesignCanvas.tsx`、`designStore`/`workspace.ipc.ts` | 中-高 |
| **P1 文生图回灌** | image_generate 产物 → `new Konva.Image` 放画布；占位先建后填 | `useDesignGeneration.ts`、`DesignCanvas.tsx` | 低-中 |
| **P2 圈选标注 → 真 inpaint 闭环（核心）** | 选区读取(Transformer) + `stage.toDataURL` 截图 + 标注抽取（移植 getTextFromSelectedShapes 红色分流）+ 红色 bounds → mask 栅格化 + 新建 `image_edit` builtin + `editImage()` 路由（**通义万相 `wanx-x-painting` 主路径**：异步提交+轮询、底图/mask 上传）+ 回灌 | 新建 `imageCreation/imageEdit.ts`、`imageGenerationService.ts`、`shared/constants.ts`（DashScope 端点/model/轮询常量）、mask 工具、画布编排 | 高 |
| **P3 A/B 版本对比（v1 差异化）** | 同一原图的多版结果结构化并排 + 选定/淘汰 + 标记当前主版；星流没有的结构化 diff | designStore（版本树）、`DesignCanvas`/对比 UI | 中 |
| **P4 降级档 + 韧性** | 无百炼 key 时降级档 A（FLUX.2 content 改多模态塞 image_url，`strength` 实测）/ 档 C；错误/超时处理 | `imageGenerationService.ts` | 中 |
| **P5 增量（后续）** | 每图可回溯工作流历史链（星流亮点）| designStore / 画布 UI | 中 |

**纪律**：i18n（`t.design.*` 全量 zh/en）· 禁硬编码（端点/模型/超时/阈值进 `shared/constants`）· TDD（类型层 designTypes/标注抽取/引擎路由先写测试）· dogfood 用 MiMo web 模式 · 新逻辑进独立模块（`design/` / `imageCreation/`），不堆 `App.tsx`/`databaseService` · 高风险改动（新工具/共享类型/计费）落地后走 codex-audit 对抗审查。

---

## 8. 风险 / 护栏

- **R1 通义万相异步任务复杂度**：DashScope inpaint 是"提交→轮询 task_id"异步模型，且底图/mask 要先变成可访问 URL（上传）。护栏：P2 先用脚本打通 DashScope 提交+轮询+上传链路再接 UI；轮询间隔/超时进常量。降级档 A 文案诚实标注"参考重生成、非像素锁定"。
- **R2 konva 自研工作量**：undo/redo + React 自定义 shape 桥接 + A/B 版本树要自研（D1 已选自研换零 license 成本）。护栏：undo/redo 复用 Zustand state history（konva 官方推荐法、和我方栈同源）；P0 先把"建图/选区/导出/序列化"四件套跑通再叠交互。
- **R3 画布 JSON 膨胀**：图片若内嵌 base64 会撑爆 `canvas.json`。护栏：图片落盘 `assets/`，`canvas.json` 只存相对路径，加载时回填。
- **R4 回归现有 HTML 原型**：prototype 路径不动，画布只在 mockup/infographic 生效；交付前回归现有原型生成。
- **R5 成本失控**：图像编辑按次付费且迭代频繁。护栏：仅画布显式操作触发；接付费新引擎（通义万相/fal）前报成本。

---

## 9. 源索引

**竞品侧**：
- tldraw：tldraw.dev/docs/{persistence,shapes,ai}、/sdk-features/{assets,image-export,external-content}、/community/license、npm `tldraw@5.x`
- make-real：github.com/tldraw/make-real（`app/hooks/useMakeReal.ts`、`app/lib/getTextFromSelectedShapes.ts`、`app/lib/getMessages.ts`、`app/PreviewShape/PreviewShape.tsx`、`prompts/openai-system-prompt.md`）；tldraw.dev/blog/make-real-the-story-so-far
- Liblib 星流(Cowart)：xingliu.art、liblib.art Star-3 模型页、硅星人/凤凰实测、aihub.cn/tools/design/xingliu
- 图像编辑 API：docs.bigmodel.cn（CogView-4）、openrouter.ai/black-forest-labs/flux.2-pro、docs.bfl.ml/flux_2/flux2_image_editing、help.aliyun.com/zh/model-studio/vary-region-api-reference（wanx-x-painting）、platform.minimax.io/docs/api-reference/image-generation-i2i（MiniMax image-01：仅 subject_reference 人物参考，无 mask）、fal.ai/models/fal-ai/flux-pro/v1/fill
- tldraw 商用 license $6,000/年：tldraw.dev/community/license + 第三方报道

**我方 as-built 锚点**：
- 现有设计 tab：`renderer/components/design/{DesignWorkspace,designStore,designTypes,useDesignGeneration,designFiles}.tsx`、`stores/workspaceModeStore.ts`
- 图像链路：`main/plugins/builtin/imageCreation/imageGenerate.ts`、`main/services/media/imageGenerationService.ts`（`determineImageEngine`/`generateImage`/`downloadImageAsBase64`）
- 设计目录/常量：`main/ipc/workspace.ipc.ts:666`（resolveDesignDir → `getUserConfigDir()/design`）、`shared/constants/designWorkspace.ts`（`DESIGN_WORKSPACE`）
- 会话隔离/豁免：`main/agent/runtime/{artifactRepairGuard,toolArtifactValidationLifecycle}.ts`
