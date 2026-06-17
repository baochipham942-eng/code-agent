# 设计系统契约 + 采纳率收口 · 立项清单

> 来源：maka 借鉴清单 P2-4「design-system.md 当契约」 + 对 neo 实际 UI 状态的核查（2026-06-17）
> 定位修正：**不是"建组件库"，neo 已有成熟 primitives 层 + Linear 风 token 体系。本项治的是"无契约约束 + 采纳率缺口 + 边缘颜色漂移"。**

## 核查到的事实基线（2026-06-17）

- **token 体系：成熟。** `tailwind.config.js` Linear 风 CSS 变量，语义分层完整（bg void/deep/surface/elevated、text 5 级、brand、success/warning/error/info、border 4 级）。
- **primitives 层：已存在且广泛采纳。** `src/renderer/components/primitives/`：`Button / IconButton / Input / Modal / Select / Textarea / Toggle / UndoToast`，各被 39–48 个文件引用。
- **缺口 1（Button 长尾）**：全局 760 个原生 `<button>`，仅 40 文件走 `Button` primitive。
- **缺口 2（Modal 重复）**：21 处手搓 `fixed inset-0` 遮罩，未走 `Modal` primitive。
- **缺口 3（颜色漂移）**：81 处硬编码 hex / 16 文件，其中大头是数据可视化（图表/DAG/热力图/lab 教学图）→ 应**豁免并集中声明**；真漂移仅 ~15-20 处（MessageContent / AboutSettings / InAppValidationPanel / GenerativeUIBlock）→ 该迁 token。

## 价值定性（回答"面子还是一致性+效率"）

- **不是面子工程**：组件库是基础设施，价值=一致性+开发效率，已被现存 40-48 个采纳文件吃到。
- **团队效率论打折**：neo 是单人+AI 辅助，经典"多人免重复/降 onboarding"收益被稀释。
- **真正最高 ROI 的是"契约"而非"库本身"**：一份 machine-checkable 的 design-system 契约，本质是**约束 AI 产出 UI 一致性的护栏**——与事件账本、安全契约同属"治理"家族，也是更值钱的作品集叙事（"我连 AI 产出的 UI 都用契约管起来"）。

## 三条工作流（按 ROI 排序）

### W1 · 设计系统契约文档（立刻做，成本最低，叙事价值最高）
- 产出 `docs/designs/design-system.md`，内容：
  - 文档化已有 token 体系（CSS 变量清单 + 语义用途）
  - 文档化 8 个 primitives 的 API / 状态契约（loading/error/disabled 等态归属）
  - **硬规则**：新 UI 必须用 primitives，禁手搓原生 `<button>`/遮罩；颜色走 token；**数据可视化 palette 是唯一豁免，且必须集中在一个 `vizPalette.ts` 声明**；禁 `z-index:9999`、禁硬编码 cubic-bezier（用命名缓动）；`prefers-reduced-motion` 塌到 0.01ms。
  - **维护 gate**："任何 PR 破坏规则必须同 commit 更新本文档"（对 neo 即 AI 护栏）。
- 成本：约半天。不动代码，纯文档化现状 + 立规则。

### W2 · 机器护栏静态门（跟 W1 一起做，把契约变可执行）
- 接 maka P2-2「三个静态门」思路，纯 Node 源码 walk + 正则，零运行时成本，可进 CI：
  - 禁新增非豁免 hex（豁免靠 `// ds-allow:viz` 行内注释或 `vizPalette.ts` 白名单）
  - 禁新增 `fixed inset-0`（强制走 `Modal`）
  - 禁新增裸 `<button>`（强制走 `Button`/`IconButton`，语义豁免走注释）
- 成本：约半天。把 W1 的文档契约升级成 machine-enforceable，和 neo 治理叙事自洽。

### W3 · 采纳率收口（增量，排在事件账本之后，不阻塞）
- **颜色（先做，最干净）**：~15-20 处非 viz hex 迁 token；viz palette 集中到 `vizPalette.ts` 并在契约标豁免。
- **Modal（中等）**：21 处手搓遮罩逐个迁 `Modal` primitive。
- **Button（长尾，最后且不强求全迁）**：760 原生 `<button>` 中，交互性按钮迁 `Button`/`IconButton`；纯语义/特殊布局的按需保留。**不做 big-bang，按文件增量收，每次小 PR。**

## 优先级与排期建议

| 工作流 | 成本 | 时机 | 阻塞性 |
|--------|------|------|--------|
| W1 契约文档 | 半天 | 立刻 | 不阻塞 |
| W2 静态门 | 半天 | 跟 W1 同周期（同属治理，可与事件账本同窗口） | 不阻塞 |
| W3 收口 | 增量 | 事件账本之后，按文件分批 | 不阻塞 |

**反面教材守住**：不学 maka 的 `packages/ui/src/components.tsx`（303KB 单文件）；neo 保持组件按 feature + primitives 拆分。

---

## 进度与 W3 续做指引（交接给新会话）

**已完成（分支 `feat/design-system-contract`，未 push）**
- W1+W2：契约 `design-system.md` + 棘轮门 `scripts/check-design-system.mjs` + `designSystemGate.test.ts`
- W3-hex：18 处全为合法场景（sandbox 注入 / Mermaid / 品牌图标），分类标注，hex 基线 → 0
- W3 验证批次：`CaptureAddDialog` 迁 Modal primitive，建立迁移模式（见 commit `7d17b9948`）
- W3 收口批次 1（commit `db8b39766`）：`DirectoryPickerModal` + `ExportModal` 迁 Modal primitive（modal 21→19，button 748→743）
- W3 收口批次 2（commit `f004bb9a0`）：`RewindPanel` + `PlanPanel`（实为居中弹窗的 *Panel）迁 Modal primitive（modal 19→17，button 743→739）
- W3 收口批次 3（commit `48ba4e7e7`，**真居中弹窗收尾**）：`DevServerLauncher` + `UpdateNotification`（canClose 接 Modal 关闭门）+ `SessionReplaySummaryDialog`（`!max-w-3xl`+zIndex 10000）+ `ChannelModal`（整 `<form>` 留 Modal 正文，h3→title，导出供测试）迁 Modal primitive（modal 17→12，button 739→735）

**当前棘轮基线**：`{hardcoded-hex: 0, bare-button: 735, handrolled-modal: 12}`

**剩余 12 个 modal 命中的判型（2026-06-17 核查；「真居中弹窗」档已全部迁完）**
- **真居中弹窗**：✅ 全部迁完（CaptureAddDialog / DirectoryPicker / Export / Rewind / Plan / DevServerLauncher / UpdateNotification / SessionReplaySummary / ChannelModal）。
- **特殊布局/lightbox，剩 3（看情况；用户已拍板「真弹窗清完即停」，暂不迁）**：`NativeDesktopSection:83`（图片预览）、`MediaAssetControls:279`（媒体 lightbox，纯居中无 chrome）、`CapturePanel:84`（900×600 大工作面板，`m-auto` 居中，超 Modal 最大尺寸）。
- **不能套 Modal，豁免（已确认，剩 9）**：`App:895`（`justify-end` 右侧 AgentTeamPanel 抽屉）、`AutomationSettings:358` / `WorkspaceSettings:723`（`flex justify-end` + `<aside>` 右抽屉）、`CommandPalette:276` / `MemoFloater:108`（`items-start pt-[15/20vh]` 顶部锚定浮层）、`PreviewPanel:520+537`（`isMaximized` 条件全屏切换，非弹窗）、`FullScreenPage:28`（全屏页）、`SidebarProjectDrawer:206`（抽屉）。

**续做（增量，每批一个小 PR）**
1. **手搓 modal（剩 12）**：真居中弹窗已清空。剩下的 3 个 lightbox/大面板需扩 Modal（如加 `2xl/3xl` size 或 lightbox 变体）才好迁，且 9 个豁免项别动——除非先扩 primitive，否则这档到此为止。
   ⚠️ **不是所有 `fixed inset-0` 都是居中弹窗**：`SidebarProjectDrawer`(抽屉)、右侧 `<aside>` 抽屉、`*Floater`/`CommandPalette`(顶部浮层)、`FullScreenPage`(全屏)、`PreviewPanel`(maximize 切换)、纯 backdrop 不能套 Modal。
2. **裸 button（剩 735）**：交互按钮迁 `Button`/`IconButton`，纯语义/特殊布局留并标 `// ds-allow:button 理由`。按文件分批，不 big-bang。
3. **每批闭环**：改 → `npm run typecheck` → 写/更新渲染验证测试（`vi.mock` store + `renderToStaticMarkup`，见 `captureAddDialog.test.tsx`）→ `node scripts/check-design-system.mjs --update` 降棘轮 → 提交。
4. 列违规精确位置：`node -e "import('./scripts/check-design-system.mjs').then(m=>{m.scan()['handrolled-modal'].forEach(l=>console.log(l))})"`
