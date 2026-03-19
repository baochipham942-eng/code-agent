# FloatBoat 启发特性实施方案

> 基于 Code Agent 当前架构的具体实现规划
> 创建时间：2026-03-18

## 现状盘点

| 能力 | 状态 | 位置 |
|------|------|------|
| IACT `!send` / `!add` | **已实现** | MessageContent.tsx:639-692, ChatInput:91-112 |
| 文件拖拽到对话 | **已实现** | ChatView.tsx:209-279, useFileUpload hook |
| 右侧面板（Task/Skills/Preview） | **已实现** | App.tsx:428-446, 固定宽度 |
| HTML 文件预览 | **已实现** | PreviewPanel.tsx, iframe 渲染 |
| Skill 系统 | **已实现** | skillDiscoveryService + skillMetaTool |
| 桌面活动采集 | **已实现** | native_desktop.rs (截图/前台App/空闲检测) |
| System Tray | **已实现** | main.rs:setup_tray(), MemoFloater.tsx |
| 全局快捷键 | **已实现** | main.rs:setup_global_shortcut() (Cmd+Shift+A) |
| 可调节分屏 | **已实现** | App.tsx (react-resizable-panels PanelGroup) |
| 文件浏览器面板 | **已实现** | FileExplorerPanel.tsx + explorerStore.ts |
| Combo Skills 录制 | **已实现** | comboRecorder.ts + ComboSkillCard.tsx |
| Memo 浮窗 | **已实现** | MemoFloater.tsx (iact:send + sessionStore) |
| 交互式电子表格 | **已实现** | SpreadsheetBlock.tsx (列选中/操作栏/Agent 联动) |

---

## Phase 1: IACT 扩展指令 + Agent 引导

> 目标：让已有的 IACT 基础设施真正被 Agent 使用起来，并扩展更多指令

### 1.1 扩展 IACT 指令集

**当前状态**：只有 `!send` 和 `!add`
**目标**：增加编程场景高频指令

```
指令                        行为                          图标
─────────────────────────────────────────────────────────────
[text](!send)              直接发送为用户消息              Send ✓ 已有
[text](!add)               填入输入框可编辑                PenLine ✓ 已有
[text](!run)               执行 shell 命令                Terminal 新增
[path](!open)              在编辑器/Finder打开文件         ExternalLink 新增
[path](!preview)           在 PreviewPanel 预览            Eye 新增
[text](!copy)              复制到剪贴板                    Copy 新增
```

**修改文件**：`MessageContent.tsx` 的 `a()` 组件

```typescript
// IACT: [command](!run) — 执行 shell 命令
if (href === '!run') {
  return (
    <button onClick={() => window.dispatchEvent(
      new CustomEvent('iact:send', { detail: `!${text}` })  // !前缀触发 shell 执行
    )}
    className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all cursor-pointer text-sm font-medium"
    title="点击执行命令"
    >
      <Terminal className="w-3 h-3 opacity-60" />
      {children}
    </button>
  );
}

// IACT: [filepath](!open) — 打开文件
if (href === '!open') {
  return (
    <button onClick={() => ipcService.invoke('workspace', 'openPath', { path: text })}
    className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 transition-all cursor-pointer text-sm font-medium"
    title="打开文件"
    >
      <ExternalLink className="w-3 h-3 opacity-60" />
      {children}
    </button>
  );
}

// IACT: [filepath](!preview) — 预览面板打开
if (href === '!preview') {
  return (
    <button onClick={() => {
      useAppStore.getState().setPreviewFilePath(text);
      useAppStore.getState().setShowPreviewPanel(true);
    }}
    className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 border border-violet-500/20 transition-all cursor-pointer text-sm font-medium"
    title="预览文件"
    >
      <Eye className="w-3 h-3 opacity-60" />
      {children}
    </button>
  );
}

// IACT: [text](!copy) — 复制到剪贴板
if (href === '!copy') {
  return (
    <button onClick={() => navigator.clipboard.writeText(text)}
    className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-zinc-500/10 text-zinc-400 hover:bg-zinc-500/20 border border-zinc-500/20 transition-all cursor-pointer text-sm font-medium"
    title="复制到剪贴板"
    >
      {children}
      <Copy className="w-3 h-3 opacity-60" />
    </button>
  );
}

// 通用扩展：!directive:param 格式
if (href?.startsWith('!')) {
  const [directive, ...paramParts] = href.slice(1).split(':');
  const param = paramParts.join(':');
  window.dispatchEvent(new CustomEvent(`iact:${directive}`, {
    detail: { text, param }
  }));
}
```

### 1.2 Agent 侧：引导模型输出 IACT 标记

**问题**：IACT 前端已就绪，但 Agent 不知道要用这个格式回复。

**方案**：在系统提示词 (system instructions) 中加入 IACT 引导：

```
修改位置：src/main/agent/prompts/ 或 contextBuilder 中注入

## 交互式回复指南

当给用户提供可操作的选项时，使用 IACT 内联交互格式：
- 需要用户确认的操作：`[操作描述](!send)`
- 需要用户补充信息的：`[预填文本](!add)`
- 可以直接执行的命令：`[npm run typecheck](!run)`
- 文件路径引用：`[src/main/index.ts](!open)`

示例：
  "类型检查发现 3 个错误。[帮我修复](!send) 或 [查看完整报错](!add)"
  "修复完成。[运行 typecheck 验证](!run) 或 [打开修改的文件](!open)"

只在有明确可操作项时使用，不要过度使用。
```

**关键决策**：这段引导是放在 system prompt 里还是作为 contextModifier？
- 建议作为 **contextModifier**，通过 `src/main/agent/context/` 注入
- 这样可以按需开关，不污染核心 system prompt

### 1.3 验证方案

```bash
# 在 Agent 对话中测试
用户: 帮我检查下类型错误
期望 Agent 回复包含: [npm run typecheck](!run)
点击按钮 → 应自动执行命令
```

---

## Phase 2: 可调节分屏 + 文件浏览器面板

> 目标：从固定宽度面板升级为可拖拽调节的多面板布局，增加文件浏览器

### 2.1 引入 ResizablePanel 组件

**当前问题**：TaskPanel 320px 固定，PreviewPanel 500px 固定，不可调节。

**技术选型**：`react-resizable-panels`（npm，轻量无依赖，支持拖拽分隔线）

**修改 App.tsx 布局**：

```tsx
// Before (当前):
<div className="flex-1 flex overflow-hidden">
  <div className="flex-1 flex flex-col min-w-0 bg-zinc-900">
    <ChatView />
  </div>
  {showTaskPanel && <TaskPanel />}
</div>

// After (改造后):
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';

<PanelGroup direction="horizontal" className="flex-1 overflow-hidden">
  {/* 左侧文件浏览器（可选） */}
  {showFileExplorer && (
    <>
      <Panel defaultSize={20} minSize={15} maxSize={35}>
        <FileExplorerPanel />
      </Panel>
      <PanelResizeHandle className="w-1 hover:w-1.5 bg-zinc-800 hover:bg-primary-500/50 transition-all cursor-col-resize" />
    </>
  )}

  {/* 中间 Chat 区域 */}
  <Panel defaultSize={60} minSize={30}>
    <div className="flex flex-col h-full bg-zinc-900">
      <ChatView />
    </div>
  </Panel>

  {/* 右侧面板区域 */}
  {(showTaskPanel || showPreviewPanel || showSkillsPanel) && (
    <>
      <PanelResizeHandle className="w-1 hover:w-1.5 bg-zinc-800 hover:bg-primary-500/50 transition-all cursor-col-resize" />
      <Panel defaultSize={25} minSize={15} maxSize={45}>
        {showTaskPanel && <TaskPanel />}
        {showPreviewPanel && <PreviewPanel />}
        {showSkillsPanel && <SkillsPanel />}
      </Panel>
    </>
  )}
</PanelGroup>
```

### 2.2 文件浏览器面板 (FileExplorerPanel)

**新建**：`src/renderer/components/features/explorer/FileExplorerPanel.tsx`

**核心功能**：
1. 树形文件浏览（递归加载目录）
2. 多标签页（同时浏览多个目录，参考 FloatBoat）
3. 文件类型图标
4. 右键菜单：打开 / 作为上下文添加到对话 / 在 Finder 中显示
5. **拖拽到 Chat**：选中文件 → 拖入 Chat 区域 → 自动附加为上下文

**数据源**：复用现有 IPC
- `workspace:readDirectory` — 读取目录内容
- `workspace:readFile` — 读取文件内容
- `workspace:openPath` — 在系统中打开

**状态管理**：新建 `explorerStore.ts`

```typescript
interface ExplorerStore {
  // 多标签
  tabs: ExplorerTab[];
  activeTabId: string;

  // 当前选中
  selectedPaths: string[];

  // 操作
  addTab: (path: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  toggleSelection: (path: string) => void;
}

interface ExplorerTab {
  id: string;
  rootPath: string;
  label: string;      // 目录名
  expandedPaths: Set<string>;
}
```

### 2.3 拖拽增强：文件浏览器 → Chat

**当前**：只支持从系统 Finder 拖文件。
**增强**：从内置文件浏览器拖拽，支持：
- 单个文件 → MessageAttachment
- 多个文件 → 批量附件
- 文件夹 → 递归读取内容

实现方式：内部拖拽用 `React DnD` 或自定义 `draggable` 属性，通过 CustomEvent 传递文件路径。

---

## Phase 3: Combo Skills — 从对话自动录制工作流

> 目标：让用户可以一键将当前对话固化为可复用的 Skill

### 3.1 Tool Trace 录制器

**新建**：`src/main/services/skills/comboRecorder.ts`

```typescript
interface ComboStep {
  toolName: string;
  inputSummary: string;     // 参数摘要（脱敏）
  outputSummary: string;    // 结果摘要
  isParameterizable: boolean; // 是否可参数化（如文件路径）
  parameterHints: string[];   // 可参数化的字段名
}

interface ComboRecording {
  sessionId: string;
  turns: Array<{
    userIntent: string;       // 用户消息摘要
    steps: ComboStep[];
  }>;
  suggestedName: string;      // AI 建议的 Skill 名称
  suggestedDescription: string;
}

class ComboRecorder {
  private recording: ComboRecording;

  // 在 toolExecutionEngine 的 post-tool hook 中调用
  recordStep(toolCall: ToolCall, result: ToolResult): void;

  // 生成 Skill 定义
  async generateSkillDefinition(): Promise<ParsedSkill>;

  // 保存到用户 Skills 目录
  async saveAsSkill(name: string): Promise<string>;
}
```

### 3.2 录制触发与 UI

**方案 A**（推荐）：对话结束后智能建议

```
在 toolExecutionEngine.ts 的 post-turn 阶段：

if (recording.turns.length >= 3 && hasRepeatingPattern(recording)) {
  // 通过 agent:event 发送建议到前端
  emitEvent('combo_skill_suggestion', {
    name: recording.suggestedName,
    steps: recording.turns.length,
    description: recording.suggestedDescription
  });
}
```

前端在 ChatInput 下方渲染建议卡片：

```tsx
// ComboSkillSuggestion.tsx
<div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
  <Sparkles className="w-4 h-4 text-amber-400" />
  <span className="text-sm text-amber-300">
    这个工作流可以保存为 Combo Skill
  </span>
  <button onClick={onSave} className="text-xs px-2 py-1 bg-amber-500/20 rounded">
    [保存为 "{suggestedName}"](!send)
  </button>
  <button onClick={onDismiss} className="text-xs text-zinc-500">忽略</button>
</div>
```

**方案 B**：手动触发按钮

在 Chat 界面底部增加 "录制为 Skill" 按钮，点击后分析当前对话的所有 tool call trace。

### 3.3 生成的 Skill 格式

```yaml
# SKILL.md (自动生成)
---
name: typescript-debug-fix
description: "分析 TypeScript 类型错误，修复代码，运行验证"
execution-context: inline
allowed-tools:
  - bash
  - read_file
  - edit_file
combo-meta:
  source: auto-recorded
  session: abc123
  recorded-at: 2026-03-18
  steps: 5
  parameters:
    - name: error_pattern
      description: "要搜索的错误模式"
      default: "error TS"
    - name: file_scope
      description: "搜索范围"
      default: "src/"
---

## 工作流步骤

1. 搜索 TypeScript 编译错误
2. 读取相关源文件
3. 分析错误原因并修复
4. 运行 `npm run typecheck` 验证
5. 如果仍有错误，重复步骤 2-4

## 参数

- `$ERROR_PATTERN`: {{error_pattern}}
- `$FILE_SCOPE`: {{file_scope}}
```

### 3.4 Combo Store（远期）

借鉴 FloatBoat 的 Combo Store，支持：
- 从 GitHub 仓库安装 Skill（已有 skillRepositories.ts 基础）
- Skill 版本管理
- 使用频率统计（推荐排序）

---

## Phase 4: Memo 全局热键 + System Tray

> 目标：从任意 App 快速将内容发送到 Code Agent

### 4.1 Tauri System Tray

**修改**：`src-tauri/src/main.rs`

```rust
use tauri::SystemTray;
use tauri::SystemTrayMenu;
use tauri::CustomMenuItem;

fn main() {
    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("new_chat", "新建对话"))
        .add_item(CustomMenuItem::new("paste_context", "粘贴为上下文"))
        .add_separator()
        .add_item(CustomMenuItem::new("recent_skills", "最近技能").disabled())
        .add_separator()
        .add_item(CustomMenuItem::new("quit", "退出"));

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| {
            match event {
                SystemTrayEvent::MenuItemClick { id, .. } => {
                    match id.as_str() {
                        "paste_context" => {
                            // 读取剪贴板 → 发送到当前会话
                            let clipboard = app.clipboard_manager();
                            if let Ok(Some(text)) = clipboard.read_text() {
                                app.emit_all("memo:paste", text).ok();
                            }
                        }
                        "new_chat" => {
                            // 激活窗口 + 新建会话
                            if let Some(window) = app.get_window("main") {
                                window.show().ok();
                                window.set_focus().ok();
                            }
                            app.emit_all("memo:new_chat", ()).ok();
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        })
        .build()
}
```

### 4.2 全局快捷键

```rust
use tauri::GlobalShortcutManager;

// 在 setup 中注册
app.global_shortcut_manager()
    .register("CmdOrCtrl+Shift+A", move |_| {
        // 1. 显示浮窗 (或激活主窗口)
        // 2. 读取剪贴板内容
        // 3. 聚焦输入框，预填剪贴板内容
    });
```

### 4.3 前端 Memo 浮窗

**新建**：`src/renderer/components/MemoFloater.tsx`

```tsx
// 轻量浮窗，全局热键唤起
// - 输入框 + 发送按钮
// - 粘贴的内容自动附加为上下文
// - 支持拖拽文件到浮窗
// - 最近 5 个 Skill 快速调用
```

---

## Phase 5: 内置浏览器 + Claw 远程

### 5.1 内置浏览器面板

**基于现有 PreviewPanel 扩展**：

```
当前 PreviewPanel:
  - 只能预览 HTML 文件
  - iframe 渲染
  - 500px 固定

升级为 BrowserPanel:
  - URL 地址栏（可输入任意 URL）
  - 前进/后退/刷新
  - 截图按钮（调用 native_desktop.rs 的截图能力）
  - 抓取页面内容到对话（readability 提取正文）
  - 支持打开 localhost:* 本地服务（前端开发预览）
```

### 5.2 Claw 远程控制

**架构**：Telegram Bot → WebSocket Server (Tauri) → IPC → Agent

```
src-tauri/src/claw.rs:

pub struct ClawServer {
    // WebSocket 监听
    // 认证：预共享密钥
    // 命令映射：text → domain:agent send
    // 结果回传：agent:event → WebSocket push
}
```

与龙虾的区别：
- 龙虾是远程 VPS 上的独立 Agent
- Claw 是本地 Code Agent 的远程入口
- 可以协同：手机 → Telegram → 龙虾转发 → Code Agent Claw

---

## 实施进度

```
Phase 1 ✅ 已完成 (2026-03-18):
  ├── 1.1 IACT 扩展指令 (!run, !open, !preview, !copy)
  ├── 1.2 Agent 引导 (contextModifier)
  └── 1.3 验证

Phase 2 ✅ 已完成 (2026-03-18):
  ├── 2.1 ResizablePanel (react-resizable-panels: Group/Panel/Separator)
  ├── 2.2 FileExplorerPanel + explorerStore
  └── 2.3 拖拽到 Chat（sendToChat CustomEvent）

Phase 3 ✅ 已完成 (2026-03-18):
  ├── 3.1 ComboRecorder 服务 (EventBus 订阅 agent:tool_call_end)
  ├── 3.2 前端建议 UI (ComboSkillCard, amber 主题)
  └── 3.3 Skill 生成与保存 (SKILL.md YAML frontmatter)

Phase 4 ✅ 已完成 (2026-03-19):
  ├── 4.1 System Tray (MenuBuilder + TrayIconBuilder)
  ├── 4.2 全局快捷键 (Cmd+Shift+A, tauri-plugin-global-shortcut)
  └── 4.3 Memo 浮窗 (MemoFloater, iact:send 复用)

Phase 5 🔲 未开始:
  ├── 5.1 BrowserPanel
  └── 5.2 Claw Server
```

## 风险与注意事项

1. **react-resizable-panels** 与 Tauri WebView 的兼容性需验证
2. FileExplorerPanel 的大目录性能（需虚拟列表）
3. ComboRecorder 的隐私问题（tool call 可能包含敏感内容，参数需脱敏）
4. System Tray 图标需要适配 macOS/Windows 不同尺寸
5. Claw WebSocket 的安全性（必须有认证，不能裸露端口）
6. IACT `!run` 指令的安全性（不应绕过 tool approval 机制）
