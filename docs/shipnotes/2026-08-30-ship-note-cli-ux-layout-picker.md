# Ship Note — feat/cli-ux-layout-picker（紧凑布局 + status 下置 + /model 选择器）

> 日期：2026-08-30 · 分支：feat/cli-ux-layout-picker（1 commit，基于 feat/cli-startup-error-path）
> 用户实测反馈：①首屏整屏留白、要借鉴 Claude Code/Codex 布局、status line 放
> 输入框下；②/model 列表不能用光标选择（skill/文件/mcp 是否同病？）。

## 范围

1. **紧凑流式布局**（消灭首屏留白）：动态块从恒等于终端行高改为内容自然高
   （封顶 rows）——空会话首屏只有 banner + 呼吸 ◆ + 输入框 + 状态行 + 提示行
   （pty 实测 0 空行），Claude Code/Codex 同款流式；内容超高时回退 P3 钉顶
   满高 + 预算截尾（Ink v7 overflowY 裁剪缺陷的护栏保留）。
   `layout.ts` 新增 `planDynamicLayout` 纯函数（紧凑/钉顶/恰边界三态）；
   `allocateLiveBudget` 转模块内私有（生产只经 planDynamicLayout 消费，
   分配语义由钉顶分支单测覆盖，knip production 门守住了这个死导出）。
2. **status line 下置**：钉顶 StatusBar 撤销，全部分段平移到输入框下
   （模型(provider) · cwd(branch) · ctx 迷你条 · 成本 · ◉N bg · turns ·
   上轮耗时 · running/idle），ShortcutsBar 仍在最底行。规格文档
   （2026-08-29-ink-tui-grok-interaction-spec.md）补偏差记录。
3. **/model 交互选择器**：无参 /model 打开 blocking picker（provider 列表
   ✓/✗ key 状态 + ◄ 当前标记 + 默认模型），↑↓ 导航、Enter 走
   `/model <id>` 原链路切换、Esc 关闭；数据经 `modelItems.ts` 纯函数由
   chat.ts 注入（PROVIDER_REGISTRY + PROVIDER_ENV_KEYS + 当前 provider）。
   带参 /model 与 /model key（readline 路径）零改动。

**用户问题直连回答**：/skills 也是静态打印，但它是只读清单、无"选择"语义；
`@` 文件引用与 MCP 选择在 CLI Ink 尚不存在（无此交互，暂无同病；
@ picker 属借鉴清单 A2 B 档，未排期）。

## 验证证据

- **全量**：`npx vitest run`（以 PR CI 为准；本地 tui-app 92 例全绿）
- **质量门**：typecheck 0 错；build:cli 成功；eslint 0 告警；knip 三门全过
- **pty 端到端**（/tmp/neo-p0-sandbox/pty_layout_picker.py）：空会话首屏
  0 空行、状态行在输入框下、/model 选择器打开含 ◄ 标记、↓+Enter 切换成功、
  /exit exit 0
- **新单测**：planDynamicLayout 三态 + 边界、buildModelPickerItems key 状态
  与当前标记

## 偏差与遗留

- 紧凑模式下 settled 消息仍进 `<Static>` 滚入历史（滚动语义不变）；
  Ctrl+X 归组展开仍只影响动态区
- /model 切换后 StatusBar 的模型名在下个 model_response 事件才刷新
  （现状数据流，非本批引入）
- ModelPicker 组件与 SlashMenu/ApprovalCard 同构但尚未抽象通用 Picker，
  待第二个消费方（/skills、@ 文件）出现时再收敛
