# 前端架构

> Tauri 2.x + React 18 + Zustand + Tailwind CSS

## 平台

桌面端基于 **Tauri 2.x**（Rust），替代早期的 Electron 方案。Tauri 壳层（`src-tauri/src/main.rs`）负责：

- 启动 Node.js Web Server 子进程
- System Tray 菜单（新建对话 / 粘贴上下文 / 退出）
- 全局快捷键 `Cmd+Shift+A` → 唤起窗口 + 触发 MemoFloater
- 通过 Tauri 事件总线（`memo:activate`、`memo:new_chat`、`memo:paste_context`）与前端通信

---

## 整体布局

```
┌─────────────────────────────────────────────────┐
│  TitleBar                                       │
├──────┬──────────────────────────┬───────────────┤
│      │  ChatView                │               │
│ Side │  ┌─ ChatSearchBar ─────┐ │  FileExplorer │
│ bar  │  │ TurnBasedTraceView  │ │  Panel /      │
│      │  │  └─ TurnCard[]      │ │  PreviewPanel │
│      │  │                     │ │               │
│      │  ├─ ContextIndicator ──┤ │               │
│      │  └─ ChatInput ────────┘ │               │
├──────┴──────────────────────────┴───────────────┤
│  StatusBar                                      │
└─────────────────────────────────────────────────┘
MemoFloater（全局浮窗，Cmd+Shift+A 唤起）
```

布局使用 `react-resizable-panels` 实现可拖拽的多栏分割。

---

## 核心数据流：Turn-Based Trace

消息渲染已从扁平消息列表切换为 **Turn-based Trace 视图**：

```
messages[] ──useTurnProjection──▸ TraceProjection { turns[], activeTurnIndex }
                                      │
                              TurnBasedTraceView
                                      │
                              TurnCard[] ──▸ TraceNodeRenderer
                                               ├─ MessageContent（Markdown）
                                               ├─ ToolCallDisplay
                                               ├─ PermissionCard（内联）
                                               └─ InlinePlanCard
```

| 层级 | 文件 | 职责 |
|------|------|------|
| Hook | `hooks/useTurnProjection.ts` | 纯 `useMemo` 派生：将 `Message[]` 投影为 `TraceTurn[]`，按 user→assistant 轮次分组 |
| 容器 | `chat/TurnBasedTraceView.tsx` | 渲染 Turn 列表、自动滚底、加载历史消息、搜索高亮 |
| 卡片 | `chat/TurnCard.tsx` | 单个 Turn 的卡片，包含 TraceNode 渲染器 |
| 节点 | `chat/TraceNodeRenderer.tsx` | 根据 TraceNode 类型分发到不同子组件 |

---

## 关键组件

### 消息气泡 (MessageBubble)

`features/chat/MessageBubble/` 目录：

| 组件 | 文件 | 职责 |
|------|------|------|
| **MessageContent** | `MessageContent.tsx` | Markdown 渲染（react-markdown + remark-gfm/math + rehype-katex），代码块路由 |
| **ToolCallDisplay** | `ToolCallDisplay/` | 工具调用折叠面板（含 ResultSummary、ToolCallGroup） |
| **AttachmentPreview** | `AttachmentPreview.tsx` | 消息附件展示（图片/PDF/代码/数据/文件夹），内嵌 SpreadsheetBlock/DocumentBlock |
| **CoworkMessageBubble** | `CoworkMessageBubble.tsx` | 多 Agent 协作消息 |
| **SkillStatusMessage** | `SkillStatusMessage.tsx` | Skill 执行状态消息 |

### Generative UI（富内容渲染）

MessageContent 通过 markdown 代码块的语言标签路由到不同渲染组件：

```
```chart          → ChartBlock
```generative_ui → GenerativeUIBlock
```spreadsheet   → SpreadsheetBlock
```document      → DocumentBlock
```mermaid       → MermaidDiagram
```

| 组件 | 文件 | 说明 |
|------|------|------|
| **ChartBlock** | `ChartBlock.tsx` | 基于 Recharts，支持 6 种图表（bar/line/area/pie/radar/scatter），暗色主题，JSON spec 驱动 |
| **GenerativeUIBlock** | `GenerativeUIBlock.tsx` | 沙箱 iframe 渲染 AI 生成的 HTML 小程序，自动注入暗色样式，postMessage 动态调整高度 |
| **SpreadsheetBlock** | `SpreadsheetBlock.tsx` | 交互式表格查看器，多 Sheet 切换，列选中，支持排序/筛选 |
| **DocumentBlock** | `DocumentBlock.tsx` | 文档查看器，段落选中 + 操作栏（复制/编辑/删除），支持 Word 附件（mammoth HTML）和 JSON spec |

### ChatInput 输入系统

`features/chat/ChatInput/` 目录：

| 组件 | 职责 |
|------|------|
| **index.tsx** | 主输入框容器，组合子组件 |
| **InputArea** | 文本输入区域 |
| **AttachmentBar** | 已添加附件的预览条（支持文件/文件夹/图片/代码等分类图标） |
| **useFileUpload** | 文件上传 hook（拖拽 + 按钮），解析为 `MessageAttachment` |
| **SlashCommandPopover** | 输入 `/` 时弹出的内联命令面板（替代全屏 CommandPalette） |
| **ComboSkillCard** | Combo Skill 录制建议卡片 — 检测到可重复工作流时在输入框上方建议保存 |
| **ModeSwitch** | 模式切换 |
| **VoiceInputButton** | 语音输入按钮 |
| **SendButton** | 发送按钮 |
| **ReportStyleSelector** | 报告样式选择器 |
| **SuggestionBar** | 建议栏 |

### 附件系统

文件上传到消息展示的完整链路：

```
用户拖拽/选择文件
    → useFileUpload（解析文件类型、分类）
    → AttachmentBar（输入框上方预览）
    → 发送消息（MessageAttachment[]）
    → AttachmentPreview（消息气泡内展示）
        ├─ 图片 → 内联预览
        ├─ Excel → SpreadsheetBlock
        ├─ Word → DocumentBlock
        └─ 其他 → 文件卡片
```

### 聊天搜索 (ChatSearchBar)

`features/chat/ChatSearchBar.tsx` — 会话内消息搜索（`Cmd/Ctrl+F`）：
- 基于 `TraceProjection` 搜索所有 Turn/Node 内容
- 匹配结果高亮 + 上下翻页导航
- 通过回调通知 ChatView 滚动到匹配位置

### 上下文指示器 (ContextIndicator)

`features/chat/ContextIndicator.tsx` — 输入框上方的紧凑 token 用量条：
- 从 `appStore.contextHealth` 读取数据
- 仅在用量 > 50% 时显示
- 三级颜色：绿（正常）/ 黄（warning）/ 红（critical）

---

## 文件浏览器 (FileExplorer)

| 文件 | 职责 |
|------|------|
| `features/explorer/FileExplorerPanel.tsx` | 文件树 UI，多 Tab 支持，文件类型图标，通过 IPC 调用 `workspace.listFiles` |
| `stores/explorerStore.ts` | Zustand Store：Tab 管理、目录缓存（`dirContents`）、展开/折叠状态、文件选中 |

面板显示由 `appStore.showFileExplorer` 控制，与 ChatView 并列在右侧栏。

---

## 备忘浮窗 (MemoFloater)

`features/memo/MemoFloater.tsx` — 全局热键唤起的快速输入浮窗：

- 监听 Tauri 事件：`memo:activate`（显示浮窗）、`memo:new_chat`（新建对话）、`memo:paste_context`（粘贴剪贴板为上下文）
- 发送消息通过 `iact:send` 自定义事件，创建会话通过 `sessionStore`
- 仅在 Tauri 模式下激活

---

## 状态管理 (Zustand)

```
stores/
├── sessionStore.ts      # 会话状态（messages, currentSession, 历史消息加载）
├── appStore.ts          # 全局 UI 状态（isProcessing, showFileExplorer, contextHealth）
├── authStore.ts         # 认证状态
├── explorerStore.ts     # 文件浏览器状态（tabs, dirContents, expanded）
├── taskStore.ts         # 任务状态
├── uiStore.ts           # UI 偏好
├── sessionUIStore.ts    # 会话 UI 状态
├── modeStore.ts         # 模式状态
├── permissionStore.ts   # 权限请求状态
├── localBridgeStore.ts  # 本地桥接状态
├── skillStore.ts        # Skill 面板状态
├── evalCenterStore.ts   # 评测中心状态
├── captureStore.ts      # 桌面捕获状态
├── swarmStore.ts        # Multi-Agent 状态
├── dagStore.ts          # 工作流 DAG 状态
├── cronStore.ts         # 定时任务状态
├── statusStore.ts       # 状态栏
├── selectionStore.ts    # 选中状态
└── telemetryStore.ts    # 遥测状态
```

---

## useAgent Hook 事件处理

```typescript
// hooks/useAgent.ts — 监听 IPC 事件: agent:event

case 'turn_start':     // 创建新的 assistant 消息
case 'stream_chunk':   // 流式追加文本到当前 turn
case 'tool_call_start':// 工具状态 → running
case 'tool_call_end':  // 通过 toolCallId 匹配，更新 result
case 'permission_request': // 显示内联 PermissionCard
case 'agent_complete':     // 解锁输入
```

---

## 文件结构

```
src/renderer/
├── App.tsx                        # 根组件，PanelGroup 布局
├── components/
│   ├── ChatView.tsx               # 主聊天视图，集成搜索/Trace/输入
│   ├── Sidebar.tsx                # 会话列表 + 搜索
│   ├── TitleBar.tsx               # 标题栏
│   ├── PreviewPanel.tsx           # 预览面板
│   ├── DiffView.tsx               # Diff 视图
│   ├── CommandPalette.tsx         # 命令面板
│   ├── StatusBar/                 # 状态栏组件组
│   ├── PermissionDialog/          # 权限卡片
│   ├── features/
│   │   ├── chat/
│   │   │   ├── TurnBasedTraceView.tsx   # Turn-based 消息列表
│   │   │   ├── TurnCard.tsx             # 单 Turn 卡片
│   │   │   ├── TraceNodeRenderer.tsx    # Trace 节点渲染器
│   │   │   ├── ChatSearchBar.tsx        # 会话搜索
│   │   │   ├── ContextIndicator.tsx     # 上下文用量指示器
│   │   │   ├── ConversationTabs.tsx     # 多 Tab 对话
│   │   │   ├── ChatInput/              # 输入系统（见上文）
│   │   │   └── MessageBubble/          # 消息气泡 + Generative UI
│   │   ├── explorer/
│   │   │   └── FileExplorerPanel.tsx    # 文件浏览器
│   │   ├── memo/
│   │   │   └── MemoFloater.tsx          # 备忘浮窗
│   │   ├── evalCenter/                  # 评测中心
│   │   ├── lab/                         # 学习实验室
│   │   ├── workflow/                    # 工作流 DAG
│   │   ├── capture/                     # 桌面捕获
│   │   ├── background/                  # 后台任务
│   │   ├── memory/                      # 记忆学习
│   │   ├── sidebar/                     # 侧边栏功能
│   │   ├── voice/                       # 语音功能
│   │   └── settings/                    # 设置面板
│   │
│   ├── composites/                # 复合组件
│   └── citations/                 # 引用展示
│
├── hooks/
│   ├── useAgent.ts                # Agent 通信 Hook
│   ├── useTurnProjection.ts       # Message[] → TraceTurn[] 投影
│   ├── useKeyboardShortcuts.ts    # 全局快捷键
│   ├── useFileAutocomplete.ts     # 文件路径自动补全
│   ├── useVoiceInput.ts           # 语音输入
│   ├── useMemoryEvents.ts         # 记忆事件
│   ├── useTheme.ts                # 主题
│   ├── useRequireAuth.ts          # 登录拦截
│   └── ...
│
├── stores/                        # Zustand 状态（见上文）
├── contexts/                      # React Context（ConversationTabs）
├── services/                      # IPC 服务
└── utils/                         # 工具函数（platform, logger, resolveFileUrl）
```
