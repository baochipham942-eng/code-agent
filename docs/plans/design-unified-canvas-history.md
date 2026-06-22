# 设计模式：统一画布 + 统一版本历史

> 状态：实施中（2026-06-22 起）
> 分支：`feat/design-unified-canvas-history`（基于 `feat/design-tab-restructure`）
> 缘起：林晨提问「设计历史在哪看 / 能否生成前在预览区贴图」→ 两个痛点同源（交互分裂、底层已统一）

## 背景与决策

### 现状两个痛点
1. **历史交互分裂**：图像/视频走左侧 `DesignCostHistory`，原型走预览区 `VersionControl` + `VersionComparePicker`，slides（tabreplan 新增）无统一历史。
2. **生成前不能贴参考图**：贴图能力（粘贴/拖拽/按钮）只在画布态可见；生成前预览区是空态；「参考截图」模式只置 flag 无 UI。

### 关键事实（已读码确认）
- `variantSpine.ts` 已是完备的非破坏性版本模型（appendVariant/pin/discard/restore），canvas 与 proto 共用 `Variant` 抽象。
- `variantAdapters.ts` 已有 `canvasNodeToVariant` / `makeProtoVariant`。
- **canvas 的 pin/discard 已落盘**——内联在 `canvas.json` 节点的 `chosen`/`discarded` 字段（非独立 spine.json）。proto 用独立 `spine.json` + `versions/` 快照。两者都已持久化，只是形态不同。

### 林晨两个拍板
- 参考图语义：**同时落画布节点**（不是纯 brief 参考）。
- 范围：**含 P3 全套对称化**。

### 收敛后的核心思想
设计模式收敛为**一个真源：带角色标记的 spine 节点树**。`CanvasNode.role` 区分 `reference`（生成前贴入，喂模型用，不进版本序号）与 `output`（生成/编辑产物，进版本时间线、可对比定稿、带 costCny）。

## 分期

### P0 地基
- `CanvasNodeBase` 加 `role?: 'reference' | 'output'`（缺省 = output，兼容老数据，紧凑落盘：仅 reference 落字段）。
- `normalizeBase` 校验 role；序列化往返。
- `Variant` 加 `role?`；`canvasNodeToVariant` 透传。
- 抽公共「版本时间线」展示组件（从 `DesignCostHistory` 提取纯展示部分）。
- `useDesignCanvasImport` 提取可复用核心，支持标记 role。

### P1 参考图落画布
- `PreviewPane` 生成前从空态改为渲染画布（可贴参考图）。
- 粘贴/拖拽/按钮导入 = `role:reference` 节点。
- 生成 IPC 收集 `role:reference` 节点多图打包传模型（受模型多图上限约束，超限取前 N 张并提示）。
- i18n zh/en 对齐。

### P2 统一历史
- 新增 `DesignHistoryPanel` 统一容器，按 `outputType` 分发数据源、渲染同一套版本时间线。
- 参考图与产物分组（参考图不进版本序号，单独「参考」分组）。
- 复用 `VariantCompareView` 对比定稿；覆盖 slides 媒介。
- 重构 `DesignCostHistory` / `DesignVersionUI` 收口。

### P3 对称化 + 验收
- 统一历史面板对 canvas 内联字段 与 proto 独立 spine.json 两种持久化形态都能正确读写回滚。
- codex-audit / multi-review 对抗审计修 HIGH/MED。
- 真 key dogfood（付费默认只跑一次，显式确认后才烧钱）。

## 触碰文件
| 文件 | 性质 |
|---|---|
| `designCanvasTypes.ts` | 加 `role` 字段 + 校验 |
| `variantSpine.ts` / `variantAdapters.ts` | `Variant` 加 `role` + 透传 |
| `useDesignCanvasImport.ts` | 提取核心 + 标记 role |
| `DesignWorkspace.tsx` | PreviewPane 生成前渲染画布；历史面板收口 |
| 生成 IPC handler | 收集 reference 节点多图喂模型 |
| `DesignCostHistory.tsx` / `DesignVersionUI.tsx` | 合入 `DesignHistoryPanel` |
| `DesignHistoryPanel.tsx`（新增） | 统一容器 |
| `variantHistory.ts` / `VariantCompareView.tsx` | 零改动（已通用）|

## 我先替林晨定的细节
1. 参考图不进版本时间线序号——它是输入不是产物，单独「参考」分组展示。
2. 生成时多图打包：reference 节点全部传模型，超模型上限按贴入顺序取前 N 张并提示。

## 验收
- 各阶段 TDD 绿 + `npm run typecheck` 净。
- UI 改动走 E2E/视觉验证。
- P3 对抗审计 0 HIGH。
- 汇报质量证据（测试数/覆盖/结论），不贴 diff。
