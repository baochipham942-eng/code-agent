# 设计模式：非 wanx 模型「标注重绘」编辑（spec）

> **状态**：设计已拍板（2026-06-21），待实现。
> **来源**：spec `design-mode-model-switcher.md` §6 扩展点「非 wanx 模型的标注重绘编辑（借鉴 Cowart）」。
> **前置**：建立在 P1 生图模型切换器之上（注册表 `visualModels.ts`、gptimage engine、T2 成本透明、T1 variant spine）。分支 `feat/design-annotation-redraw`，基于 `feat/design-model-switcher`（P1）。
> **配套**：架构 `docs/architecture/design-mode.md`。

---

## 1. 目标 / 非目标

**目标**
- 给**非 wanx 模型**（首刀 gpt-image-2）开一条**不依赖 mask inpaint** 的图像编辑路径：画布上画标注（红色笔/箭头/矩形/文字）+ 写文字指令 → 把「原图+标注」拍扁成一张整图喂模型的编辑端点 → 出新图并排挂 spine。
- **能力标签化、模型无关**的架构：注册表加 `annotEdit` cap，凡声明该 cap 的模型即入选；引擎实现按模型逐个落地，第一刀只实装 gpt-image-2。

**非目标（本期不做）**
- wanx 的 mask 类编辑（局部重绘 T4/扩图 T3/去水印）保持不变——它走原生 mask inpaint，不收进 annotEdit。
- flux/cogview 的 annotEdit 引擎实现（架构留口，本期不接，靠声明 cap + 实装端点后续插入）。
- 视频标注 / 多图参考编辑 / 标注模板库（后续）。

---

## 2. 设计决策

| # | 决策 | 结论 |
|---|------|------|
| **A1** | 模型范围 | **注册表 cap 驱动、模型无关**。`ImageCap` 加 `'annotEdit'`；gpt-image-2 caps→`['t2i','annotEdit']`。架构不锁模型，但引擎实现逐模型落地，**第一刀只实装 gpt-image-2**。 |
| **A2** | 输入机制 | **标注烘进截图 + 文字指令**（Cowart / make-real 原法）。renderer 把 `[原图 + 标注层]` 合成导出一张 PNG，连同文字指令一起喂模型整图编辑端点。视觉指向比纯文字精准。 |
| **A3** | 标注工具 | **完整工具栏**：红色笔（自由）/ 箭头 / 矩形 / 文字标签。konva 形状层，与 wanx 的二值 mask 刷子物理隔离（那是 白=改/黑=留，本层是可见红色标注）。 |
| **A4** | 服务端点 | gptimage engine 走 OpenAI 兼容 **`POST {base}/v1/images/edits`**（multipart：`image`=拍扁的标注图、`prompt`=指令、`model`=gpt-image-2），取 **b64_json** 落盘。base+key 复用 `getGptImageConfig`（env 优先→config），**不进代码**。 |
| **A5** | 产物落点 | 结果挂 **variant spine**（T1）：新 `CanvasImageNode`，`parentId=源图节点 groupKey`，新 pinned 变体，**非破坏**（源图不覆盖，可并排对比/设主版/回滚）。复用 `buildVariantNode`。 |
| **A6** | 成本透明 | 走 **T2**：出图前显著提示预估 ¥（gpt-image-2 编辑与生成同档 ¥0.25，价表唯一真源 `pricing.ts`），confirm 后才发起付费调用；实际花费由 main 权威回传 `costCny`。 |
| **A7** | 安全 | 复用 P1 的 **SSRF 守卫**（`isSafeImageUrl`）。edits 走 b64 不触发 url 下载；但守卫已收口在 `downloadImageAsBase64` 单一入口，任何未来返回 url 的编辑模型自动受护。路径仍走 `assertWithinDesignDir`。 |

---

## 3. 架构

### 3.1 注册表（`src/shared/constants/visualModels.ts` 改）
```ts
export type ImageCap = 't2i' | 'maskEdit' | 'expand' | 'annotEdit';   // 新增 annotEdit
// gpt-image-2: caps: ['t2i', 'annotEdit']
```
- 纯查询函数加 `imageModelsWithCap('annotEdit')`（驱动「标注重绘」可选模型列表，∩ 已配 key）。
- wanx 不加 annotEdit（其 mask inpaint 更优，D2 保持）。

### 3.2 价表（`src/shared/constants/pricing.ts`）
- 复用 `'gpt-image-2': 0.25`（编辑与生成同档，无新价项；若将来 edits 计费不同再拆）。

### 3.3 服务层（`src/main/services/media/imageGenerationService.ts` 改）
```ts
// 新增（与 generateImage 同级）：
export async function editImageByAnnotation(input: {
  engine: ImageEngineId;
  annotatedImageDataUrl: string;   // renderer 拍扁的 [原图+标注] PNG dataURL
  instruction: string;             // 文字指令
  outerSignal?: AbortSignal;
}): Promise<{ imageData: string; actualModel: string }>;
```
- gptimage 分支：把 dataURL 还原成 Buffer，multipart `image`+`prompt`+`model`+`size`+`n=1` POST `${base}/v1/images/edits`；取 `data[0].b64_json` → `data:image/png;base64,...`；`actualModel='gpt-image-2'`。错误体逐字透出（沿用 P1 质量修）。timeout 复用 `TIMEOUT_MS.GPTIMAGE_GENERATION`（120s）。
- 非 gptimage engine：抛「该模型暂不支持标注重绘」（cap 守门兜底）。

### 3.4 IPC（`src/main/ipc/workspace.ipc.ts` + 登记 `shellCapabilities.ts`）
| action | 入参 | 出参 |
|--------|------|------|
| `editImageByAnnotation`（新） | `{model, annotatedImageDataUrl, instruction, outputPath}` | `{path, actualModel, costCny}` |
- `handleEditImageByAnnotation`：① 校验必填 + `instruction.trim()` 非空（防 paid no-op，沿用 P1 MED 修）；② `assertWithinDesignDir(outputPath)`；③ **cap 守门**：`imageModelById(model)?.caps.includes('annotEdit')` 否则抛错（不发付费调用）；④ 取 engine→`editImageByAnnotation`→落盘→`costCny=estimateImageCostCny(actualModel)`。
- dispatch case + WORKSPACE 能力数组按字母序插入 `editImageByAnnotation`（capability-diff 闸）。

### 3.5 renderer（`src/renderer/components/design/`）
- **标注层**（`DesignCanvas.tsx` 扩展 / 新 `AnnotationLayer.tsx`）：konva 形状层，红色；四工具——自由笔（Line points）/ 箭头（Arrow）/ 矩形（Rect 描边）/ 文字（Text）。一个「标注重绘」模式开关（与圈选 mask 模式互斥）。
- **合成导出**：提交时把 `[选中图节点 + 标注层]` 按原图分辨率 `toDataURL` 合成一张 PNG（konva group/stage 导出），作 `annotatedImageDataUrl`。
- **指令输入**：composer 加文字指令框（必填，placeholder 例「把红圈处 logo 改成猫头，去掉标注线」）。
- **可选模型**：标注重绘的模型下拉 = renderer 侧用 shared 注册表 `imageModelsWithCap('annotEdit')` 取候选，与 P1 `listVisualImageModels` 回传的 `available` 求交（cap 过滤在 renderer 用注册表纯函数做，可用性仍由主进程 IPC 权威给——不新增 IPC）。
- **成本 confirm**（T2）→ invoke `editImageByAnnotation` → 结果 `buildVariantNode(parentId=源图)` 挂 spine + `addNode` + `saveCanvasDoc`。
- **i18n**：工具栏标签 / 指令 placeholder / 成本 confirm / 错误，zh+en 同步（en 类型源）。

---

## 4. 数据流
```
选图节点 → 「标注重绘」模式 → 工具栏画红标注 + 写指令
→ 估算 ¥ confirm
→ konva 合成 [原图+标注] → annotatedImageDataUrl
→ IPC editImageByAnnotation{model, annotatedImageDataUrl, instruction, outputPath}
→ cap 守门 → engine → /v1/images/edits(multipart) → b64 → 落盘
→ buildVariantNode(parentId=源图, pinned) → addNode → saveCanvasDoc
```

---

## 5. 硬门 / 风险
1. **【项目级硬门】relay 是否支持 `/v1/images/edits`**：P1 已验 `/v1/images/generations` 通，但 edits 是另一端点，第三方中转支持与否未知。**Phase A 必须先做后端 + 一次真编辑 dogfood 验这道门**；不通则 gpt-image-2 标注重绘整条路阻塞（需换 relay 或换模型），**先验门再建 UI**。
2. 标注合成保真度：konva 按原图分辨率导出 image+overlay，避免缩放失真 / DPR 错位。
3. gpt-image 编辑慢（~60-90s）+ 中转偶发超时：timeout≥120s（复用现成常量），失败给可读错误不阻断画布。
4. 多部分请求体：OpenAI `/v1/images/edits` 走 `multipart/form-data`（不是 JSON），Node 端需用 FormData/Blob 构造——与现有 JSON POST 不同，Phase A 重点核实 relay 的 multipart 兼容。

---

## 6. 分期（每期独立可测、独立交付）
- **Phase A（后端，先做，含硬门验证）**：注册表 `annotEdit` cap + `editImageByAnnotation` 服务（gptimage `/v1/images/edits`）+ IPC + 能力登记 + 单测。**收尾跑一次真编辑 dogfood 验硬门**（关门则停，不进 Phase B）。
- **Phase B（前端）**：标注工具栏（笔/箭头/矩形/文字）+ konva 合成导出 + composer 指令框 + 模型下拉（annotEdit cap 过滤）+ 成本 confirm + spine 接线 + i18n。

---

## 7. 测试
- 注册表 `annotEdit` cap + `imageModelsWithCap` 纯单测。
- 服务层 `editImageByAnnotation` mock fetch：multipart body 形状（image/prompt/model 字段）、b64 解析、缺 key 报配置、错误体透出、非 gptimage engine 抛错。
- IPC 契约：cap 守门（非 annotEdit 模型不发付费调用）、`assertWithinDesignDir` 路径守卫、`instruction` 空白拦截（paid no-op）、`costCny` 查表。
- renderer：标注层合成导出（分辨率/合成正确）、工具栏组件、spine 回灌。
- 真 key dogfood（**付费，提示成本**）：gpt-image-2 标注重绘 1 次（验硬门 + 端到端，约 ¥0.25）。

---

## 8. 文件清单（预计）
- 改：`shared/constants/visualModels.ts`（annotEdit cap + 查询）、`main/services/media/imageGenerationService.ts`（editImageByAnnotation）、`main/ipc/workspace.ipc.ts`、`main/shellCapabilities.ts`、`renderer/components/design/{DesignCanvas,DesignWorkspace,useDesignCanvasGeneration,designStore}.tsx/ts`、`i18n/{zh,en}.ts`。
- 新增：`renderer/components/design/AnnotationLayer.tsx`（或并入 DesignCanvas）、对应 `tests/**`。

---

## 9. 纪律
TDD / i18n(zh/en，en 类型源) / 禁硬编码（模型/端点/价入 constants）/ 新逻辑独立模块不堆 godfile / 新 renderer IPC 同步登记 shellCapabilities / 改 prompt bump PROMPT_VERSION（本期不改 prompt）/ 付费 dogfood 前提示成本 / 隔离 worktree / 高风险（计费/外部请求/multipart）走对抗审计。
