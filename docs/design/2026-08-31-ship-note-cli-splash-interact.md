# Ship Note — 首屏可点 + 空闲闪烁/StatusBar/光标

日期：2026-08-31
分支：feat/cli-splash-interact

## 背景

#1510 海报落地后用户实测：logo 太稀、四动作不能点、回合中「分析请求中」闪、
回完绿菱形还在闪、placeholder 光标是白块、StatusBar 塞了 cwd/idle/耗时/turns。

根因：空闲时 133ms 整树重渲（spinner 定时器从不关）+ task_progress 空 step 把
「分析请求中」盖成 Thinking… 再盖回去。

## 改动

- 空闲停表：只在 `running` 时 7.5fps 跳 spinner；去掉空闲呼吸 ◆。
- task_progress：有具体 step 时不被泛化标签覆盖；completed 不清空运行中标签。
- StatusBar 左右分栏：左 `ask  model  (provider)  branch*`，右 `⇡ ⇣ ctx $`。
- 海报：更密的星簇 logo；↑↓/Enter 选动作；SGR 鼠标悬停+左键（Grok 同款协议）。
- placeholder/编辑光标改绿色 inverse，不再是白块。

## 验证

- 单测：welcomeSplash 几何命中、mouse SGR、statusBar 文案、task_progress 不闪。
- typecheck / build:cli / eslint / knip×3、cli tui-app 单测。
- pty 首屏仍有 Agent Neo 海报；空闲帧不再出现 ◆。
