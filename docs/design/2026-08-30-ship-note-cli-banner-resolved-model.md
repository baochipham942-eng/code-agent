# Ship Note — banner/StatusBar 显示实际解析模型 + 焦点序列残片过滤

日期：2026-08-30
分支：fix/cli-banner-resolved-model

## 背景

用户要求把默认模型改成基元 glm-5.3-flash（改 `~/.code-agent/config.json`：
`providers['custom-tokenrhythm'].model` + `routing.chat.model`）后发现两个显示问题：

1. **banner/StatusBar 显示常量而非实际模型**：CLI 裸启动时显示的是
   `DEFAULT_PROVIDER`/`DEFAULT_MODELS.chat`（longcat/LongCat-2.0），而不是 config
   实际解析出的 provider/model。之前用户一直以为"默认模型是 longcat 且欠费"，
   这个常量显示就是误导源之一。
2. **焦点事件序列漏进输入框（截图/切窗时输入框出现 `[O[I` 乱码）**：
   DECSET 1004 焦点上报（#1488 终端通知引入）开启后，终端在焦点变化时发
   `\x1b[I`/`\x1b[O`；Ink use-input 对未识别 CSI 序列剥掉 ESC 前缀原样上抛，
   残片 `'[I'`/`'[O'` 被当文本插进草稿。用户截图取证：输入框里 `[O[I[O[I`。

## 改动

- `src/cli/commands/chat.ts`：`createCLIAgent` 提到欢迎横幅之前，banner 与 Ink
  `runInkChat` 的 `model` 选项都改取 `agent.getConfig().modelConfig` 的实际解析值；
  移除不再使用的 `DEFAULT_PROVIDER`/`DEFAULT_MODELS` import。
- `src/cli/tui-app/terminalNotification.ts`：新增 `isFocusEventInput()`——
  精确匹配整段 `'[I'`/`'[O'`（手敲 `[` 和 `I` 是两次独立按键事件，不误伤；
  代价是恰好 2 字符的 `'[I'`/`'[O'` 粘贴会被吃掉，可接受）；
  `src/cli/tui-app/App.tsx` 在 useInput 入口过滤，不进草稿、不触发快捷键。

## 验证

- 单测：`terminalNotification.test.ts` 新增 isFocusEventInput 两条（残片命中 + 普通输入不误伤）。
- pty（`pty_banner_model.py`）：裸启动 banner 显示 `custom-tokenrhythm/glm-5.3-flash`，
  StatusBar 显示 `glm-5.3-flash`，不再误显示 LongCat。
- pty（`pty_focus_leak.py`）：注入 3 轮 `\x1b[O\x1b[I`，编辑器零残片；
  正常输入回显正常；/exit exit 0。
- pty 回归：布局+model picker、shell 直通、P1 UX 全过；非 TTY exit 0。
- typecheck / build:cli / eslint / knip×3 全过；全量 vitest 真跑，
  假红按"失败集⊆纯 main 基线集"对照（agentEngineModelCatalog 为计时 flake，
  隔离环境连跑 3 次全过）。

## 排障记录（勿再踩）

- pty_shell_passthrough 一度连续 FAIL（草稿打完不提交）：不是代码改动引入，
  是脚本用固定 sleep 等 raw mode，高负载下来不及——prompt 出现≠raw mode 就绪。
  已改为轮询 ICANON 关闭再打字（与 pty_layout_picker 同款），立即恢复全绿。
- 共享 checkout 有并发 agent 活动：`git stash`/`pop` 会撞到其他 agent 的 stash
  （本次 pop 误弹 feat/split-eval 的 stash 造成冲突现场）；`git add -A` 会把
  其他 agent 的未跟踪文件扫进提交（已 amend 剔除）。A/B 对照用配置翻转/脚本对照，
  提交前必查 `git show --stat`。
