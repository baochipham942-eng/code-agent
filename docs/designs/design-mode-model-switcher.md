# 设计模式：生图/视频模型切换 + 视频生成（spec）

> **状态**：✅ P1 已实现并合并 main（2026-06-21，merge cbf847a5b）+ 付费 dogfood 通过。P2/P3 视频未做。as-built 见 `docs/architecture/design-mode.md` §6.0/§5.2。
> **来源**：用户需求「让设计模式能切生图/视频模型」+ 借鉴清单二档「能力感知模型路由 + @-mention」（`docs/competitive/opendesign-lovart-借鉴清单.md`）。
> **前置**：建立在已发版 v0.18.0 的设计模式（画布 + 原型 + T1-T6 变体 spine/成本/一致性）之上。
> **配套**：架构 `docs/architecture/design-mode.md`；产品 spec `docs/designs/design-mode-spec.md`。

---

## 1. 目标 / 非目标

**目标**
- 设计模式**文生图**可在多个图像模型间切换（wanx / CogView / FLUX / **gpt-image-2**，gpt-image 文字/UI 渲染最强，当设计稿首选）。
- 新增**视频生成**能力（净新）：文生视频(t2v) + 图生视频(i2v)，可在多个视频模型间切换（通义万相视频 / MiniMax 海螺）。
- 模型选择只用**用户在 Neo 设置里配置的 key**，且只列**视觉生成模型**。

**非目标（本期不做）**
- 图像 **mask 类 op（局部重绘 T4 / 扩图 T3 / 去水印）的多模型化**——这些仍固定 wanx（cogview/flux 不支持 mask）。
- 聊天/LLM 模型选择（与设计模式无关，物理隔离）。
- 视频的局部编辑 / 视频转视频 / 配音配乐（后续）。
- 新 key / 海外新 provider（Kling/Veo 等留二批）。

---

## 2. 设计决策

| # | 决策 | 结论 |
|---|------|------|
| **D1** | 模型注册表 | **能力标签化注册表**为单一真源，驱动①切换器选项 ②服务层路由 ③每模型可用 op。取代散落的 if-else（如 `determineImageEngine`）。 |
| **D2** | mask 类 op | **编辑/扩图/去水印保持 wanx 专属**。切换器只控「文生图/视频生成」；选了非 wanx 生图模型时，mask 类 op 自动回退 wanx（带提示），不随切换器变。 |
| **D3** | 视频成本 | 视频按秒计费（比图贵一个量级）；**生成前显著提示预估 ¥**，走 T2 成本透明层 + 落 variant 的 `costCny`。 |
| **D4** | key 来源 | **全复用用户已配 key**（`configService.getApiKey`）：zhipu / dashscope(qwen) / openrouter / minimax。零新 key、零代理。 |
| **D5** | 成本可逆 | 视频/图像产物均挂 **variant spine**（T1）：可重生成、并排对比、设主版、可逆历史（T2）。 |
| **D6** | 切换器可见性 | 切换器**只列「已配 key」的模型**（注册表 ∩ 已配 key）。未配 key 的模型灰显 + 「去设置配置 X」提示。 |
| **D7** | 仅视觉模型 | 切换器**只列视觉生成模型**（image `t2i/maskEdit/expand` + video `t2v/i2v` 能力命中者），按**能力标签**过滤——provider 同时含聊天模型（GLM/Qwen/MiniMax-chat）时一律过滤掉。 |
| **D8** | gpt-image-2（自定义 OpenAI 兼容端点） | 新增 `gptimage` engine：OpenAI `/v1/images/generations`，**取 b64_json 直接落盘**（不走 url 下载），**设计场景不加 NO_TEXT 后缀**（gpt-image 强项是文字/UI 渲染）。端点 base+key 从 config 读（env `GPTIMAGE_PROXY_BASE/_KEY` 优先，同 `getDashscopeApiKey` 范式），**绝不进代码**。caps=`['t2i']`（不支持 mask/expand，mask 类 op 仍 wanx，D2 不变）。中转不稳→做成可配置 provider，挂了换 URL 即可。gemini/grok image 同端点可后续加，本期不接。 |
| **D9** | url 下载 SSRF 守卫 | 顺手堵 `downloadImageAsBase64`/`isImageUrl` 的潜在洞：**仅允许 https、拒绝私网 IP**（127./10./172.16-31./192.168./169.254./localhost）。对 gpt-image-2（纯 b64）不触发，但护住 wanx OSS url + 未来返回 url 的模型。 |

---

## 3. 架构

### 3.1 模型注册表（`src/shared/constants/visualModels.ts` 新增）
```ts
type ImageCap = 't2i' | 'maskEdit' | 'expand';
type VideoCap = 't2v' | 'i2v';

interface VisualImageModel {
  id: string;            // 如 'wanx2.1-t2i-turbo'
  label: string;         // UI 显示名
  provider: ProviderId;  // 'dashscope' | 'zhipu' | 'openrouter'
  engine: ImageEngine;   // 'wanx' | 'cogview' | 'flux'（复用 generateImage）
  caps: ImageCap[];
  pricing: PricingRef;   // 指向 pricing.ts
}
interface VisualVideoModel {
  id: string;            // 如 'wan2.x-t2v' / 'minimax-hailuo'
  label: string;
  provider: ProviderId;  // 'dashscope' | 'minimax'
  caps: VideoCap[];
  pricing: PricingRef;   // ¥/秒 或 ¥/视频
}
export const IMAGE_MODELS: VisualImageModel[] = [...];
export const VIDEO_MODELS: VisualVideoModel[] = [...];
```
- 价表统一进 `pricing.ts`（D1 单源，禁硬编码）。
- 纯数据 + 纯查询函数（`modelsForKeyset(configuredProviders)` / `defaultImageModel()`），可单测。

### 3.2 服务层（`src/main/services/media/`）
- **图像**：`generateDesignImage` 出参不变，**入参加 `model?: string`**；按注册表 `engine` 路由到现有 `generateImage(engine,...)`。缺省取 `defaultImageModel()`（按已配 key）。
- **视频**：新建 `videoGenerationService.ts`
  - `generateVideo({ model, mode, prompt, imageDataUrl?, durationSec? }) → { url, actualModel }`
  - 路由：dashscope wan 视频 / minimax 海螺，二者均**异步任务**——dashscope 复用 `submitAndPollWanx` 范式；minimax 走其任务提交+轮询（新 helper `submitAndPollMinimaxVideo`）。
  - key 经 `getDashscopeApiKey()` / `getApiKey('minimax')`。

### 3.3 IPC（`src/main/ipc/workspace.ipc.ts` + 登记 `shellCapabilities.ts`）
| action | 入参 | 出参 |
|--------|------|------|
| `generateDesignImage`（改） | `{prompt, aspectRatio?, outputPath, model?}` | `{path, actualModel, costCny}` |
| `generateDesignVideo`（新） | `{mode:'t2v'\|'i2v', prompt, baseImagePath?, outputPath, model, durationSec?}` | `{path, actualModel, costCny, durationSec}` |
- 复用 `assertWithinDesignDir` 守路径；新 action 登记 WORKSPACE 能力数组（capability-diff 闸）。

### 3.4 画布 / renderer（`src/renderer/components/design/`）
- **新节点类型** `CanvasVideoNode`（`designCanvasTypes.ts` 扩展联合类型）：`{ kind:'video', src(mp4 相对路径), poster?, width, height, durationSec, prompt?, parentId?, ... 复用 variant 字段 }`。
  - 渲染：konva 上缩略图(poster/首帧) + 播放控制（点击展开 `<video>` 浮层或就地播放）。懒加载同图片（经 `readBinary`）。
  - 序列化容错同 `CanvasImageNode`。
- **切换器 UI**（composer，`DesignWorkspace.tsx`）：
  - 产物类型扩展：原型 / 设计稿 / 信息图 / **视频**。
  - 视觉模式时显示**生图模型下拉**；视频模式时显示**视频模型下拉 + 模式(t2v/i2v)**。选择持久化进 `designStore`（同 aspectRatio）。
  - 下拉项 = `modelsForKeyset(已配 provider)`；未配 key 项灰显 + 提示。
- **i2v 入口**：选画布某图节点 →「生成视频」→ 用其 src 作 `baseImagePath` → 视频节点 `parentId=图`（挂血缘 + spine）。
- **成本提示**：复用 T2 成本徽标/估算，视频估算用时长 × ¥/秒，**生成前 confirm 显示 ¥**。

---

## 4. 数据流

### 4.1 文生图（带模型）
```
选生图模型 M → 点生成 → ensureCanvasRun → buildImagePrompt
→ IPC generateDesignImage{prompt, aspectRatio, outputPath, model:M}
→ 注册表查 M.engine → generateImage(engine,...) → 落盘 → 回灌 variant（挂 spine + costCny）
```
### 4.2 文生视频 t2v
```
选视频模型 V + 模式 t2v → 写描述 → 估算 ¥ confirm
→ IPC generateDesignVideo{mode:t2v, prompt, outputPath, model:V, durationSec}
→ videoGenerationService 路由 V → 异步提交+轮询 → 下载 mp4 落盘
→ 回灌 CanvasVideoNode（挂 spine + costCny + durationSec）
```
### 4.3 图生视频 i2v
```
选画布图节点 → 「生成视频」选模型 V + i2v → 估算 ¥ confirm
→ 读底图 → IPC generateDesignVideo{mode:i2v, baseImagePath, prompt?, model:V}
→ 服务层把底图作首帧/参考 → 异步 → mp4 落盘
→ CanvasVideoNode(parentId=图) 放图右侧 → addNode → saveCanvasDoc
```

---

## 5. 异步与健壮性
- 视频生成耗时长（分钟级）：复用 submit+poll，`generating` 态 + 进度文案；超时/失败给可读错误不阻断画布。
- 成本闸：缺 key → 报「去设置配置 X key」（不发起付费调用）；时长/参数越界主进程先拦（沿用 T3 expand 的边界校验范式，避免付费空调用）。
- key 仅在主进程解析，不进 renderer / 不落盘。

---

## 6. 分期（每期独立可用、独立 PR）

- **P1 生图模型切换器**（小）：注册表 + `generateDesignImage` 加 model + composer 生图下拉 + D6/D7 过滤。**不碰视频**。
- **P2 视频生成 MVP**（中大）：`videoGenerationService`（通义万相视频 t2v+i2v）+ `generateDesignVideo` IPC + `CanvasVideoNode` 渲染 + 视频模式 UI + 成本提示。单 provider。
- **P3 多 provider**（中）：接 MiniMax 海螺 + 视频模型下拉补全（≥2 视频模型可切）。

### 扩展点（后续候选，非本期）

- **非 wanx 模型的「标注重绘」编辑（借鉴 Cowart）**：当前 D2 限定 mask 类编辑（局部重绘/扩图）只有 wanx 支持，cogview/flux/gpt-image 因不支持 mask inpaint 而**只能文生图**。借鉴 Cowart（钟二信 Codex 插件，tldraw 画布；Neo 的 konva 自研画布正是为规避其 tldraw $6k/年商用 license）的「**标注→截图整图→模型重绘**」工作流，可给**非 wanx 模型开一条不依赖 mask 的编辑路径**：画布上圈选/标注 → 截当前节点整图 → 带标注指令喂模型（如 `把红圈处改成 X、去掉标注线`）→ 出新图并排挂 spine。**gpt-image-2 尤其契合**（指令跟随强、整图编辑是其强项）。落点：复用现有圈选/标注 UI + variant spine；新增一条 `editImageByAnnotation(model, baseImage, annotatedScreenshot, instruction)` 走非 wanx 模型的整图编辑端点。**优先级**：P1（多模型切换）+ P2（视频）落地后再评估，避免本期扩散。

---

## 7. 测试
- 注册表/能力过滤/默认模型选择 纯单测。
- `videoGenerationService` mock submit+poll（成功/超时/缺 key）。
- IPC `generateDesignVideo` 契约测 + 路径守卫。
- `CanvasVideoNode` 序列化/反序列化容错测。
- 成本估算（图 + 视频按秒）测。
- 真 key dogfood（**付费，会提示成本**）：P1 切 cogview/flux 出图各 1；P2 wanx i2v + t2v 各 1；P3 海螺 1。

---

## 8. 文件清单（预计）
- 新增：`shared/constants/visualModels.ts`、`main/services/media/videoGenerationService.ts`、`renderer/components/design/CanvasVideoNode.*`（或并入 DesignCanvas）。
- 改：`shared/constants/pricing.ts`（视频价）、`main/services/media/imageGenerationService.ts`（generate 加 model 路由）、`main/ipc/workspace.ipc.ts`、`main/shellCapabilities.ts`、`renderer/components/design/{DesignWorkspace,designCanvasTypes,designCanvasStore,useDesignCanvasGeneration,designStore}.tsx/ts`、`i18n/{zh,en}.ts`。

---

## 9. 纪律
i18n(zh/en) / 禁硬编码（模型/端点/价入 constants）/ TDD / 新逻辑独立模块不堆 godfile / 新 renderer IPC 同步登记 shellCapabilities / 改 prompt bump PROMPT_VERSION / 高风险（计费/协议）走 codex-audit / dogfood 付费前提示成本 / 隔离 worktree。
