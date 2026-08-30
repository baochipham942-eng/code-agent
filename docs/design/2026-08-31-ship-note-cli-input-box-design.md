# Ship Note — 输入框/首屏对标 Grok·Kimi·Codex 第一批

日期：2026-08-31
分支：feat/cli-input-box-design

## 背景

用户对照 Grok Build / Kimi Code / Claude Code / Codex 四家 CLI 首屏，指出 neo
输入框"太差"。四家的共同语言：boxed input（Kimi/Grok/Claude 都有边框输入框）、
placeholder（Codex "Ask Codex to do anything"）、首屏 tip 行（Grok）、
状态行 git dirty 星标（Claude `main*`）、快捷动作可发现性（Grok 菜单卡）。

## 改动（src/cli 内 5 文件 + 2 测试）

- `Editor.tsx`：`┃` rail 改为圆角边框输入框（gray 边框 + 绿色 ❯ 前缀）；
  空草稿显示 dim placeholder「让 Neo 做点什么…」，光标叠首字符反色（Codex 风格）。
- `tips.ts`（新）：首屏 tip 轮换数据 + `pickStartupTip(seed)` 纯函数；
  tips 数组不 export（knip production 门，测试走行为断言）。
- `App.tsx`：空会话空闲时输入框上方渲染 tip 行（计入 chromeRows 布局预算）；
  编辑器分支布局预算 +2（边框上下行）；StatusBar 新增 `gitDirty` prop 渲染 `branch*`。
- `chat.ts`：`git status --porcelain --untracked-files=no` 检测脏标（不看未跟踪文件——
  仓库级 scratchpad 类长期未跟踪文件不该让 * 常亮失去信息量），传入 InkChatOptions。
- `terminal.ts`：banner hints 加 `/resume`（快捷动作可发现性，Grok 菜单卡的平替——
  居中卡片菜单与刚落地的流式紧凑布局冲突，刻意不照搬）。

## 验证

- 单测：`tips.test.ts` 新增（确定性/轮换覆盖/单行格式）；tui-app 全套 95 过。
- pty 首屏实帧：banner（含 /resume）→ tip 行 → 圆角输入框 placeholder → StatusBar，
  与 Kimi 构图一致；pty_layout_picker / shell_passthrough / ux_p1 全过。
- typecheck / build:cli / eslint / knip×3 全过；全量 vitest 真跑。

## 排障记录

- pty_layout_picker 一度 FAIL「状态行不在输入框下面」：呼吸 ◆ 每 ~650ms 重渲一帧，
  2s 截取窗口末尾切在半帧上（编辑行在最近、状态行在上一帧）——断言脚本问题，
  已改为以 ShortcutsBar 行锚定最后一个完整帧再断言。非产品 bug。
- knip production 门抓 `STARTUP_TIPS` 死导出（只被测试消费）：转私有 + 测试改行为断言。
