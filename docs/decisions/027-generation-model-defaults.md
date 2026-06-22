# ADR-027: 生成模型（图像/视频）默认值用户配置（设置页 IA 重构 · 方向 A 阶段 3）

- **状态**: 已采纳（2026-06-22，随设置页模型 IA 重构方向 A 拍板）
- **日期**: 2026-06-22
- **关联**: `docs/plans/2026-06-22-settings-model-ia-redesign.md`；ADR-026（搜索源配置）

## 背景

设置页 IA 重构要在新「模型与能力」分组下提供「生成模型」配置（把生图/视频模型与
通用任务模型在设置页拆开）。调研发现生成模型系统**已基本建好**：

- `src/shared/constants/visualModels.ts` 有 `IMAGE_MODELS` / `VIDEO_MODELS` 能力注册表
  （即所需的 capability registry），含 caps / provider / engine。
- 设计画布已有 `ImageModelPicker` / `VideoModelPicker`，选择持久化在 `designStore`
  （zustand persist → localStorage），经 IPC `listVisualImageModels` / `listVisualVideoModels`
  查 provider key 可用性灰显。

**真缺口**：模型选择只活在设计画布的 localStorage 里——**设置页无入口、不可发现、
无"跨会话默认"语义**。林晨的"为什么没把生图模型和通用任务模型拆开"实为"设置页缺
生成模型入口"。

> `DESIGN_IMAGE_MODELS.edit`（局部重绘 `wanx2.1-imageedit`）与 `DESIGN_FLUX_MODEL`
> 是引擎内绝对子模型 id，属更深的引擎细节，本 ADR **不**抽（保留为常量默认），仅做
> 顶层"默认文生图模型 / 默认视频模型"的用户可配置。

## 决策

### D1 — 新增 `AppSettings.design` 顶层字段（默认 undefined = 零行为变更）

```ts
// AppSettings
design?: {
  /** 默认图像生成模型 id（须为 visualModels.IMAGE_MODELS 中的 id） */
  defaultImageModelId?: string;
  /** 默认视频生成模型 id（须为 visualModels.VIDEO_MODELS 中的 id） */
  defaultVideoModelId?: string;
};
```

未配置时一切照旧（designStore 仍用 `defaultImageModelId()`/`defaultVideoModelId()` =
registry 首项）。**无迁移、无回归**。

### D2 — 优先级：画布显式选 > 设置默认 > registry 默认

`designStore` 增 `imageModelUserPicked` / `videoModelUserPicked` 标志（持久化）：
- 画布 picker 的 `setImageModel`/`setVideoModel` 置标志 = true（用户显式选）。
- 新增 `applyDefaultModels({ image?, video? })`：**仅当对应标志为 false** 时套用——
  即用户从没在画布手动选过，才用设置页默认覆盖。
- 设计画布挂载时 fetch `AppSettings.design` → `applyDefaultModels`。

这样三层优先级无歧义：画布里手动选过的用户不被设置默认打扰；没选过的用户开画布即
看到设置页配的默认；都没配则 registry 首项。

### D3 — UI 数据通路：复用现有 IPC

`ImageVideoSettings` 面板：
- `listVisualImageModels` / `listVisualVideoModels`（workspace 域，现成）→ 拿模型 +
  caps + provider + 可用性（key 是否配）。
- `SETTINGS.get` 读当前 `design` 默认；`SETTINGS.set { settings: { design } }` 保存。

模型列表唯一真源仍是 `visualModels.ts`，设置面板只读不重复定义。

## 一致性 / 安全 / 成本

- 禁硬编码：模型 id 全来自 `visualModels.ts` 注册表，价格仍在 pricing.ts；面板不引入新字面量。
- 付费提示：生成模型多为付费（wanx/海螺/gpt-image 等），面板标注「按 provider 计费」。
- 向后兼容：`design` 全可选；designStore 新标志默认 false，老 localStorage 无此键 = false，
  因 `AppSettings.design` 初始为空故 `applyDefaultModels` 为 no-op，老用户零感知。

## 后果

- 用户在设置页获得可发现的"默认生成模型"入口，与通用任务模型在 IA 上拆开。
- 不解决：局部重绘 / flux 等引擎内绝对子模型的可配置（保留常量）；画布 picker 仍是
  per-session 覆盖（符合预期）。
