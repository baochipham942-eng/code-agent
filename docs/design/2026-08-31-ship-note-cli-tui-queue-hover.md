# Ship note: CLI TUI 队列/标题/hover/工具折叠

欢迎动作只在鼠标落到右侧文案列时白底高亮，移开清空。Logo 900ms 自闪，不拉 App 树。

输入 ❯ 改白，光标不再盖住 placeholder 首字。每帧藏硬件光标，避免钉在右下角。

「分析请求中」归一成 Thinking…，不再和 Thinking 来回闪。失焦通知带回复摘要；Ghostty 标签走 OSC 0。

队列条只在真有 follow-up 时出现：`#N 正文 [Send now][edit][cancel]`，hover 高亮，点击正文/edit 拉回输入框。

工具调用默认折叠一行 `›`，点击或 Ctrl+X 展开结果。Grok pager 是 Rust/ratatui，Ink 不能链源码，只借视觉语法。
