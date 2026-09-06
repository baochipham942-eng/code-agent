# Ship note: CLI TUI scrollback 去重 + 欢迎 hover 白底

封口消息曾同时进 Static 和 live，全屏后上下各一份正文、中间一块空。改为预算内只在 live 画一次；被挤出视口的封口消息才进 Static。

欢迎页四个动作：鼠标移动/点击只加白底选中，Enter 才执行。输入框加内边距；消息块加行距；Ink 期间藏终端硬件光标。

字号仍由终端字体决定，CLI 改不了 cell 高度。
