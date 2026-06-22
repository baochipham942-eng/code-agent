# Kun「设计」tab 借鉴清单（对照 Neo / code-agent）

> **来源**：Kun（= DeepSeek-GUI，GitHub `KunAgent/Kun`，作者 XingYu-Zhong / @zhongxingyuyes，Electron 34 + React 19，PolyForm Noncommercial）+ 官方 README/官网 + 源码 clone 复核 + Neo 源码三路并行 Explore
> **调研方式**：firecrawl 定位 → GitHub README/官网 → 源码 clone（`/tmp/Kun-probe`）grep as-built → Neo 三路并行 Explore（模型层 / 工具+hook / 渲染层）→ 主控复核
> **生成日期**：2026-06-20
> **范围**：聚焦 Kun 顶部「设计」tab（Code / 写作 / 设计 三 tab 之一），即"需求先行"流程里的设计稿 / 信息图 / 交互原型生成
> **方法纪律**：去魅分 shipped/planned/noop · 每条带文件锚点 · Neo 侧 as-built 复核 · 成本/优先级显式标注

---

## 0. 一句话看穿（去魅）

> **Kun 的「设计」tab = 把"图像生成 + Agent 写 HTML + 反 AI 痕迹自检"包成一个面向用户的设计工作流。它不是新引擎，是已有能力的产品化封装。** 对 Neo 的真正价值不是"抄一个设计 tab"，而是**抄那个"设计质量自检 hook"机制**——其余 75–85% Neo 已具备。

去魅点：
- ❌ **「设计 tab」≠ 高深技术**：交互原型就是 Agent 用 `write`/`edit` 写单文件 HTML；静态设计稿/信息图就是调图像生成模型出图。两条路 Neo 都有现成基建。
- ✅ **设计质量自检 hook 是真亮点**：PostToolUse 钩子，Agent 写完前端文件后正则扫"AI 痕迹"（紫蓝渐变/米色底/弹跳缓动/彩底灰字…），把发现回注进工具结果让模型**下一轮自我修正**——无独立 review pass、不打断、advisory。算法自承借鉴开源 `impeccable`（Apache-2.0），用 Kun 自己的命名+中文重写。
- ✅ **文件态 artifact（非 ephemeral）**：原型落盘成真实文件（`.kunsdd/.../prototype-*.html`），编辑器预插占位符 + 轮询路径 → 内容就位再渲染。比"内存流式 artifact 渲染管线"省事，且能进 Git/被后续编码阶段接着改。

---

## 1. Kun「设计」tab 三能力拆解（as-built）

| 能力 | Kun 实现（源码锚点）| 用什么 |
|------|------|------|
| **交互 HTML 原型** | `src/renderer/src/sdd/sdd-prototype-prompt.ts` — 硬约束：单文件 raw HTML、`</html>` 收尾、**增量写入每次工具 payload < ~4000 字符防截断**、预留路径 | 文本/代码模型 + `write`/`edit` 文件工具 |
| **静态设计稿 / 信息图** | `src/main/services/write-infographic-service.ts` — `WRITE_DESIGN_DRAFT_DEFAULT_PROMPT` / `WRITE_INFOGRAPHIC_DEFAULT_PROMPT`，按 `WriteInfographicKind` 分流 | 图像生成模型（GPT Image / Gemini；Kun 设置页自承国产图像模型设计稿场景"还不够稳"） |
| **截图→复刻**（vision 输入） | prototype prompt 的 `mode: 'image'` 分支，把设计图当视觉规格喂入 | vision 模型 |
| **设计上下文注入** | `src/renderer/src/sdd/sdd-design-context.ts` — Surface(Brand-led/Product-led) + 品牌色锚点 + 语气 chips（编辑风/极简/科技感…），显式禁 AI 默认审美 | prompt 拼装 |
| **反 AI 痕迹自检 hook** ⭐ | `kun/src/hooks/builtins/design-quality-hook.ts`（PostToolUse）+ `kun/src/quality/rules.ts`（规则注册表，16 条） | 源码正则（无 DOM），命中→回注 `design_quality_review` 块 |

**Kun 的设计质量规则全集（rules.ts，16 条）**：
- slop 类（AI 痕迹）7 条：`slop-purple-blue-gradient` 紫→蓝渐变 / `slop-bounce-elastic-easing` 弹跳橡皮筋缓动 / `slop-cream-default-bg` 米沙纸色底 / `slop-side-tab-border` 侧边强调条 / `slop-gradient-text` 渐变文字 / `slop-gray-text-on-color` 彩底灰字 / `slop-dark-colored-glow` 彩色辉光
- quality 类（品味）9 条：被滥用字体 / Display 字号上限 / 字距下限 / 正文行宽 / 魔法 z-index / 标题跳级 / 缺 reduced-motion / 字体偏离设计语境

---

## 2. Neo 现状对照（as-built 复核，三路 Explore）

| Kun 能力 | Neo 现状（文件锚点）| 裁决 |
|------|------|------|
| 交互 HTML 原型 | ✅ `tools/modules/file/write.ts`（写单文件）+ `renderer/components/PreviewPanel.tsx` / `LivePreview/LivePreviewFrame.tsx`（iframe 渲染 HTML）+ `WorkspacePreviewPanel.tsx`（生成物展示 + 修订历史）| **基建齐全**，只差"预留路径+占位符轮询"编排 |
| 静态设计稿 / 信息图 | ✅ `main/services/media/imageGenerationService.ts`（CogView+FLUX 双引擎 + `determineImageEngine()`）+ `plugins/builtin/imageCreation/imageGenerate.ts`（工具 + 中英 prompt 扩写）| **现成可用**，只差接到设计入口 |
| 截图→复刻（vision） | ✅ `main/model/modelRouter.ts:inferenceWithVision()` + `modelCapabilities.ts:findCapableModels('vision')` + `shared/contract/model.ts`（`supportsVision`/`visionCapabilities`）| 现成，只差入口 |
| 设计上下文注入 | ❌ 无 | prompt 拼装，轻量新增 |
| **反 AI 痕迹自检 hook** ⭐ | ⚠️ PostToolUse hook **触发点已在** `agent/runtime/toolExecutionEngine.ts:886-904`（`hookManager.triggerPostToolUse` → `injectSystemMessage('<post-tool-hook>...')`）；**缺检测规则** | **真缺口**，但只缺"规则注册表"，回注机制现成 |

**一条关键纠偏**：Explore 子 Agent 一度判断"Neo 的 PostToolUse 只能注入系统消息、不能改 ToolResult，需大改（新增 `PostToolUseResult` 事件改结构）"——**多虑了**。Kun 的机制本就是"折一个 review 块进结果让模型下一轮看到并自我修正"，Neo 现成的 `injectSystemMessage` 效果完全等价。**无需改 ToolResult 结构**，真正要做的只有检测规则本身。

---

## 3. 三档借鉴分类

### ✅ 值得借鉴（高 ROI + 地基已具备 + 低风险）

| # | 借鉴点 | Neo 现状（锚点）| 动作 | 成本 |
|---|--------|------|------|------|
| ⭐1 | **设计质量自检 builtin hook**（最该自研的亮点）| PostToolUse 触发点 `toolExecutionEngine.ts:886` + `injectSystemMessage` 回注**现成**；缺检测规则 | 新建 `main/quality/` 规则注册表（借 impeccable 算法，源码正则）+ 封装 builtin PostToolUse hook | 中 |
| 2 | **交互原型 prompt 编排**（防截断硬约束）| `write` 工具 + 预览基建现成；缺 prompt 编排 + 路径轮询 | 新建 prototype prompt（单文件/raw/`</html>`/增量 payload<4000/预留路径）+ 预览轮询 | 低-中 |
| 3 | **设计上下文（品牌色/语气/Surface）注入** | 无 | prompt 拼装 + UI 表单（Brand-led/Product-led + 品牌色 + 语气 chips）| 低 |

> ⭐ **第 1 条是本轮最高价值**：与 Neo "三闸验证 / 硬门代码化 / 质量约束代码化"一贯哲学同源（同 Kimi 借鉴的 `ToolArgsRepairGate`、Maka/Lody 的 design quality 一脉）。打的是"AI 生成前端一眼假"的真实痛点，成本却不高（检测纯正则、回注机制现成）。

### 🟡 待讨论（成本/选型/架构级）

| # | 借鉴点 | 判断 |
|---|--------|------|
| 4 | **静态设计稿 / 信息图出图** | 基建现成（CogView/FLUX），但出图是**按次付费**、且 Kun 自承国产图像模型设计稿场景质量不够稳。**用户已拍板：用国产 CogView/FLUX，成本优先**——只配 key，几乎零代码 |
| 5 | **顶层 Code/设计 导航** | Neo 当前是单一聊天工作区（`App.tsx:700` 三列），无顶层 tab。**用户已拍板：做顶层 Code/设计 两 tab（暂不做写作）**——是中等重构，碰核心布局 + 会话上下文，P3 须回归现有 Code 流程 |

### ❌ 不学 / 已具备

| # | 维度 | 为何不学 |
|---|------|---------|
| 6 | 文件态 artifact 渲染 | Neo `PreviewPanel`/`LivePreviewFrame` 已是文件态 + iframe 渲染，比 Kun 不缺 |
| 7 | 图像生成引擎 | `imageGenerationService` 双引擎 + 中英 prompt 扩写已 ship |
| 8 | vision 输入 | `inferenceWithVision` + 能力发现已 ship |
| 9 | 需求先行 SDD 全流程 | Kun 的设计 tab 强绑 SDD（需求→设计→计划→编码）这套产品范式；Neo 不是这范式，不整体搬 |

---

## 4. 决策记录（用户 2026-06-20 拍板）

| 决策点 | 选择 | 影响 |
|--------|------|------|
| 设计 tab 落位 | **顶层 Code / 设计 两 tab**（暂不做写作）| P3 中等重构，碰 `App.tsx` 核心布局 + 会话上下文 |
| 视觉模型 | **国产图像模型 CogView/FLUX**（成本优先）| 配置≈零代码：`ModelSettings.tsx` 填 `apikey.zhipu`/`apikey.openrouter`；`cogview-3-flash` 已注册于 `providerRegistryBase.ts:477`，可选补注册 `cogview-4` |

> ⚠️ 成本提醒：图像生成/vision 输入均为按次付费 API，图像生成尤其贵。CogView/FLUX 走国内端点免代理（智谱/OpenRouter，见 security.md 代理矩阵）。

---

## 5. 落地分期

| 阶段 | 做什么 | 关键文件 | 成本 |
|------|------|------|------|
| **P0 交互原型** | prototype prompt 编排（防截断硬约束 + 预留路径 + design-context）；复用 `write` + `PreviewPanel` 轮询渲染。**不碰视觉模型即可演示设计 tab 核心、零图像 API 成本** | `tools/modules/file/write.ts`、`PreviewPanel.tsx`、新建 prototype prompt | 1-2 天 |
| **P1 接图像生成** | 设计入口加产物类型（原型/设计稿/信息图）；出图调现成 `image_generate`（CogView/FLUX）→ 预览 `<img>` 渲染；配 key | `imageGenerationService.ts`、`imageGenerate.ts`、`ModelSettings.tsx` | 1-2 天 |
| **P2 设计质量自检 hook** ⭐ | 新建 `main/quality/` 规则注册表（16 条，源码正则）+ builtin PostToolUse hook，挂 `toolExecutionEngine.ts:886`，复用 `injectSystemMessage` 回注 | 新建 `main/quality/*`、hook 注册 | 2-3 天 |
| **P3 顶层 Code/设计 导航** | `appStore.ts` 加 `topMode: 'code'\|'design'`（或复用 `modeStore.ts`）；`App.tsx` 外层包顶部导航；`code`=现有三列原样，`design`=新 `DesignWorkspace`（左草稿/中 composer/右预览）；i18n + **回归现有 Code 流程** | `appStore.ts`、`App.tsx`、`i18n/{zh,en}.ts`、新建 `features/design/` | 2-3 天 |

**整体 ~6-10 天。** Agent 循环、ModelRouter、工具、预览全复用，新增逻辑进独立模块（`quality/`、`features/design/`），不堆进 `App.tsx`/`databaseService` god file。

**落地顺序（本轮执行）**：任务 1 本清单 → P2 设计质量 hook（最独立、最像亮点、不依赖 UI 重构）→ P0 交互原型 → P1/P3 后续。

### 依赖与护栏
- **P2 影子模式起步**：检测器先"只报告不拦截"，默认开但 advisory，量误杀率后再调严格档（沿用 ToolArgsRepairGate 影子起步纪律）。
- **P2 严格度分档**：宽松（只报最确定 AI 痕迹）/ 标准（+ 通用品味）/ 严格（+ 启发式，偶误报）——对齐 Kun 设置页的三档设计。
- **禁硬编码**：颜色阈值/规则常量等若需复用，进 `shared/constants.ts`（遵 typescript.md）。
- **P3 回归**：顶层导航改 `App.tsx` 后必跑现有 Code 全流程 + 会话切换 E2E，防回退。

---

## 6. 源索引

**Kun 侧**（clone `/tmp/Kun-probe`，master @ `8602476`）：
- 原型 prompt：`src/renderer/src/sdd/sdd-prototype-prompt.ts` · 设计上下文：`src/renderer/src/sdd/sdd-design-context.ts`
- 设计质量：`kun/src/hooks/builtins/design-quality-hook.ts` · `kun/src/quality/rules.ts`（16 规则）· `kun/src/quality/color.ts`
- 出图服务：`src/main/services/write-infographic-service.ts`
- 官网 `deepseek-gui.com` · README `github.com/KunAgent/Kun`

**Neo 侧（as-built 锚点）**：
- 模型层：`src/main/model/modelRouter.ts`(inferenceWithVision) · `modelCapabilities.ts`(findCapableModels) · `providerRegistryBase.ts:477`(cogview-3-flash)
- 图像生成：`src/main/services/media/imageGenerationService.ts` · `plugins/builtin/imageCreation/imageGenerate.ts`
- 工具/hook：`src/main/tools/modules/file/write.ts` · `agent/runtime/toolExecutionEngine.ts:886-904`(PostToolUse 触发点) · `hooks/hookManager.ts:189`(triggerPostToolUse)
- 渲染层：`renderer/App.tsx:700`(三列布局) · `components/PreviewPanel.tsx` · `LivePreview/LivePreviewFrame.tsx` · `WorkspacePreviewPanel.tsx` · `stores/appStore.ts`(WorkbenchTabId) · `i18n/zh.ts`
