# Alma Hotkeys / Keyboard Shortcuts 配置对标

日期：2026-06-14
范围：只研究热键、快捷键、快捷键设置的信息架构和默认策略，不包含产品功能开发。
分支：`codex/alma-hotkeys-visible`

## 证据边界

用户给的 0.0.805 -> 0.0.823 对照资料在当前环境缺失：

- `/tmp/alma-update-20260613/release-notes-805-823.md`
- `/tmp/alma-update-20260613/old/extract/renderer-assets/index-DZO6LH4W.js`
- `/tmp/alma-update-20260613/new/extract/renderer-assets/index-lrtJ1hZ1.js`
- `/tmp/alma-update-20260613/old/extract/index.js`
- `/tmp/alma-update-20260613/new/extract/index.js`

因此这份研究不声称已经完成 0.0.805 到 0.0.823 的逐版本 diff。已核验的是当前安装的 `/Applications/Alma.app`，`Info.plist` 显示版本为 `0.0.823`，并从 `app.asar` 提取当前 bundle 到 `/tmp/alma-current-extract/`。Alma 侧结论来自：

- `/tmp/alma-current-extract/out/main/index.js`
- `/tmp/alma-current-extract/out/renderer/assets/index-lrtJ1hZ1.js`
- `/tmp/alma-current-extract/out/renderer/assets/settings-DC3FW4eN.js`
- `/tmp/alma-current-extract/out/renderer/assets/useLiveCoding-BZdZI9IU.js`

code-agent 侧重新核验了 renderer hook、设置页、命令面板、会话输入框、Tauri 主进程全局热键、Appshots 原生监听、voice paste IPC、工作台与交付物相关入口。

## 核心结论

Alma 的强点体现在热键的产品结构：全局唤起、会话内操作、输入辅助、高级能力各自有边界；普通快捷键来自 `settings.keybindings`，全局能力由主进程真实注册，界面上用设置页、tooltip、命令入口和录入控件保证可发现、可修改、可恢复。

code-agent 当前能力更丰富，但热键组织仍偏技术模块散落：`useKeyboardShortcuts`、`CommandPalette`、`ChatInput`、`ChatView`、Tauri `global_shortcut`、Appshots 原生 event tap、voice paste IPC 各自定义一部分行为。用户看不到一张统一快捷键地图，也不能配置、搜索、重置或检查冲突。几个默认键风险偏高，尤其是 `Cmd/Ctrl+K` 清空当前对话、`Cmd/Ctrl+B` 把运行会话移至后台、`Cmd/Ctrl+Shift+C` 触发 compact。

建议优先做“热键设置与注册体系”。继续给单点功能补快捷键，收益会被不可发现、不可配置和冲突问题吃掉。P0 应该把现有热键收进 action registry、设置 schema、冲突检测和分组设置页；P1 再扩到全局 Quick Ask、语音、Appshots、Artifacts、Browser/Computer Use 等能力。

## Alma 当前热键清单

| 层级 | 动作 | 默认或来源 | 是否可配置 | 证据 | 产品含义 |
| --- | --- | --- | --- | --- | --- |
| 全局唤起 | Quick Chat | macOS `Cmd+Shift+Space`，其他平台 `Ctrl+Shift+Space` | 是，`settings.keybindings.quickChat` 会同步到 quick chat window | main bundle 里 `function BA(){return "darwin"===process.platform?"Command+Shift+Space":"Ctrl+Shift+Space"}`；`function UA(e)` 通过 Electron `globalShortcut.register` 注册；renderer 默认 `quickChat` 同值 | 这是 Alma 最核心的随时唤起入口。触发后在已有 Quick Chat 窗口上 show/hide/focus，click-through 状态下会恢复可交互并聚焦输入 |
| 全局唤起 | Prompt App 快速启动 | 每个 Prompt App 自己设置 shortcut，无内置固定默认值 | 是，编辑器里有 `Global Shortcut` 录入框 | main bundle `function jA(e,t)` 对 prompt app shortcut 调用 `globalShortcut.register`；renderer Prompt App editor 有 `handleShortcutKeyDown`、`Press keys...`、`Click to set`、Backspace 清空提示 | 把“用户自定义工作流”也放进全局热键，不只服务系统内置动作 |
| 全局输入辅助 | Appshots / 截图问答 | 当前证据确认有持久化 hotkey，默认值未从当前 0.0.823 bundle 明确确认 | 是，主进程支持 `appshot:set-hotkey` | main bundle `getState()` 返回 `configuredHotkey`；`setHotkey(e)` 启动 Alma Computer Use helper 的 monitor；启动时从 `settings.appshots.hotkey` restore | 属于跨 app 捕获上下文。Alma 把截图、AX 文本、前台 app 语义作为输入增强，形态上更接近上下文采集能力 |
| 会话内操作 | New Chat / New Thread | macOS `Cmd+N`，其他平台 `Ctrl+N` | 是，`settings.keybindings.newChatThread` | renderer `getPlatformDefaultKeybindings`；`KeybindingManager.registerFromSettings` dispatch `app:newChatThread` | 高频会话动作，默认启用且和系统新建语义一致 |
| 会话内操作 | Search Threads | macOS `Cmd+F`，其他平台 `Ctrl+F` | 是，`settings.keybindings.searchThreads` | renderer default；`registerFromSettings` dispatch `app:openSearchModal` | Alma 让搜索成为会话导航的一等入口 |
| 内容输入 | Send Message | `Enter` | 是，`settings.keybindings.sendMessage` | renderer default；`registerFromSettings` dispatch `app:sendMessage` | 输入框动作也纳入 keybindings，减少 textarea 私有逻辑 |
| 设置 | Open Settings | macOS `Cmd+,`，其他平台 `Ctrl+,` | 是 | renderer default；dispatch `app:openSettings` | 遵循 macOS 设置入口惯例 |
| 视图 | Toggle Sidebar | macOS `Cmd+B`，其他平台 `Ctrl+B` | 是 | renderer default；dispatch `app:toggleSidebar` | 当前窗口内布局动作，不属于全局热键 |
| 内容输入辅助 | Toggle Whisper / Voice | macOS `Cmd+Shift+V`，其他平台 `Ctrl+Shift+V` | 是 | renderer default；dispatch `app:toggleWhisper`；SpeechInputAction tooltip 使用 `formatKeybinding(settings.keybindings.toggleWhisper)` | 语音输入被当成 composer 辅助能力，提示跟随按钮出现 |
| 会话导航 | Next Thread / Previous Thread | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 是 | renderer default；`registerFromSettings` 分发 next/previous thread 事件 | 类似浏览器 tab 切换，适合跨会话浏览 |
| 命令与设置发现 | Keybindings settings / command palette deep item | 未发现独立默认热键；可从设置搜索和命令入口进入 | 设置项本身可搜索 | settings nav 包含 `keybindings` tab，keywords 包含 `keybindings`、`keyboard`、`shortcuts`、`hotkeys`；command palette 有 `deep:keybindings.shortcuts` | Alma 把“快捷键配置”本身做成可被搜索到的设置能力 |
| Slash / command | SlashCommand 工具与命令系统 | 输入 `/` 或相关工具命令 | 未发现单独全局默认热键 | main/renderer bundle 出现 `SlashCommand`、plugin command IPC 等；未发现直接绑定快捷键 | slash 是输入语法，不占用全局快捷键 |
| Artifacts | Copy / download / fullscreen / close 等面板动作 | 未发现默认快捷键 | 未确认 | renderer 有 `ArtifactPanelProvider`、artifact 面板按钮和 tooltip；未发现 keybinding 注册 | Alma 没急着给交付物面板塞默认键，避免过早占用组合键 |
| 插件 / 渠道 | plugin commands、Prompt Apps | Prompt App 可有全局 shortcut；普通 plugin command 未发现默认热键 | Prompt App 可配置 | main 有 plugin command IPC、Prompt App shortcut 注册 | 高级能力通过命令/配置暴露，只有用户明确选中的 Prompt App 才进入全局热键 |
| 开发者能力 | Dev notification shortcut | `CommandOrControl+Shift+T`，仅开发模式 | 通过 env 关闭或替换 | main notification service `registerDevShortcut()`，packaged app 不注册 | 这是调试入口，不应进入用户快捷键文档 |

## Alma 的设计思路

Alma 把热键分成四层：

1. 全局唤起：Quick Chat、Prompt App、Appshots。它们跨窗口、跨 app，需要主进程或 helper 真实注册，并且在 UI 里可配置。
2. 当前会话内操作：New Chat、Search Threads、Open Settings、Toggle Sidebar、Thread navigation。这些动作只在 Alma 前台工作，由 renderer `KeybindingManager` 处理。
3. 内容输入辅助：Send、Whisper、slash、Appshots 注入上下文。它们贴近 composer，tooltip 或输入提示应该在用户正在打字的位置出现。
4. 高级与开发者能力：Prompt Apps、plugin command、dev shortcut。Alma 对这层更克制，默认不抢键位，只有用户主动配置或开发环境才启用。

几个细节值得借鉴：

- 默认值按平台生成。`getPlatformDefaultKeybindings(platform)` 先区分 macOS 和其他平台，再统一写入 settings。
- 普通快捷键进入 settings schema。`settings.keybindings` 覆盖 new chat、quick chat、search、send、settings、sidebar、voice、thread nav。
- 全局热键有主进程闭环。Quick Chat 和 Prompt App 走 Electron `globalShortcut.register`，没有只靠 renderer `keydown`。
- 录入控件有基础约束。Prompt App 的录入框要求带 modifier，Escape 取消，Backspace/Delete 清空，避免用户录入裸字母造成系统级误触。
- 快捷键提示出现在动作旁边。Quick Chat、New Chat、Whisper、命令列表、设置搜索都能把快捷键和动作绑定起来，用户不用只靠帮助文档记忆。

## code-agent 当前实现

| 层级 | 当前行为 | 证据 | 判断 |
| --- | --- | --- | --- |
| 原生全局唤起 | Tauri 注册 `CmdOrCtrl+Shift+A`，触发后 show/focus 主窗口并 emit `memo:activate` | `src-tauri/src/main.rs:1265`，`src-tauri/src/main.rs:1372`；`src/renderer/components/features/memo/MemoFloater.tsx:26`、`:106` | 这是当前最接近 Alma Quick Chat 的能力，但名字是 Memo，设置页不可见、不可配置、无冲突反馈 |
| 原生 Appshots | macOS 默认 `LeftCmd+RightCmd`，通过 event tap 监听左右 Command，触发 `trigger_capture` | `src-tauri/src/appshots.rs:32`、`:98`、`:256`；设置页 `src/renderer/components/features/settings/tabs/AppshotsSettings.tsx:81`、`:105` | 能力清楚，但触发方式只读固定，只支持 macOS，不能配置替代键 |
| renderer 全局快捷键 | `useKeyboardShortcuts` 定义 `Cmd/Ctrl+N`、`B`、`K`、`L`、`,`、`/`、`D`、`E`、`J`、`[`、`]`、`Shift+P`、`Shift+C`、`Esc` | `src/renderer/hooks/useKeyboardShortcuts.ts:63`、`:268` | 一张技术表承担过多动作，分类只有 session/navigation/editing/view，未按用户任务组织 |
| 命令面板快捷键 | 默认表写了 `Cmd/Ctrl+Shift+P`，hook 只会调用 `customHandlers.commandPalette`；App 顶层只传 `triggerCompact` | `src/renderer/hooks/useKeyboardShortcuts.ts:309`；`src/renderer/App.tsx:183` | 当前很可能存在“文档/注释说能打开，实际没有 handler”的断点，需要 P0 验证 |
| CommandPalette | 命令列表里有新建、清空、归档、侧边栏、DAG、工作区、设置、快捷键，但“快捷键”只 TODO 跳设置 tab | `src/renderer/components/CommandPalette.tsx:60`、`:132`、`:137`、`:341` | 命令面板是很好的发现入口，但没有连接到真实快捷键设置 |
| 会话发送 | textarea 中 `Enter` 发送，`Shift+Enter` 换行，兼容中文 IME composition | `src/renderer/components/features/chat/ChatInput/InputArea.tsx:142`、`:291` | 这块应该保持默认，不需要配置得太复杂 |
| slash menu | 输入 `/` 打开内联 popover，Enter/Tab 选择，Esc 关闭；GUI-only 命令里展示 `⌘N`、`⌘K`、`⌘/`、`⌘,` | `src/renderer/components/features/chat/ChatInput/index.tsx:407`、`:980`；`SlashCommandPopover.tsx:198`、`:690` | 可发现性不错，但展示的是硬编码符号，未来应从 keybinding registry 读 |
| 会话搜索与 Replay | `Cmd/Ctrl+F` 打开 ChatSearchBar；双击 Esc 打开 RewindPanel；Esc 关闭 | `src/renderer/components/ChatView.tsx:139`、`:478`；`src/renderer/components/RewindPanel.tsx:75` | 搜索符合直觉；双 Esc 打开 rewind 很隐蔽，应进入快捷键设置/提示或改成命令面板动作 |
| 停止/取消 | ThoughtDisplay 处理思考中 Esc 取消；全局 hook 也把 Esc 用于关闭设置/权限/自定义 cancel | `src/renderer/components/features/chat/ThoughtDisplay.tsx:84`；`useKeyboardShortcuts.ts:279` | Esc 语义合理，但要做优先级仲裁，避免多个监听器同时响应 |
| Voice input | composer 有 `VoiceInputButton` 和 browser media recorder hook；另有 voice paste IPC 尝试注册 `CommandOrControl+\`` | `src/renderer/components/features/chat/ChatInput/index.tsx:1198`；`src/main/ipc/voicePaste.ipc.ts:274`；`src/main/platform/globalShortcuts.ts:14` | voice paste 使用的 `globalShortcut` shim 当前 `register()` 固定返回 false，属于疑似历史遗留；UI 还会显示 “Cmd+` 停止” |
| Artifacts / 预览 | PreviewPanel/CodeEditor 有 `Cmd/Ctrl+S` 保存；普通 artifact copy/export/preview 多为按钮 | `src/renderer/components/CodeEditor.tsx:75`；`src/renderer/components/PreviewPanel.tsx:293` | 交付物局部快捷键存在，但没有进入统一地图 |
| Browser / Computer Use | 工作台有 BrowserSurfacePanel、ComputerUsePanel、recovery action、run workbench cards，未发现默认热键 | `src/renderer/hooks/useWorkbenchBrowserSession.ts`；`ToolDetails.tsx` recovery actions | 这类能力更适合命令面板和上下文按钮，不应抢全局默认键 |
| 设置页 | tabs 有 general/conversation/model/agentEngine/workspace/appshots/capabilities/plugins/mcp/skills 等，没有 keybindings tab | `src/renderer/utils/settingsTabs.ts:12`；`src/renderer/components/features/settings/SettingsModal.tsx:137` | 当前缺少热键配置的信息入口 |

## 差异与问题

1. code-agent 的热键按实现位置散落，Alma 按用户任务和 settings schema 收敛。现在想查“有哪些快捷键”，需要同时看 hook、组件、Tauri、IPC 和设置页。
2. code-agent 没有持久化 keybindings schema。`DEFAULT_SHORTCUTS` 只是 hook 里的数组，CommandPalette 和 SlashCommandPopover 又各自硬编码展示值。
3. 全局热键通道分裂。Tauri Rust 注册了 `CmdOrCtrl+Shift+A`，Appshots 用 macOS event tap，voice paste 走 TS shim 且当前注册失败。未来如果不统一 action id 和注册状态，用户会看到多个互相不认的热键设置。
4. 冲突检测缺位。当前没有重复检测、系统保留键检测、注册失败反馈，也没有“恢复默认”。
5. 一些默认键的语义风险高：
   - `Cmd/Ctrl+K` 清空当前对话，和现代应用常用的 command palette 冲突，动作本身也危险。
   - `Cmd/Ctrl+B` 用于“移至后台”，容易和 bold、sidebar、IDE 习惯冲突，并且触发后还会创建新会话。
   - `Cmd/Ctrl+L` 聚焦输入框，会和浏览器地址栏、路径跳转习惯冲突。
   - `Cmd/Ctrl+D` 切 DAG，会和收藏/duplicate 等常见语义冲突。
   - `Cmd/Ctrl+Shift+C` compact 成本较高，不适合默认可误触。
   - `CmdOrCtrl+Shift+A` 作为全局键可能和其他 AI 工具、编辑器 extension 冲突，需要注册失败反馈和可修改入口。
6. 快捷键提示不一定在正确位置。composer 和 slash popover 有提示，但设置页没有全局地图；Appshots 只在自己的 tab 展示；Artifacts 和工作台局部动作没有统一提示。

## 建议的信息架构

设置页新增一级 tab：`快捷键`，放在 `基础偏好` 或 `系统` 都可以。更推荐放在 `基础偏好`，因为它影响日常操作效率，不只是系统配置。

tab 内按用户任务分组：

| 分组 | 内容 | 展示原则 |
| --- | --- | --- |
| 全局唤起 | 打开/隐藏 app、快速提问、新会话、语音输入、截图问答 | 需要标出“全局生效”，显示注册状态、系统权限、冲突提示 |
| 会话编辑 | 发送、换行、停止、继续、重试、compact、选择模型/agent、打开 slash menu | 靠近 composer 语义，危险动作默认不抢键位 |
| 交付物 | 打开 Artifacts、预览、保存、导出、复制、切换版本 | 多数是面板内 contextual shortcut，不建议默认全局 |
| 工作台 | Browser/Computer Use、Replay、Review Queue、任务面板、文件/附件 | 以 command palette 和任务面板提示为主，少量高频动作可配置 |
| 设置与能力 | 打开设置、MCP、Skill、Plugin、热键配置、使用量 | 默认保留 `Cmd+,`，其他通过命令面板 deep link 进入 |

每个 action 应该有固定字段：

- `id`：稳定动作 id，例如 `global.quickAsk`、`session.new`、`composer.send`。
- `scope`：`global`、`window`、`composer`、`panel`。
- `group`：上述五类之一。
- `defaultMac`、`defaultWinLinux`。
- `current`、`enabled`、`customized`。
- `risk`：`safe`、`stateful`、`destructive`、`permissioned`。
- `conflicts`：同 app 冲突、系统保留、注册失败、仅 macOS。
- `source`：renderer / Tauri / event tap / command palette / component-local。

## 默认热键建议

### 全局唤起类

| 动作 | macOS 建议 | Windows/Linux 映射 | 默认策略 | 原因 |
| --- | --- | --- | --- | --- |
| 打开/隐藏 app | 保留现有 `Cmd+Shift+A` | `Ctrl+Shift+A` | 默认启用，但必须可改 | 现有功能已经依赖它；补冲突检测和设置入口即可 |
| 快速提问 / Quick Ask | `Cmd+Shift+Space` | `Ctrl+Shift+Space` | P1 默认启用或安装后引导确认 | 直接借鉴 Alma Quick Chat，语义清楚，但可能和系统/输入法冲突，必须可禁用 |
| 新会话 | 无全局默认；前台 `Cmd+N` | 前台 `Ctrl+N` | 不占全局 | 新会话只有 app 前台时才需要，避免全局抢键 |
| 语音输入 | 前台 `Cmd+Shift+V` | 前台 `Ctrl+Shift+V` | 仅 voice enabled 时默认；全局 voice paste 不默认 | 和 Alma 一致，作为 composer 辅助合适；全局录音涉及隐私和权限 |
| 截图问答 / Appshots | macOS 保留 `LeftCmd+RightCmd`，另提供可配置替代 | Windows/Linux 暂无默认 | macOS 默认保留，其他平台不默认 | 现有 appshots 已使用此手势；跨平台之前不要制造假一致 |

### 会话编辑类

| 动作 | macOS 建议 | Windows/Linux 映射 | 默认策略 | 原因 |
| --- | --- | --- | --- | --- |
| 发送 | `Enter` | `Enter` | 默认启用 | 主流聊天产品惯例 |
| 换行 | `Shift+Enter` | `Shift+Enter` | 默认启用 | 已实现，且对中文 IME 兼容 |
| 停止 | `Esc` | `Esc` | 默认启用 | 生成中取消符合直觉，但要做监听优先级 |
| 继续 | 无默认 | 无默认 | 可配置 | 状态依赖强，容易误触 |
| 重试 | 无默认 | 无默认 | 可配置 | 成本动作，不抢键 |
| compact | 移除默认 `Cmd+Shift+C` | 移除默认 `Ctrl+Shift+C` | 命令面板 + 可配置 | compact 有成本和状态变化，不适合默认 |
| 选择模型 / agent | 无默认 | 无默认 | 命令面板 + slash + 可配置 | 当前 UI 已有 ModelSwitcher 和 `/agent`，默认键位收益不高 |
| 打开 slash menu | `/` when composer focused | `/` when composer focused | 默认启用 | 输入语法本身就是入口 |
| 命令面板 | `Cmd+K`，可保留 `Cmd+Shift+P` 作为兼容 alias | `Ctrl+K`，可保留 `Ctrl+Shift+P` | P0 默认 | `Cmd+K` 更符合现代工具；需要把清空对话迁出默认 |

### 交付物类

| 动作 | macOS 建议 | Windows/Linux 映射 | 默认策略 | 原因 |
| --- | --- | --- | --- | --- |
| 打开 Artifacts / 预览面板 | 无默认 | 无默认 | 可配置 + 命令面板 | artifact 并非每个会话都有，默认键收益不稳定 |
| 保存正在编辑的预览 | `Cmd+S` | `Ctrl+S` | 面板内默认 | 已在 CodeEditor 实现，符合预期 |
| 导出 | 无默认 | 无默认 | 可配置 | 导出动作低频，优先按钮和命令面板 |
| 复制 focused artifact | 无默认 | 无默认 | 面板内可配置 | 避免和系统 copy/compact 冲突 |
| 切换版本 | `Option+[` / `Option+]` | `Alt+[` / `Alt+]` | 仅 panel focused 时可配置 | 适合局部作用域，不适合全局 |

### 工作台类

| 动作 | macOS 建议 | Windows/Linux 映射 | 默认策略 | 原因 |
| --- | --- | --- | --- | --- |
| 任务面板 / StatusRail | 保留 `Cmd+J` | `Ctrl+J` | 默认启用但可改 | 类似 drawer/console 语义，可保留 |
| Browser workbench | 无默认 | 无默认 | 命令面板 + 可配置 | 涉及权限、托管浏览器和上下文模式 |
| Computer Use | 无默认 | 无默认 | 命令面板 + 可配置；停止用 `Esc` | 高风险能力不应一键误触启动 |
| Replay / Rewind | 不建议继续只靠双 Esc | 不建议继续只靠双 Esc | 命令面板 + 设置里显示；可配置 | 双 Esc 太隐蔽，且和取消语义混在一起 |
| Review Queue | 无默认 | 无默认 | 命令面板 + 可配置 | 更像工作台导航 |
| 文件 / 附件 | 无默认；composer 内按钮和拖拽优先 | 无默认 | 可配置 | `Cmd+O` 容易和系统打开文件冲突 |

### 设置与能力类

| 动作 | macOS 建议 | Windows/Linux 映射 | 默认策略 | 原因 |
| --- | --- | --- | --- | --- |
| 打开设置 | `Cmd+,` | `Ctrl+,` | 默认启用 | 平台惯例 |
| 打开快捷键设置 | 无默认 | 无默认 | 命令面板 deep link | 用户不会频繁打开 |
| MCP / Skill / Plugin | 无默认 | 无默认 | 命令面板 deep link + 设置搜索 | 能力中心信息多，默认键没必要 |
| 使用量 | 无默认 | 无默认 | 命令面板 deep link | 低频查询 |

## 可配置策略

1. 先建 registry，再接 UI。所有现有快捷键先映射到统一 action id，UI、tooltip、slash、command palette 都从 registry 读展示值。
2. renderer 与 native 分开注册，但共享同一份配置。`global` scope 由 Tauri/原生层注册并返回状态，`window/composer/panel` scope 由 renderer dispatcher 处理。
3. 录入控件要支持按键序列规范化。macOS 展示 `⌘`、`⌥`、`⇧`、`⌃`，存储层使用跨平台结构或 Electron/Tauri 可映射 accelerator。
4. 冲突检测至少覆盖四类：同 scope 重复、输入框冲突、系统/浏览器常见保留键、native 注册失败。
5. 危险动作默认不抢键。清空、compact、启动 Computer Use、批量导出等动作可以可配置，但默认走命令面板和确认。
6. 支持恢复默认、清空单项、禁用单项。Prompt App 类自定义全局键也要纳入同一冲突视图。
7. Windows/Linux 映射原则：macOS `Cmd` 映射 `Ctrl`，macOS `Option` 映射 `Alt`；纯 macOS 物理键能力，如 `LeftCmd+RightCmd`，其他平台显示“不支持”，避免假映射。

## P0 开发切片

1. Keybinding action registry
   - 把现有 `useKeyboardShortcuts`、`ChatView Cmd+F`、`ChatInput Enter`、Appshots、Tauri global activate、CommandPalette 展示值整理成 registry。
   - registry 先只描述现有行为，不新增新产品能力。
   - 验收：可以从一个函数导出完整快捷键列表，包含 group、scope、platform default、risk、source。

2. Settings schema 与迁移
   - 在 settings contract 中新增 `keybindings`。
   - 首次启动用当前默认值填充；缺失项按 platform default 补齐。
   - 验收：旧设置不丢失；新设置能 round-trip；恢复默认可回到 registry default。

3. 快捷键设置页
   - 新增 `快捷键` tab，按五个任务分组展示。
   - 支持搜索 action、录入、清空、禁用、恢复默认。
   - 验收：搜索 `voice`、`截图`、`compact`、`MCP` 能定位对应条目；每项能看到生效范围和当前状态。

4. 冲突检测与注册状态
   - 同 scope 冲突阻止保存。
   - 全局热键保存后调用 native register，失败要显示“系统已占用或注册失败”。
   - `LeftCmd+RightCmd` 这类 event tap 手势作为特殊 shortcut kind。
   - 验收：设置两个相同组合会出现冲突；设置一个系统占用组合会保留旧值并提示失败。

5. 现有高风险默认修正
   - `Cmd/Ctrl+K` 改为命令面板默认；清空对话改为无默认或需二次确认。
   - `Cmd/Ctrl+Shift+P` 若保留，需要真正打开 CommandPalette。
   - `Cmd/Ctrl+Shift+C` compact 改为可配置但不默认。
   - 验收：会话页按 `Cmd+K` 打开命令面板；清空对话不会被误触发；compact 只能从命令面板或用户自定义热键触发。

## P1 开发切片

1. Quick Ask / Memo 升级
   - 将现有 `Cmd+Shift+A` Memo 和 Alma 式 Quick Chat 区分清楚，决定是合并成 Quick Ask，还是保留“打开 app”和“快速提问”两个 action。
   - 验收：全局热键能打开轻量提问 UI，设置页显示注册状态。

2. 语音与 Appshots 可配置
   - Voice composer shortcut、voice paste 全局 shortcut、Appshots 手势进入统一设置。
   - 验收：voice paste 不再依赖返回 false 的 TS shim；禁用后 UI 不再提示无效 `Cmd+\``。

3. 工作台与交付物局部快捷键
   - Artifacts、PreviewPanel、Browser/Computer Use、Replay、Review Queue 增加 panel-focused shortcut。
   - 验收：面板打开时显示局部 shortcut hint，面板关闭时不拦截同键。

4. 快捷键提示统一来源
   - Composer、slash popover、CommandPalette、tooltip、Settings 全部从 registry 读展示值。
   - 验收：修改 `新建会话` 后，CommandPalette 和 slash popover 同步显示新键。

5. 自动化验证
   - 增加 parse/format/normalize/conflict 单测。
   - 增加 renderer 测试覆盖设置页录入、搜索、恢复默认。
   - 增加 Tauri smoke 或 mock 测试覆盖 global registration success/failure。

## 验收方式

- 文档验收：`docs/research/alma-hotkeys.md` 能作为产品/工程共同的快捷键方案基线，能看出 Alma 证据边界、code-agent 现状、默认建议和切片顺序。
- 代码验收，未来开发时使用：
  - 单测覆盖 keybinding parse、format、platform default、conflict detection。
  - renderer 测试覆盖设置页分组、搜索、录入、清空、恢复默认。
  - E2E 覆盖会话页 `Enter`、`Shift+Enter`、`Esc`、`Cmd+K`、`Cmd+,`、`Cmd+F`。
  - native smoke 覆盖全局快捷键注册成功、注册失败、禁用后不触发。
  - 手工 macOS 验收覆盖 Appshots 左右 Command、权限缺失提示、恢复默认。

## 风险

- Tauri accelerator、macOS event tap、renderer `keydown` 三套机制能力不同，不能假装统一字符串就能统一行为。
- `LeftCmd+RightCmd` 是纯修饰键物理手势，普通 global shortcut API 表达不了，必须作为特殊类型处理。
- 输入框、CodeMirror、terminal、browser surface 都会截获键盘事件，必须按 focus scope 做优先级。
- 清空、compact、Computer Use、批量导出属于高成本动作，默认热键应克制。
- macOS `Cmd` 到 Windows/Linux `Ctrl` 的映射只能覆盖普通组合键，系统保留键和输入法冲突需要平台实际注册验证。
- 现在的 `src/main/platform/globalShortcuts.ts` 会把 callback 存进 map 但返回 false，容易让 TS 主进程路径产生“看起来已接入，实际没有注册”的错觉。
