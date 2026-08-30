# Ship Note — CLI 首屏改 Grok Build 式欢迎海报

日期：2026-08-31
分支：feat/cli-welcome-splash

## 背景

#1505 落地的是一张 3 行菱形小卡；用户当时说「谁放中间的？」，#1507 把它挪到顶左。
随后对照 Grok Build 1.0.13 真机首屏：对方不是角落小卡，而是**全屏留白里一张宽海报**——
大 logo、产品名/版本、黄色高亮句、右侧对齐快捷动作、顶左 `branch  ~/path`、底栏 tip + 输入框。

本 PR 按那张构图改 Neo，不抄 Grok 的 worktree/F3 picker（我方还没有对应入口）。

## 改动

- `welcomeSplash.ts`（新）：full/compact logo、高亮句、动作表、家目录缩写；纯数据可单测。
- `WelcomeCard.tsx`：宽圆角海报（大星簇 logo + Agent Neo 版本 + 黄字高亮 + Switch model / Sessions / Help / Quit）。
- `App.tsx`：空会话 live 区重新居中海报；顶左一行 workspace（`main  ~/Downloads/ai`）；
  矮终端（<22 行）改紧缩 logo。StatusBar 首帧用 options.provider 兜底，不再等事件流。
- `terminal.ts`：非 TTY 横幅改用同一套 compact logo + `abbreviateHomePath`。
- `chat.ts`：修 git 分支探测——`execSync` 不能把 `2>/dev/null` 当参数（无 shell），
  改为 `stdio: ignore` stderr；空仓库仍静默。首屏顶左才能出现 `main  ~/path`。

## 有意不做

- 海报动作表不接管键盘（避免和空草稿 ↑ 历史抢键）；/model 仍走既有 picker。
- 不编 `New worktree` / F3 resume picker（借鉴清单 P2，未落地）。
- #1507 的焦点上报延迟（raw mode 后再开 DECSET 1004）原样保留。

## 验证

- 单测：welcomeSplash + terminalOutput welcome。
- typecheck / build:cli / eslint / knip×3、cli tui-app 单测。
- pty 首屏实帧：顶左 workspace 行、居中海报（Agent Neo + 高亮句 + 动作表）、tip + 输入框 + StatusBar 钉底。
