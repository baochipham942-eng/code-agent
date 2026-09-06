# Ship Note — 欢迎卡改顶左 + 焦点序列启动窗口回显修复

日期：2026-08-31
分支：fix/cli-welcome-top-left-focus-echo

## 背景

#1505 落地后用户实测首屏反馈两点：

1. **"谁放中间的？"**——Grok 式居中欢迎卡不被接受，改回顶左（原文字横幅的位置，
   与消息流同一左边距 paddingX=2）。
2. **状态行末尾出现 `idle^[[I`**——焦点序列的启动窗口漏法：DECSET 1004 在 App
   useEffect 里挂载即开，但 Ink 的 raw mode 是另一个 effect（useInput 声明在
   更后面），开启 1004 时 tty 还在规范模式，焦点序列被 ECHOCTL 回显成 `^[[I`
   糊在输出光标处；零噪音首屏无周期重渲，回显一直挂在那里。
   （#1504 修的是 raw 就绪后序列进 useInput 的路径，没盖住启动窗口。）

## 改动（src/cli/tui-app/App.tsx，2 处）

- WelcomeCard 容器：`justifyContent/alignItems: center` → `flex-start` + paddingX=2
  paddingTop=1（顶左，与原横幅位置一致）。
- 焦点上报开启推迟到 raw mode 就绪后：`setTimeout(0)` 后再写
  FOCUS_REPORTING_ENABLE（useEffect 同步flush 完成后 Ink raw mode 已开，
  timer 才触发）；cleanup 清 timer。卸载侧 1004 关闭在 cleanup 里即做，
  先于进程退出，逃逸窗口最小化。

## 验证

- pty 首屏实帧（30x100）：欢迎卡顶左、tip+输入框+StatusBar 钉底；
  raw 就绪后注入 `\x1b[O\x1b[I` 零可见残片。
- pty 回归：layout_picker / shell_passthrough / focus_leak 全过。
- typecheck / build:cli / eslint / knip×3、cli 单测 252 全过；全量 vitest 真跑。

## 备注

启动窗口的回显是 tty ECHOCTL 行为，无法在应用侧事后擦除，只能预防
（1004 不在 raw 就绪前开）。pty 无法确定性复现该竞态，此项为逻辑修复 +
无回归验证。
