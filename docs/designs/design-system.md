# Neo 设计系统契约

> **本文件是契约，不是描述。** 任何 PR 若破坏下述规则，必须在**同一 commit** 内更新本文档说明理由，否则 W2 静态门会拦截。
> 目的：约束所有 UI 产出（含 AI 生成）走统一 token + primitives，杜绝硬编码漂移。
> 落地来源：maka 借鉴 P2-4；基线核查见 [`design-system-contract-plan.md`](./design-system-contract-plan.md)。

---

## 0. 三条铁律（W2 静态门强制）

1. **颜色走 token，禁硬编码 hex/rgb 字面量** —— 合法豁免仅四类（注入 HTML / viz 配置 / 品牌资产 / 集中色板），见 §3。
2. **交互按钮走 `Button`/`IconButton` primitive，禁裸 `<button>`** —— 语义性/特殊布局豁免须带 `// ds-allow:button <理由>`。
3. **模态走 `Modal` primitive，禁手搓 `fixed inset-0` 遮罩**。

违反任一条 = CI 红。豁免一律靠行内注释显式声明，不留隐式后门。

---

## 1. Token 体系（真理源 = `src/renderer/styles/`）

token 全部以 CSS 变量承载，主题层（`themes/{dark,light,high-contrast-dark,high-contrast-light}.css`）覆盖颜色，`global.css` 定义结构/排版/动效。**业务代码只引用 token，不写字面量。** Tailwind 已把语义色映射成 class（`tailwind.config.js`）。

### 1.1 语义色（45 个，四主题各一套）

| 类别 | token | 用途 |
|------|-------|------|
| 背景层 | `--bg-void` `--bg-deep` `--bg-surface` `--bg-elevated` `--bg-hover` `--bg-active` | 由深到浅的层级，hover/active 是交互态 |
| 文本 | `--text-primary` `--text-secondary` `--text-tertiary` `--text-disabled` `--text-inverse` | 五级层级，禁用走 `-disabled` 不要自调透明度 |
| 品牌 | `--brand-primary` `--brand-primary-hover` `--brand-primary-muted` `--brand-primary-glow` | 主操作/强调 |
| 语义 | `--color-success(-muted)` `--color-warning(-muted)` `--color-error(-muted)` `--color-info(-muted)` | 状态色，`-muted` 用于背景填充 |
| 边框 | `--border-subtle` `--border-default` `--border-strong` `--border-focus` | focus 环统一用 `--border-focus` |

> **禁止**：自定义 hex 表达上述任何语义。需要新语义色 → 先在四套主题文件同步加 token，再引用。

### 1.2 结构 / 排版 / 动效（`global.css`）

| 类别 | token |
|------|-------|
| 圆角 | `--radius-sm` `--radius-md` `--radius-lg` `--radius-xl` `--radius-full` |
| 字号 | `--font-size-xs` `--font-size-sm` `--font-size-base` `--font-size-lg` `--font-size-xl` |
| 字重 | `--font-weight-normal` `--font-weight-medium` `--font-weight-semibold` `--font-weight-bold` |
| 行高 | `--line-height-tight` `--line-height-normal` `--line-height-relaxed` |
| 动效 | `--duration-fast` `--duration-normal` `--duration-slow` · `--ease-out` `--ease-in-out` |
| 布局 | `--header-height` `--sidebar-width` `--task-panel-width` |

> **禁止**：硬编码 `border-radius: 8px`、`transition: 0.2s`、自定义 `cubic-bezier(...)`、`z-index: 9999`。圆角/动效走 token，z-index 走分层约定（见 §4）。

---

## 2. Primitives 契约（真理源 = `src/renderer/components/primitives/`）

所有基础交互元素必须用以下 primitive，禁止在 feature 组件里重新实现。

| Primitive | 变体 / 尺寸 | 内建态 | 备注 |
|-----------|-----------|--------|------|
| `Button` | variant: `primary`/`secondary`/`ghost`/`danger`，size: `sm`/`md`/`lg` | disabled · loading · a11y | 含语义快捷封装 `PrimaryButton`/`SecondaryButton`/`GhostButton`/`DangerButton` |
| `IconButton` | variant: `default`/`ghost`/`danger`/`active`/`outline`，size: `sm`/`md`/`lg` | disabled · a11y（须 `aria-label`） | 含 `CloseButton` |
| `Input` | type: `text`/`password`/`search`/`email`/`number` | disabled · error | |
| `Textarea` | — | disabled · error | |
| `Select` | — | disabled | 支持 `SelectOption` / `SelectOptionGroup` |
| `Modal` | size: `sm`/`md`/`lg`/`xl`/`full` | Esc 关闭 · `aria-modal` · focus 管理 | 配 `ModalHeader` / `ModalFooter`，禁手搓遮罩 |
| `Toggle` | size: `sm`/`md` | disabled · a11y | |
| `UndoToast` | — | — | 撤销提示统一入口 |

**状态归属约定**：`loading`/`error` 态归属 surface 容器（Button/Input），不要在调用方临时拼 spinner/红边。新增 primitive 须同步本表。

---

## 3. hex 豁免（四类，其余一律视为漂移）

有四类场景的字面色是合法的（app 的 CSS 变量物理上够不到，或属于解耦色板），不计违规。**豁免一律显式声明，不留隐式后门。**

**① 注入 HTML / sandbox（门自动豁免）**
模板字符串（反引号）内的 hex = 注入 iframe / srcdoc 的自包含 HTML/CSS。CSS 变量不会级联进 sandbox，必须用字面色。门检测到 hex 处于模板字符串内时自动跳过——无需标注。
现存：`GenerativeUIBlock`(INJECTED_STYLES)、`InAppValidationPanel`(DEMO_HTML)、`utils/workspacePreview`(预览 HTML)。

**② viz 配置（目录豁免 / 区块标注）**
图表、DAG、热力图、lab 教学图、第三方库主题等需要离散、与语义色解耦的调色。
- viz-heavy 组件按目录豁免：`LivePreview/TweakPanel`、`MessageBubble/ChartBlock`、`telemetry/CostCalendar`、`workflow/{DependencyEdge,DAGViewer,TaskNode}`、`lab/**`。
- 成块的 viz 配置用区块标注 `// ds-allow:start <理由>` … `// ds-allow:end`（例：`MessageContent` 的 Mermaid `themeVariables`——第三方库只吃字面色不读 CSS 变量）。
- 未来集中色板可建 `src/renderer/utils/vizPalette.ts` 统一引用（暂未建，按需）。

**③ 品牌资产**
品牌图标 / logo 的专用色（非通用 UI surface），用区块标注 `ds-allow:brand`（例：`AboutSettings` 的 Neo 图标）。

**④ 单点豁免**
临时/单点用色，行内标 `// ds-allow:viz <理由>` 或裸 `// ds-allow <理由>`。

> **W3-hex 复盘（2026-06-17）**：初判的 18 处"真漂移"经逐一核查，全部属于上述①②③——sandbox 注入、Mermaid 配置、品牌图标，**没有一处是真漂移**。已分类标注，hex 基线降至 **0**：此后任何模板外、非豁免的新 hex 都会被门拦下。

---

## 4. 其它约定

- **z-index**：禁 `9999` 等魔法值；走分层语义（base / dropdown / sticky / modal / toast），新增层级在此登记。
- **reduced-motion**：`@media (prefers-reduced-motion: reduce)` 下动画塌到 `0.01ms`，禁止留真实动画。
- **标识符**（model ID / API key / 路径）：等宽字体呈现。

---

## 5. 维护 gate

- 破坏任一规则的 PR，必须同 commit 更新本文档（解释为何破例 + 是否需放宽 token/豁免）。
- 新增 primitive / token：先改真理源（primitives 目录 / 主题文件），再更新本文档对应表。
- W2 静态门（`scripts/check-design-system.mjs`）是本契约的机器执行层；契约改了，门的白名单/规则要同步。

## 6. 反面教材

不学 maka 的 `packages/ui/src/components.tsx`（303KB 单文件巨石）。Neo 保持 primitives 按文件拆分 + feature 组件组合的结构。
