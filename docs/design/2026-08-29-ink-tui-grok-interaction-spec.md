# Ink TUI 改造 · Grok Build 交互规格基准

> 来源：xai-org/grok-build（Rust + ratatui，Apache 2.0）源码与随包用户手册（crates/codegen/xai-grok-pager/docs/user-guide/，27 篇）。
> 用途：neo CLI Ink 重写的交互设计基准。不抄实现（Rust 不可移植），抄交互与动效决策。
> 日期：2026-08-29

## 布局（fullscreen 模式，自上而下）

1. 顶部 StatusBar（固定 1 行，分段按状态条件出现：后台任务计数、plan chip、context 用量等）
2. Scrollback 消息区（占满剩余空间，最小 5 行，右侧滚动条，左右 padding 2 列）
3. Turn status 行（仅运行时出现，位于消息区与输入框之间）
4. Prompt 输入区（高度随内容自动伸缩）
5. 最底部 shortcuts bar（随上下文切换提示内容）

## Prompt 输入区

- **不是四边框盒子**：左侧一条粗竖线 accent rail `┃`（颜色 = accent_user，plan 模式 accent_plan），顶部可有一条承载标题的 border
- prompt 符号 `❯ `（U+276F + 空格，占 2 列）
- 信息行：`grok-4.6 (high) · always-approve` —— 模型(effort) + 模式 flags
- 终端 ≤20 行自动 compact，≤16 行砍掉 banner/CTA

## 输入行为

- Enter 提交；Shift+Enter / Alt+Enter 换行；`\` 结尾 Enter 也续行
- `/multiline`（Ctrl+M）反转 Enter 语义
- **粘贴 chip**：≥4 行或 ≥10KB 的粘贴折叠成 `[Pasted: N lines]` 徽章，Enter 可展开，Ctrl+Shift+V 强制内联
- 空 prompt 按 ↑ 进历史面板（翻到的内容落回输入框可编辑）
- `@` 文件模糊引用（遵守 gitignore，`@file:10-50` 行区间）；`!` shell 模式；`#` remember 模式
- turn 运行中：带文本 Enter = 排队 follow-up；空 composer 双 Enter / Ctrl+Enter = send now（取消当前 turn 立即发）
- Ctrl+S 草稿 stash（发送下一条后自动弹回）

## 消息渲染

- Markdown 深度渲染：标题分级色、列表、任务列表、围栏代码 syntect 高亮（内置 3 个 .tmTheme 随主题选）、表格、OSC 8 链接、LaTeX 数学转 Unicode、Mermaid。颜色按终端能力 truecolor→256→16 降级
- 流式 = **按数据块增量渲染**，checkpoint 机制只重渲未稳定尾部；非逐字动画
- **Thinking 三态**：运行中加粗 `Thinking…` + 正文截断尾部 3 行（颜色向背景 blend 70% 灰化）→ 结束折叠成单行 `Thought for 12.3s`（ctrl+e 展开）→ Ctrl+E 全局展开/折叠
- diff 内联渲染：行号、hunk 分隔、insert/delete 独立 fg+bg 色组
- 每条 user prompt 是 sticky header；块可按 r 切 raw markdown 视图

## 工具调用

- 单块 = bullet（默认 `◆`）+ 动词（运行时 `Reading` → 完成时 `Read`，有时态）+ 单行参数摘要
- **同类连续调用自动归组**：`Read 3 files` / `Searched 4 patterns`（`›` 可展开）；破坏性/动作类不参与归组
- 折叠态整体灰色（muted_collapsed），细节再降一档
- shell 输出截断显示前 2 行 + 后 3 行

## 权限确认

- 占据 prompt 区域的 blocking card（非弹窗），键盘被它接管
- 选项组合：Allow once / No, reject（No 行可直接打字附反馈）/ Enable always-approve / Allow all edits this session / Always allow: <命令> / never allow
- 快捷键：1-9 直选、←→ 调整 always 授权范围、Esc 永不作答、Ctrl+C 取消
- 模式循环 Shift+Tab：Normal → Plan → Auto → Always-approve

## 状态行（三条，别混淆）

- 顶部 StatusBar：条件性分段（链接 hover、后台任务、plan、goal、MCP 进度、context 用量）
- Turn status 行（运行时）：`⠧ Run command 0.2s    1m20s ⇣12k [stop]` = spinner + 活动标签（按类型着色）+ 阶段计时 + 排队提示 + turn 总计时 + token 数 + 可点击 [stop]
- 底部 shortcuts bar：随焦点/状态切换

## 中断与退出（分层语义表）

| 场景 | 按键 | 行为 |
|---|---|---|
| turn 运行中 | Esc | 立即取消，保留草稿；再按重发取消 |
| 有草稿 | Ctrl+C 第一次 | 只清草稿，turn 继续 |
| 空 prompt 运行中 | Ctrl+C | 取消 turn；再按向退出升级 |
| 空闲双击 Esc（800ms） | prompt 非空 | 清草稿（先进 stash，首次显示 press again） |
| 空闲双击 Esc | prompt 为空 | 打开 rewind 选择器 |
| 退出 | Ctrl+Q | 1000ms 内双击确认（防误触） |

## 配色模型

- 默认 GrokNight：中性深灰底 + 品红 accent；按角色分 accent slot：`accent_user / accent_assistant / accent_thinking / accent_tool / accent_system / accent_error / accent_success / accent_running / accent_plan`
- 启动时 OSC 12 把终端光标染成 accent_user，退出 OSC 112 还原
- 颜色启动时按终端能力量化降级；NO_COLOR 单色

## 动效体系（用户认为各家最佳的部分）

- 主 spinner：braille `⠋⠙⠹⠸⠼⠴⠦⠧`，**刻意降到 ~7.5fps**（30fps 每帧停 4 tick）
- **等待用户输入时 spinner 换成脉动 `◆`**（sin² 呼吸，~1.3s 周期）
- 后台监控提示：慢速同心圆 `○ ◎ ◉ ◎`（~1.07s/圈）
- subagent/task 行：点阵 spinner `⋅ : ⸬ ⁙`
- Toast：单行右对齐轻提示（如 `Copied!`）
- 防误触：退出/新会话双击确认；取消后 1s 冷静期抑制 rewind
- 滚动跟随指示器 `▼/▲`；手动折叠的块钉住不被流式重置
- 所有字形严格 1 列宽，防布局抖动；legacy console 全套降级表

## 对 Ink 实现的落地要点

1. `❯` 前缀 + 左侧 accent rail，不做全边框盒
2. Turn status 单行：spinner + label + 计时 + token + [stop]
3. Paste chip 阈值策略（≥4 行或 ≥10KB）
4. Thinking `Thought for Xs` 折叠单行 + 尾部 3 行截断 + 70% 灰化
5. Verb-group 归组（"Read 3 files"）
6. Esc/Ctrl+C 分层语义表照搬
7. 角色化 accent slot 主题模型
8. Spinner 降帧 ~7.5fps + 等待输入时的呼吸 `◆`
