# FloatBoat 竞品分析 — 对 Code Agent 的借鉴

> 来源：十字路口 Crossing 首发实测文章 (2026-03-17) + FloatBoat 官网 + GitHub 开源协议
> 记录时间：2026-03-18

## FloatBoat 是什么

FloatBoat 定位为 **AI 原生工作环境**（非 ChatBot、非自动化工具），面向一人公司/OPC 场景。红杉和微光创投的种子轮。核心理念：消除"上下文搬运成本"。

两个基础原则：
- **All for One**：所有信息（网页、本地文件、云盘、微信、Safari）流入统一界面
- **One for All**：产出内容可持续流转，作为新上下文使用

## 核心功能

1. **多面板工作空间**：最多 4 栏并排（Chat + File Manager + Browser + Combo Skills），标签页式交互，拖拽传递上下文
2. **Combo Skills**：从多轮对话自动固化为可复用 SOP，支持从 GitHub/Dify/Coze/n8n 导入，Combo Store 商店生态
3. **内置浏览器**：可打开任意网站并自动化操作，支持 Chrome 扩展接入，内置截图功能
4. **Memo 菜单栏**：从任意 App 拖内容到 Memo → 触发 Skills 执行
5. **Claw 模式**：集成飞书/Telegram，手机发指令 → 电脑端 Agent 执行
6. **macOS 原生集成**：直接调用备忘录、Excel、Numbers 等本地应用

## 开源协议

- **Selfware Protocol** (GitHub: floatboatai/selfware.md)："Agent 时代的集装箱"，.self 文件自带数据+逻辑+视图。四原则：Canonical Data Authority / Write Scope Boundary / No Silent Apply / View as Function
- **IACT Protocol** (GitHub: floatboatai/iact)：`[显示文本](!directive)` 语法，将 AI 回复选项变为可点击按钮。`!send` 直接发送，`!add` 填入输入框可编辑

## 对 Code Agent 的借鉴优先级

### P0 — 下个迭代

| 借鉴点 | 具体方案 | 实现位置 |
|--------|--------|---------|
| **IACT 内联交互** | Markdown 渲染层拦截 `!` 开头链接，`!send` 直接发送、`!add` 填入输入框 | TurnBasedTraceView.tsx |
| **拖拽文件到对话** | Tauri `on_file_drop_event` → 自动读取文件内容作为上下文 | Tauri 事件 + IPC |

### P1 — 规划中

| 借鉴点 | 具体方案 |
|--------|--------|
| **分屏 Chat + 文件浏览** | React split-pane，左 Chat + 右文件预览/代码编辑 |
| **Combo Skills 录制** | 从 tool call trace 提取 DAG，参数化可变部分，生成 SKILL.md |
| **Memo 全局热键** | Tauri system_tray + global shortcut (Cmd+Shift+C) |

### P2 — 远期

| 借鉴点 | 具体方案 |
|--------|--------|
| **内置浏览器面板** | WebView 面板，编码→预览→截图验证闭环 |
| **macOS 原生深度集成** | Finder 右键菜单、Spotlight 集成 |
| **Claw 远程控制** | Telegram Bot → Code Agent 本地实例 → 结果回传 |

## 关键产品观点

- **"Agent 应该活在用户的工作环境里，而不是住在一个聊天框里"** — 桌面应用天然具备这个能力
- **"从 Software 到 Selfware，工具不应该写给所有人，应该属于使用它的那个人"** — Code Agent 的 CLAUDE.md + Memory + Skill 就是 Selfware 的编程版
- **"方向对了，粗糙度是可以磨的"** — 先做通信息流转，再迭代打磨
- **"操作节点很少"是好体验的衡量标准** — 用户完成任务所需的实际操作步骤数

## 与 Code Agent 现有能力对照

| FloatBoat 能力 | Code Agent 现状 | 差距 |
|--------------|---------------|-----|
| 4 栏工作空间 | 单面板 Chat + Trace View | 大 |
| 拖拽传递上下文 | 手动指定文件路径 | 大 |
| IACT 可点击选项 | 纯文本回复 | 中（纯前端改动） |
| Combo Skills 自动录制 | Skill 系统存在但手写 | 中 |
| Memo 菜单栏 | 无全局入口 | 中 |
| 内置浏览器 | /e2e 外部浏览器 | 中 |
| macOS 原生调用 | Cron Center 已有基础 | 小 |
| Claw IM 控制 | 龙虾已有飞书/Telegram | 小（已有类似方案） |
