# Ship Note — CLI 首屏/输入框对标 Grok·Kimi·Codex（全屏零噪音版）

日期：2026-08-31
分支：feat/cli-input-box-design

## 背景

用户对照 Grok Build / Kimi Code / Claude Code / Codex 四家 CLI 首屏，指出 neo
输入框"太差"；看完批 1 后进一步明确方向：**Grok 页面没有噪音、是全屏设计**，
logo 也要优化。用户实测决策链：2026-08-30 紧凑流式（消灭留白）→ 2026-08-31
全屏钉底（Grok 构图：留白在内容之上、输入区钉屏底，上半屏的拥挤感消除）。

## 改动

**批 1（输入框）**
- `Editor.tsx`：`┃` rail → 圆角边框输入框（灰边框 + 绿 ❯）；空草稿 dim placeholder
  「让 Neo 做点什么…」，光标叠首字符反色（Codex "Ask Codex to do anything" 风格）。
- `tips.ts`（新）：首屏 tip 轮换（`pickStartupTip(seed)` 纯函数；数组不 export，
  knip production 门，测试走行为断言）。
- `App.tsx`：tip 行（空会话空闲时输入框上方）；编辑器布局预算 +2（边框行）。
- `chat.ts`：git dirty 检测（`--untracked-files=no`——长期未跟踪文件不让 * 常亮）；
  `terminal.ts`：banner hints 加 `/resume`。

**批 2（全屏零噪音）**
- `layout.ts`：`planDynamicLayout` 改全屏钉底——动态块恒等于终端行高，
  live 预算分配（最新优先、最旧截尾）不变；layout.test.ts 同步重写。
- `WelcomeCard.tsx`（新）：Grok 式居中欢迎卡（菱形星簇 logo + 版本 +
  实际 provider/model + cwd + 快捷动作行），空会话时在 live 区居中渲染，
  首条消息出现即让位。Ink 模式不再打 scrollback 文字横幅
  （全屏 Ink 块会把它顶出可视区）——横幅只在 readline/非 TTY 打印。
- `App.tsx`：零噪音首屏——空会话隐藏呼吸 ◆ 与 ShortcutsBar（running/菜单/
  草稿/审批/搜索时恢复）；InkChatOptions 增加 `provider`/`version`。
- `terminal.ts`：logo 方框 → 菱形星簇（保留 ◈ 识别符号）。

## 验证

- 单测：tips/layout 新增重写，tui-app 全套 94、cli 全套 252 过。
- pty 首屏实帧（30x100）：居中欢迎卡 + 底部 tip + 边框输入框 + StatusBar 钉底，
  无 ShortcutsBar/呼吸 ◆——Grok 式安静首屏。
- pty 回归：layout_picker（全屏钉底断言改为 StatusBar 锚定帧尾 + 欢迎卡出现）、
  shell_passthrough、ux_p1（Ctrl+Q 一次 flake，复跑全过）、focus_leak 全过；非 TTY exit 0。
- typecheck / build:cli / eslint / knip×3 全过；全量 vitest 真跑。

## 排障记录

- 零噪音首屏隐藏呼吸 ◆ 后无周期重渲，pty 脚本"等 raw mode 后再抓帧"抓到空——
  断言脚本改为从进程启动起全量缓冲取帧（wait_raw_mode 不再丢弃排干字节）。
- /model 选择器 ◄ 误判：全屏帧分多 chunk 吐出，只等表头会在条目未刷完时断言——
  改为等帧尾分页行。
- knip production 门抓 `STARTUP_TIPS` 死导出（只被测试消费）：转私有 + 行为断言。
