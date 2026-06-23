# Alma → Neo 借鉴清单

> **来源**：Alma（yetone 出品，macOS 桌面 AI 助手）本机安装版 `0.0.836`（`/Applications/Alma.app`，反编 `app.asar` + 本机配置取证）
> **调研方式**：本机应用包字符串取证（asar grep）+ 1 路只读 Explore 核 Neo as-built + 1 轮独立 context codex 对抗评审（读真实主进程代码交叉验证）
> **我方产品 / 定位**：Neo = **cowork 人机协作产品**（人和 AI 协作完成各类工作、产物为主轴、对标 Manus），**不是"AI 编程助手/code agent"品类**（"Code Agent"仅仓库代号），用户默认非程序员协作者。本文聚焦其**设计画布产物 surface**：人在驾驶位直接操作画布迭代设计产物，AI 做生成与辅助
> **生成日期**：2026-06-23

---

## 一句话定性（去魅）

**Alma = 通用 AI 桌面助手**（聊天 + 无限画布 + 记忆 + 生图一体），不是专门的设计工具。它与 Neo 的重叠面只在「**无限画布 + 生图 + 标注迭代**」这一块。两者闭环范式同源（生成→标注→重绘→回落画布），但**品类不同**：Alma 以聊天为主入口、画布是产物；Neo 以画布直接操作为主线。

> ⚠️ 别被推文唬住：yetone 6/23 推文宣传的"无限画布"是 Alma 既有 canvas 能力（包内 canvas 相关 6600+ 处），"Image Generation 模型自定义"才是真新增卖点（`addImageModel` + `ModelForm` + 满包 `OpenAICompatible`/`baseURL`/`customProvider`）。

---

## as-built 纠偏（codex 实读主进程代码，修正 Explore/记忆的过度声称）

落稿前必看——以下是我方现状被高估处，已据 codex 读真实代码修正：

| 原声称 | 真实情况（`src/main/ipc/workspace.ipc.ts` 实证） |
|---|---|
| region-lock 强保真领先 Alma | ⚠️ **best-effort**：sharp 不可用 / gate 抛错时降级写原始输出、不阻断（line 200/220）。对外只能说"有 diff-gate + 回贴机制" |
| 全链路成本透明 | ⚠️ 文生图/标注/inpaint 回 `costCny`，但**扩图、去水印只回 `{path}`**（line 232/276），未覆盖全动作 |
| 已有 SSRF 守卫可复用 | ❌ **撤回**。生图取图路径是裸 `fetch(payload.url)`（line 622），无现成 `validateImageUrl` 可复用 |
| 三条设计分支全合 main | ⚠️ 存疑：Explore 说已合，记忆里 model-switcher/annotation/T2-T4 多为"未推未合 worktree"。**合并状态以 `git log main` 为准** |
| mask 重绘是通用能力 | ⚠️ `editDesignImage` 无 `model` 参数、写死 DashScope key（line 168/179）；`annotEdit` cap 仅 `gpt-image-2` 声明（`visualModels.ts:19`）。自定义模型第一刀**只能补文生图，不自然继承 mask/expand/region-lock** |

---

## 借鉴清单（按功能模块 / 功能点）

判断口径：是否服务"人直接操作画布迭代设计产物"这条主线 × ROI × 与 Neo 真实技术栈契合度 × 风险。

### 模块一 · 画布工作区

| 功能点 | Neo 现状（文件锚点） | 判断 | 成本 | 说明 |
|---|---|---|---|---|
| 无限画布 pan/zoom/fit | ✅ `DesignCanvas.tsx`（konva, SCALE 0.1–5） | **不借鉴** | — | 已实现，避开 tldraw $6k/年 |
| 图像/视频节点模型 | ✅ `designCanvasTypes.ts`（CanvasImageNode/VideoNode） | **不借鉴** | — | 已实现 |
| **节点连线 / freeform 图解** | ❌ 仅 `image`/`video` 两种节点（`designCanvasTypes.ts:41/49`），无边/连线/形状/文本节点 | ✅ **借鉴** | 中-高 | 设计过程要梳理用户流/IA/流程图。加 connector/edge + text/shape 节点 + 文本转 mermaid（Alma 内置 mermaid）。**是 Agent 操作画布的前置** |
| **undo/redo** | ❌ 无（自标 baseline gap） | ✅ **补刚需** | 中 | 人主导直接操作的 table-stakes，定位决定的高优先 |

### 模块二 · 生图模型（核心借鉴）

| 功能点 | Neo 现状 | 判断 | 成本 | 说明 |
|---|---|---|---|---|
| 内置多模型切换 | ✅ `visualModels.ts` 写死 4 个 + `ImageModelPicker.tsx` | **不借鉴** | — | 已有 |
| **自定义模型端点（OpenAI 兼容 baseURL/key）** | ❌ `IMAGE_MODELS` 编译期 const，用户加不了；`customBaseUrl` 只在聊天侧 onboarding | ✅ **借鉴（第一刀只做 t2i）** | 中偏高 | yetone 推文被点赞点；设计工具用户要接自己的中转/私有模型。**人主导工具该让用户掌控动力源** |
| 模型能力声明/探测 | ⚠️ cap 写死（`annotEdit` 仅 gpt-image-2） | ✅ **借鉴（配套）** | 中 | 自定义模型必须声明/探测能力，否则给"看着能用实际报错"的入口 |

### 模块三 · 标注重绘

| 功能点 | Neo 现状 | 判断 | 说明 |
|---|---|---|---|
| 圈选标注 4 工具 + mask 生成 | ✅ `AnnotationLayer.tsx` + `designCanvasMask.ts` | **不借鉴** | 已有，比 Alma 更细 |
| 局部 inpaint 重绘 | ✅ `editDesignImage`（IPC，写死 DashScope） | **不借鉴** | 已有 |

### 模块四 · 一致性保真（Neo 差异化优势）

| 功能点 | Neo 现状 | 判断 | 说明 |
|---|---|---|---|
| region-lock keep 区像素保护 + diff 证据图 | ✅ 独有，Alma 无对等 | **不借鉴（是优势）** | "人圈选 + 框外精确保真"恰是设计工具刚需；Alma 整图概率漂移是软肋 |
| region-lock 是 best-effort | sharp 不可用/gate 抛错降级写原图 | **自补强** | 升级为可选硬保证（低-中成本） |

### 模块五 · 版本 / 变体

| 功能点 | Neo 现状 | 判断 | 说明 |
|---|---|---|---|
| 非破坏式 variant spine | ✅ `variantSpine.ts` | **不借鉴** | 已有，比 Alma 完整 |
| 并排 A/B 对比 | ✅ `VariantCompareView.tsx` | **不借鉴** | 已有 |

### 模块六 · 成本透明

| 功能点 | Neo 现状 | 判断 | 说明 |
|---|---|---|---|
| 出图前预估 + 出图后 costCny | ✅ `pricing.ts` + `imageCost.ts` | **不借鉴** | 已有 |
| 扩图/去水印成本未覆盖 | ⚠️ 只回 `{path}` | **自补全** | 补自己的坑（低成本） |

### 模块七 · 记忆 / Agent / 聊天

| 功能点 | Neo 现状 | 判断 | 成本 | 说明 |
|---|---|---|---|---|
| **统一设计偏好记忆** | ❌ 品牌契约存得 ad-hoc：每品牌一个 `<designDir>/brands/<id>/brand.json` + `brandRegistry.ts` 4 action（`designFiles.ts:297-338`），只为"品牌"做的孤岛持久化 | ✅ **借鉴（抽象）** | 中-高 | 上一层统一记忆抽象（记品牌/风格/偏好/历史 + recall 注入 prompt），品牌契约降为 typed entry。**借抽象不借 Alma 的"对话记忆"用法** |
| **Agent 自主操作画布** | ❌ 设计出图 renderer 直连、"不经 agent"（`workspace.ipc.ts:66`），agent 看不见画布 | ✅ **借鉴（人审批前提）** | 高 | 画布状态序列化进 agent 上下文 + 画布工具（读状态/提议/应用 op），**人审批后落地**守住"人主导"。依赖①节点/边模型 |
| 对话式迭代（对选中节点说人话改） | ⚠️ 走结构化 design brief（question-form + 方向卡），非开放聊天 | 并入 Agent 操作画布 | — | — |
| 聊天即主入口 | — | ❌ **不借鉴** | — | 通用助手品类，硬抄即品类漂移 |

---

## PM 三档分类

### ✅ 值得借鉴（动 Alma 的，4 件）
1. 模块二 · 自定义生图模型端点（先 t2i）+ 能力声明
2. 模块一 · 节点连线 / freeform 图解
3. 模块七 · 统一设计偏好记忆（品牌契约降为 entry）
4. 模块七 · Agent 操作画布（人审批）

### ✅ 自补强（非借鉴 Alma，但定位要求做，3 件）
5. 模块一 · undo/redo（设计工具刚需）
6. 模块四 · region-lock 升可选硬保证
7. 模块六 · 扩图/去水印成本补全

### ❌ 不借鉴
- 画布/标注/版本三大模块：Neo 已有且更细
- 一致性保真：Neo 差异化优势，别往回抄
- 聊天即主入口：通用助手品类，品类漂移

---

## 落地顺序（带依赖）

```
地基层(独立，可并行):
  ① 自定义生图模型端点(t2i)        —— 独立
  ④ 统一设计偏好记忆抽象            —— 独立
  ⑤ undo/redo                      —— 独立，越早越稳(②前做)
  ⑥ region-lock 硬保证 / ⑦ 成本补全 —— 独立小修

画布扩展层:
  ② 节点连线/freeform 图解          —— ②是③的前置(agent 要序列化完整节点/边模型)

智能层:
  ③ Agent 操作画布(人审批)          —— 吃 ②的节点模型 + ④的记忆 + ⑤的 undo 兜底
```

**建议**：先并行做 ①④⑤；再 ②；最后 ③。

---

## codex 对抗评审 findings（11 条，已并入上文判断）

1. region-lock 是 best-effort 非强保真（line 200/220 降级 fallback）
2. 成本透明未覆盖扩图/去水印（line 232/276 只回 path）
3. variant 版本在主进程文件无落地证据（靠 renderer 侧文件证明）
4. mask inpaint 固定 DashScope/Wanx，`editDesignImage` 无 model 参（line 168/179）
5. 标注重绘 `annotEdit` cap 仅 gpt-image-2 声明（`visualModels.ts:19`，line 131 cap 拦截）
6. agent 自主操作画布是 Alma 真正可能领先点（Neo 设计生成"不经 agent"，line 66）
7. undo/redo、节点连线、记忆系统 Neo 未覆盖，但也无 Alma 领先硬证（line 1145 switch 无对应 action）
8. 复用聊天 customBaseUrl 会卡视觉侧静态类型/路由（`ImageEngineId`/`IMAGE_MODELS` 静态枚举，无 baseURL/key 透传，line 100）
9. 聊天 onboarding 靠 `/models` 发现 + `test_connection`，图像端点未必照样暴露，视觉侧需自做模型发现/能力声明（`ModelOnboardingModal.tsx:88/115`）
10. **SSRF 守卫证据不成立**：`workspace.ipc.ts` 无 `validateImageUrl` 命中，有裸 `fetch(payload.url)`（line 622）；自定义视觉端点要补 baseURL 校验 + 图片下载校验 + 内网拦截
11. 可用性判断绑死 provider 枚举（`providerKeyConfigured` 仅认 5 个 provider，line 925；`listVisualImageModels` 只回静态注册表，line 936）；加任意端点要补配置存储/key 获取/available 判断/成本估算

**codex 修订结论**：自定义生图模型值得做，但第一刀只做 custom t2i；mask edit/expand/annotEdit/region-lock 继续绑已知 provider，等自定义模型有明确 capability 配置 + 安全下载守卫后再开放。

---

## 源索引

**Alma 取证**
- 应用包：`/Applications/Alma.app/Contents/Resources/app.asar`（Electron + Squirrel 自动更新，bundle `com.yetone.alma`）
- 版本：`0.0.836`（`Info.plist` CFBundleShortVersionString）；`~/Library/Caches/alma-updater/pending/update-info.json` 待装包同号 = 已最新
- 关键命中：`addImageModel` / `ModelForm`(178) / `OpenAICompatible`(581) / `baseURL`(1263) / `customProvider`(71) / `Annotation`(13000+) / `MaskImage` / `inpaint` / `addNode`·`createNode`·`imageNode` / `ImageModelConfig`·`ImageModelProvider`
- 文档站：`https://alma.now/docs/`（含 features/memory、settings/memory）

**Neo 对照（code-agent/src）**
- 画布：`renderer/components/design/DesignCanvas.tsx`、`designCanvasTypes.ts`、`designCanvasStore.ts`、`designCanvasPersistence.ts`
- 模型注册表：`shared/constants/visualModels.ts`（`IMAGE_MODELS`）、`renderer/components/design/ImageModelPicker.tsx`、`main/services/media/imageGenerationService.ts`
- 标注/mask：`renderer/components/design/AnnotationLayer.tsx`、`designCanvasMask.ts`、`useDesignCanvasGeneration.ts`、`main/ipc/workspace.ipc.ts`（`editDesignImage`）
- 一致性：`shared/contract/imageConsistency.ts`、`main/services/media/imageConsistency.ts`
- 版本：`renderer/components/design/variantSpine.ts`、`VariantCompareView.tsx`、`DesignVersionUI.tsx`
- 成本：`shared/constants/pricing.ts`、`shared/media/imageCost.ts`、`DesignCostHistory.tsx`
- 品牌契约：`renderer/components/design/designFiles.ts`（`saveBrand`/`brand.json`）、`main/services/design/brandRegistry.ts`、`BrandManager.tsx`
- 自定义端点既有模式：`renderer/components/onboarding/ModelOnboardingModal.tsx`（`customBaseUrl`，聊天侧）
