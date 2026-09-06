# Ship note: CLI TUI Shift+Enter / hover leave / `!` 暖边 / 去圆点

Ghostty 的 Shift+Enter 走 xterm modifyOtherKeys（`CSI 27;2;13~`）。Ink 剥掉 ESC
后把 `[27;2;13~` 当文本插进草稿，截图是 `1111[27;2;13~`。现在整段识别为换行，
其它 CSI 残片丢弃，不进输入框。Ctrl+J 仍是换行。

欢迎动作：鼠标落到底栏（输入框/tip/StatusBar）或终端失焦时清 hover，避免
Quit 粘住。开始打字也清。

空草稿光标改背景色格子，不再 inverse 空格紧贴「让」。`!` 前缀输入框黄边。
StatusBar 去掉模型左边的绿色 `⏺`。
