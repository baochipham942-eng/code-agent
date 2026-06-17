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
