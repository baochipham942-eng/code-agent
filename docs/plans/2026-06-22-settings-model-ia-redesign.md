# 设置页「模型」信息架构重构计划

> 创建日期：2026-06-22
> 分支：`feat/settings-model-ia`（worktree `code-agent-modelpage`）
> 状态：方向 A 全量**已实现**（2026-06-22，分支 feat/settings-model-ia 四个 commit，未推 origin/未合 main，待视觉 dogfood + 拍板合并）

## 实现进度（2026-06-22）

| 阶段 | 内容 | 状态 | commit |
|------|------|------|--------|
| 1 | tab 分组迁移（立「模型与能力」组）+ 去预算告警 tab | ✅ | 911275d04 |
| 2 | 搜索源多选+优先级（ADR-026） | ✅ | 506bee8c7 |
| 3 | 生成模型默认值（ADR-027） | ✅ | 4b08c7241 |
| 4 | 对抗审查修复 + 执行引擎标题去重 | ✅ | f0e4271c4 |

- 对抗审查（独立 reviewer 当反方）：0 HIGH，修掉 M1（Level2 webSearch 漏传搜索偏好）+ L1（settingsIndex 缺新 tab 条目）。
- 验证：typecheck 净；settingsIndex/settingsModal 分组/网络搜索(139)/设计(179)/源偏好(4)/默认模型优先级(2) 全绿。
- 顺带修：执行引擎设置页标题+说明重复显示两遍（AgentEngineListSection 改用独立 listTitle/listDescription）。
- **待办**：视觉 dogfood（装包看新 IA + 各新面板渲染）；推 origin + 拍板合并 main。


## 已拍板决策（2026-06-22，林晨）

1. **走方向 A，全量**：① tab 分组迁移 + ② 搜索孤儿接通 + ③ 生成模型（图像/视频）一次到位。
2. **「对话」tab 整体并入「模型与能力」分组**（含路由模式与摘要模型，非模型项随之迁移）。
3. **搜索做多源**：暴露 Tavily / Perplexity / Exa / DeepSeek 多源选择 + 优先级，标注付费。
4. 我（Claude）自定的项：分组命名「模型与能力」，置于「基础偏好」**之前**（它是 AI 编程工具的核心配置）；tab 迁移不改各 tab 内部实现。
5. 生成模型可配置化策略：`pricing.ts` 常量保留为默认值（遵守禁硬编码规范），新增配置项覆盖；设计画布改为读配置、缺失时 fallback 到常量。
6. **去掉「预算告警」tab**：从设置页移除该 tab 入口。底层预算/成本逻辑去留待实现阶段核清引用后再定（成本告警可考虑并入模型成本概览，不在本计划强制）。
7. **下一个需林晨介入的节点 = ADR 签字**（两处 schema 改动）：`routing.search` 槽 + 生成模型配置项。其余实现由 Claude 自主推进 + 分层验证。

## 背景

线上最新版设置页存在三类问题，本计划聚焦其中与「模型」相关的部分：

1. **搜索 provider 是孤儿代码**——`modelRouter.ts:226` 把搜索硬编码成 `perplexity / sonar-pro`，`AppSettings.routing` 里没有 `search` 槽，任务策略也没有 search 档，UI 完全无入口。
2. **生图/视频模型完全游离在设置体系外**——`pricing.ts:38-91` 把 `wanx / flux / 海螺 t2v·i2v` 写死成常量，设计画布内置直读，绕过 `AppSettings` 路由，用户改不了。
3. **设置页 IA 没有「模型」归类层**——模型相关的四个 tab（对话路由 / 语音输入 / 模型 / 执行引擎）散落在「基础偏好」大杂烩里，被「快捷键」劈开，彼此无关联感；模型 tab 内部又因果倒置、两套选模型心智并排。

本计划梳理两个方向：
- **方向 A**：跨 tab 的设置页分组重构（立「模型与能力」分组）。
- **方向 B**：模型 tab 内部的信息架构与布局重排。

两者可独立推进，建议先 B（纯页内重排、风险低、立竿见影），再 A（涉及 schema 与跨 tab 迁移）。

---

## 现状事实（代码锚点）

### 设置页 tab 结构
- Tab 定义：`src/renderer/utils/settingsTabs.ts:12-41`（SETTINGS_TAB_IDS），`:73-102`（分组）
- 设置页主组件：`src/renderer/components/features/settings/SettingsModal.tsx:144-198`（buildSettingsTabGroups）

当前「基础偏好（basics）」分组顺序：
```
权限与安全 → 对话 → 语音输入 → 快捷键 → 模型 → 执行引擎 → 预算告警 → 外观 → 人格
              ▲模型相关   ▲模型相关   ✗无关    ▲模型相关  ▲模型相关
```
模型相关的「对话/语音/模型/执行引擎」被「快捷键」劈开，且与「外观/人格/预算」混在同一大组。

### 模型 tab 内部结构
`src/renderer/components/features/settings/tabs/ModelSettings.tsx:827-998`
```
模型 tab
├─ WebModeBanner
├─ ① 任务策略卡 (TaskStrategySettingsPanel, step "1")
│    ├─ 左：策略模式 + 默认档位 + 4 档(fast/main/deep/vision，每档 模型·Effort·MaxTokens)
│    └─ 右(260px)：Fallback 3 勾选 + 规则 N 勾选
└─ ② Master-Detail (grid 252px + 1fr)
     ├─ 左(252px)：ProviderListPanel（已配置 / 待添加）
     └─ 右：Header → ①连接(ProviderConnectionSection) → ②模型(ProviderModelsSection) → ③高级 → 保存
```
页面引导语（`:830`）：「先配置任务策略，再维护 Provider、模型和连接。」← 因果倒置的源头。

相关文件：
- 任务策略面板：`TaskStrategySettingsPanel.tsx`（PROFILE_META 在 `:16-21`，4 档定义 fast/main/deep/vision）
- Provider 详情各段：`ProviderDetailSections.tsx`（ProviderDetailCard）、`ProviderConnectionSection`、`ProviderModelsSection`、`ProviderAdvancedSection`
- 能力枚举：`src/shared/contract/model.ts:39`（含 `search`）
- 路由 schema：`src/shared/contract/settings.ts:98-112`（routing 只有 code/vision/fast/gui，**无 search**）
- 设计模型硬编码：`src/shared/constants/pricing.ts:38-64`（图像）、`:89-91`（视频）

---

## 方向 A：设置页跨 tab 分组重构

### A.1 目标 IA
立一个独立分组「模型与能力（models）」，把所有"哪个模型/引擎干哪件事"的配置收拢、排序贴近：

```
模型与能力(models)            ← 新分组，置于 basics 之前
  ├ 通用任务模型     ← 现 model tab
  ├ 对话             ← 现 conversation 迁入（路由模式 + 摘要模型）
  ├ 生成模型         ← 新增：图像/视频（填方向 A.4 的坑）
  ├ 搜索             ← 新增：补 routing.search（填孤儿代码）
  ├ 语音输入         ← 现 voiceInput 迁入
  └ 执行引擎         ← 现 agentEngine 迁入

基础偏好(basics)             ← 瘦身
  权限与安全 / 快捷键 / 外观 / 人格
  （「预算告警」tab 去掉；「对话」已上移到模型与能力）
```

### A.2 改动点
- `settingsTabs.ts`：新增 `models` 分组键，把 `model / voiceInput / agentEngine` 移入，新增 `imageVideo`（生成模型）、`search`（搜索）两个 tab id。
- `SettingsModal.tsx:buildSettingsTabGroups`：调整分组归属与顺序。
- i18n：分组标题与新 tab 标签走 i18n（zh/en 对齐，`en.ts` 同步加键）。
- 「对话」tab 去留：其路由模式与摘要模型偏向「会话行为」，建议留在基础偏好，但在「通用任务模型」页加一个指向它的入口链接，避免割裂。（待拍板）

### A.3 搜索 provider（填孤儿代码）
- schema：`AppSettings.models.routing` 增加 `search: { provider, model }` 槽；任务策略增加 `search`/`research` 档（可选，先做 routing 槽）。
- 路由：`modelRouter.ts:226` 的硬编码 `perplexity/sonar-pro` 改为读 `routing.search`，保留它作为 fallback 默认值（走 `PROVIDER_FALLBACK_CHAIN` 体系，遵守禁硬编码规范）。
- UI：新增「搜索」tab，暴露搜索源选择 + 多源（Tavily / Perplexity / Exa / DeepSeek）开关与优先级。
- ⚠️ 成本提示：搜索源多为付费 API，UI 需标注计费。

### A.4 生成模型（图像/视频）
- 把 `pricing.ts` 中 `DESIGN_IMAGE_MODELS / DESIGN_VIDEO_MODELS / DESIGN_FLUX_MODEL` 从硬编码常量抽成可配置项（仍保留常量做默认值，遵守禁硬编码规范）。
- 新增「生成模型」tab：图像生成模型 / 图像编辑模型 / 文生视频 / 图生视频 各一槽，列出已配置且支持对应能力的 provider。
- 与设计画布打通：画布读这里的配置而非直读常量。
- 范围注记：这块依赖较多（设计画布、计费表、能力矩阵），是方向 A 中最重的子项，可作为 A 的第二阶段单独排期。

### A.5 风险与边界
- 动 `AppSettings.routing` schema = 共享类型改动，属高风险，需多模型对抗审查（codex-audit / multi-review）。
- 迁移：老配置需向后兼容（无 search 槽时读 fallback 默认）。
- tab 迁移不改各 tab 内部实现，纯归属与顺序调整，风险低。

---

## 方向 B：模型 tab 内部布局重排（建议先做）

### B.1 三个核心病
1. **因果倒置**：页面让用户"先配任务策略"，但策略下拉依赖先接好 provider、配好 key、发现出模型。新用户首屏看到引用"还不存在的模型"的策略矩阵，满屏"当前模型不可用"。正确认知链 = 接入源 → 有模型 → 才能编排。
2. **两套"选模型"心智并排**：上半页（任务策略）按"任务维"选模型；下半页（Master-Detail）按"Provider 维"管模型。两块都处理"模型"却维度不同、平铺同页、互相依赖却不相连，用户不知道去哪改、改完跨区跳跃。
3. **任务策略卡信息过载 + 编号打架**：一张卡塞 策略模式 + 默认档位 + 4 档×3 列 + Fallback 3 勾 + 规则 N 勾；策略卡是 step "1"，详情卡内部又是 ①②③，两套编号同屏。Fallback/规则是 99% 用户不碰的高级项，却占显眼右栏。

### B.2 目标布局：翻成「因果纵向流」
按"米→锅→菜"自然顺序，加顶部状态条：
```
模型 tab
┌─ 概览条 ──────────────────────────────────
│ 默认模型: Kimi K2.5 · 已接入 3 源 · 本月 ¥X   [体检]
├─ 第一步 · 接入与模型 ────────────────────────
│ [Provider 列表]  [连接 → 模型 → 高级(折叠) → 保存]
│ ← 现 Master-Detail 原样上移（原料层）
├─ 第二步 · 任务编排 ──────────────────────────
│ 策略模式: ○自动按任务选  ○固定一个模型
│ ┌ 快速任务  → [模型▾]   (短问答/改写)
│ ┌ 主力任务  → [模型▾]   (代码/工具)    ← 默认只露"模型"列
│ ┌ 深度任务  → [模型▾]   (研究/重构)    Effort/MaxTokens 收进行内"高级"
│ └ 视觉任务  → [模型▾]   (看图/截图)
│ ▸ 降级与规则 (折叠，默认收起)
└──────────────────────────────────────────
```

### B.3 具体改动清单
| # | 改动 | 涉及文件 | 风险 |
|---|------|----------|------|
| B-1 | **顺序翻转**：Master-Detail（接入与模型）上移到任务策略之前；引导语改"先接入模型，再分配任务" | `ModelSettings.tsx:828-991`（调整 JSX 顺序 + 文案） | 低（纯顺序） |
| B-2 | **新增概览条**：默认模型 / 已接入源数 / 本月花费 / 体检入口 | `ModelSettings.tsx`（新增展示组件，读现有 state + 计费） | 低 |
| B-3 | **任务策略卡瘦身**：4 档默认只露"模型"列，Effort/MaxTokens 收进每行"⋯高级"行内展开 | `TaskStrategySettingsPanel.tsx:179-225` | 中（交互改动） |
| B-4 | **Fallback + 规则折叠**：从右侧 260px 栏挪进策略卡底部"▸ 降级与规则"折叠区，默认收起 | `TaskStrategySettingsPanel.tsx:232-295` | 低 |
| B-5 | **统一编号体系**：砍掉 step 编号，改"第一步/第二步"语义标题；详情卡内部 ①②③ 保留（属"单个 provider 配置步骤"，层级清楚） | `ModelSettings.tsx` + `TaskStrategySettingsPanel.tsx:114-116` | 低 |
| B-6 | **打通两套心智的跳转**："当前模型不可用"档位旁加「去启用」按钮，点击定位到上方对应 provider 模型列表并高亮 | `TaskStrategySettingsPanel.tsx:173-177` + ModelSettings 选中态联动 | 中（需跨组件联动 selectedProvider） |

### B.4 验证
- `npm run typecheck` 必过。
- 受影响：settings 相关单测。
- UI 走 E2E / 视觉验证（/e2e，独立 headless 截图，对比改前改后）。
- i18n：所有新文案 zh/en 对齐。

### B.5 风险与边界
- 纯前端 IA/布局重排，不动 schema、不动路由逻辑，风险低。
- B-6 需要让任务策略面板能触发外层 ModelSettings 的 provider 选中态，注意 props 回调而非状态穿透。

---

## 推进路线（方向 A 全量，已拍板）

按"低风险先行、schema 改动走 ADR"分四个阶段，每阶段 typecheck + 测试 + 截图验证后提交，不积攒：

- **阶段 1 · tab 分组迁移**（低风险，纯前端）
  - `settingsTabs.ts` 新增 `models` 分组键，置于 `basics` 之前；把 `model / conversation / voiceInput / agentEngine` 移入；新增 `imageVideo`(生成模型)、`search`(搜索) 两个 tab id（先占位空壳）。
  - 移除 `budget`（预算告警）tab 的入口注册。
  - `SettingsModal.tsx:buildSettingsTabGroups` 调整分组归属与顺序。
  - i18n：分组标题 + 新 tab 标签 zh/en 对齐（`en.ts` 同步加键）。

- **阶段 2 · 搜索多源（ADR-A1，动 routing schema）**
  - ADR：`AppSettings.models.routing` 增 `search` 槽 + 多源优先级结构。
  - `modelRouter.ts:226` 硬编码改读 `routing.search`，原值降为 fallback（走 `PROVIDER_FALLBACK_CHAIN`）。
  - 「搜索」tab：多源开关 + 优先级 + 付费标注。
  - 向后兼容：无 search 配置时读 fallback 默认。codex-audit 对抗审查。

- **阶段 3 · 生成模型（ADR-A2，动 pricing 常量 + 设计画布读取路径）**
  - ADR：生成模型配置项结构（图像生成/图像编辑/文生视频/图生视频各一槽）。
  - `pricing.ts` 的 `DESIGN_*` 常量保留为默认值，新增配置覆盖；设计画布改读配置、fallback 常量。
  - 「生成模型」tab：列出支持对应能力的已配置 provider。
  - 这是最重一环，依赖设计画布、计费表、能力矩阵。codex-audit 对抗审查。

- **阶段 4 · 收尾**：「通用任务模型」页内对话相关入口的衔接、整体 IA 截图回归、文档（ARCHITECTURE / model-config.md）更新。

> 注：方向 B（模型 tab 内部因果纵向流重排）保留在本文档作为后续可选项，本轮聚焦方向 A。

## 开放问题
全部已在「已拍板决策」中关闭。下一个需林晨介入的节点是阶段 2 / 阶段 3 的 ADR 签字。
