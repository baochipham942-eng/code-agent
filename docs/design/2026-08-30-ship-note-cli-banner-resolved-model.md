# Ship Note — banner/StatusBar 显示实际解析模型

日期：2026-08-30
分支：fix/cli-banner-resolved-model

## 背景

用户要求把默认模型改成基元 glm-5.3-flash（改 `~/.code-agent/config.json`：
`providers['custom-tokenrhythm'].model` + `routing.chat.model`）后发现一个显示 bug：
CLI 裸启动时 banner 和 StatusBar 显示的是 `DEFAULT_PROVIDER`/`DEFAULT_MODELS.chat`
常量（longcat/LongCat-2.0），而不是 config 实际解析出的 provider/model。
之前用户一直以为"默认模型是 longcat 且欠费"，这个常量显示就是误导源之一。

## 改动

`src/cli/commands/chat.ts`（一个文件，17+/16-）：

- `createCLIAgent` 提到欢迎横幅之前，banner 的 provider/model 改取
  `agent.getConfig().modelConfig`（config 默认或 --provider/--model flag 的实际解析值）；
- Ink TUI `runInkChat` 的 `model` 选项同源（StatusBar 初始显示；
  /model 切换后仍由事件流刷新，行为不变）；
- 顺带移除不再使用的 `DEFAULT_PROVIDER`/`DEFAULT_MODELS` import。

## 验证

- pty（`pty_banner_model.py`，裸启动）：banner 显示 `custom-tokenrhythm/glm-5.3-flash`，
  StatusBar 显示 `glm-5.3-flash`，不再误显示 LongCat；
- pty 回归：布局+model picker、shell 直通、P1 UX 全过；非 TTY exit 0；
- typecheck / build:cli / eslint / knip×3 全过。

## 排障记录（勿再踩）

- pty_shell_passthrough 一度连续 FAIL（草稿打完不提交）：不是本次改动引入，
  是脚本用固定 sleep 等 raw mode，高负载下来不及——prompt 出现≠raw mode 就绪。
  已改为轮询 ICANON 关闭再打字（与 pty_layout_picker 同款），立即恢复全绿。
- 共享 checkout 有并发 agent 活动：`git stash`/`pop` 会撞到其他 agent 的 stash
  （本次 pop 误弹 feat/split-eval 的 stash 造成冲突现场），A/B 对照改用只读手段
  （配置翻转/脚本对照），不用 stash。
