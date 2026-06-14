# Hotkeys / Keyboard Shortcuts 完整开发计划

创建：2026-06-14  
关联研究：`docs/research/alma-hotkeys.md`  
目标分支：`codex/alma-hotkeys-visible`  
状态：规划稿，不包含产品代码改动

## 0. 目标

把 code-agent 当前分散在 renderer、Tauri、Appshots、CommandPalette、ChatInput、voice paste 里的快捷键，收敛成一套可发现、可配置、可验证、可回滚的热键系统。

完成后用户应该能在设置里看到一张完整快捷键地图，按功能搜索，修改或禁用某个组合键，发现冲突并恢复默认。工程上应该能用同一份 action registry 驱动实际监听、设置页展示、命令面板提示、slash 提示和 tooltip。

## 1. 成功标准

产品标准：

- 设置里新增 `快捷键` tab，按 `全局唤起`、`会话编辑`、`交付物`、`工作台`、`设置与能力` 分组。
- 每个快捷键显示动作、当前组合键、生效范围、平台限制、冲突状态和是否自定义。
- 支持搜索、录入、清空、禁用、恢复单项默认、恢复全部默认。
- `Cmd/Ctrl+K` 打开命令面板，清空对话不再默认占用该组合键。
- `Cmd/Ctrl+Shift+P` 若继续展示，就必须真实打开命令面板。
- `Cmd/Ctrl+Shift+C` compact 默认不再可误触，保留命令面板入口和自定义能力。
- Appshots 的 `LeftCmd+RightCmd` 作为 macOS 特殊手势显示在同一个设置页里。

工程标准：

- 所有默认快捷键定义集中在 `shared` 层，不再由多个组件各自硬编码展示。
- renderer dispatcher、settings UI、CommandPalette、SlashCommandPopover、tooltip 都从 registry 读取展示值。
- 全局热键由 Tauri/native 层注册并返回注册结果，renderer 不假装全局注册成功。
- shortcut parse、format、normalize、conflict detection 有单元测试。
- 现有发送、换行、Esc 停止、Cmd/Ctrl+F 搜索、Appshots、全局 activate 不回退。

非目标：

- 不重写 ChatInput、CommandPalette、SettingsModal 的整体 UI 架构。
- 不一次性给 Browser/Computer Use、Artifacts、Review Queue 增加大量默认热键。
- 不把 Prompt App 或插件系统整体重构成新 command framework。
- 不在 Windows/Linux 上模拟 macOS `LeftCmd+RightCmd` 纯修饰键手势。

## 2. 目标用户体验

### 2.1 设置页

`设置 -> 快捷键` 是主入口。首屏应该能直接看到：

- 搜索框
- `恢复默认` 按钮
- 平台提示，例如 `macOS 快捷键显示为 Cmd/Option，Windows/Linux 使用 Ctrl/Alt`
- 分组列表
- 冲突摘要，例如 `2 个快捷键需要处理`

单个快捷键行展示：

- 动作名：`打开命令面板`
- 说明：`搜索并执行会话、设置和能力动作`
- 当前组合键：`Cmd+K`
- scope chip：`当前窗口`、`全局`、`输入框`、`面板内`
- risk chip：`安全`、`有状态`、`高成本`、`需要权限`
- 操作：录入、清空、恢复默认、启用开关
- 状态：已自定义、冲突、注册失败、仅 macOS

录入控件行为：

- 点击后进入 recording 状态，显示 `按下新的快捷键`
- Escape 取消录入
- Backspace/Delete 清空当前快捷键
- 纯字母、纯数字默认不允许，除非 action scope 是 `composer` 且明确允许
- 全局热键必须包含 modifier，特殊手势例外
- 保存前先跑本地冲突检测，global scope 再请求 native 注册验证

### 2.2 会话页

会话页不需要新增大量说明文字，只在正确位置显示必要提示：

- composer 发送按钮 tooltip 使用 registry：`发送 (Enter)`
- composer 输入框 hover 或 placeholder 辅助：`Shift+Enter 换行`
- 语音按钮 tooltip：`语音输入 (Cmd+Shift+V)`，未启用时不显示无效快捷键
- command palette footer 展示导航键和当前打开快捷键
- slash popover 的快捷键展示从 registry 读取
- Appshots chip 或设置提示展示 `LeftCmd+RightCmd`，并能跳到快捷键设置

### 2.3 错误与恢复

用户设置冲突时，不直接丢弃输入：

- 同 scope 冲突：显示冲突 action，阻止保存。
- 不同 scope 可共存：例如 `Cmd+S` 在 CodeEditor panel scope 可和全局无关 action 共存。
- native 注册失败：保留旧快捷键，显示失败原因。
- 重置默认：只影响 keybindings，不改其他设置。

## 3. 架构方案

### 3.1 新增 shared registry

新增目录：

```text
src/shared/keybindings/
  types.ts
  actions.ts
  defaults.ts
  normalize.ts
  format.ts
  conflicts.ts
  index.ts
```

核心类型：

```ts
export type KeybindingScope =
  | 'global'
  | 'window'
  | 'composer'
  | 'panel';

export type KeybindingGroup =
  | 'global'
  | 'session'
  | 'artifact'
  | 'workbench'
  | 'settings';

export type KeybindingRisk =
  | 'safe'
  | 'stateful'
  | 'destructive'
  | 'expensive'
  | 'permissioned';

export type KeybindingShortcut =
  | { kind: 'accelerator'; value: string }
  | { kind: 'special'; value: 'macos.leftRightCommand' };

export interface KeybindingActionDefinition {
  id: string;
  label: string;
  description: string;
  group: KeybindingGroup;
  scope: KeybindingScope;
  risk: KeybindingRisk;
  defaultMac?: KeybindingShortcut;
  defaultWinLinux?: KeybindingShortcut;
  configurable: boolean;
  enabledByDefault: boolean;
  platform?: 'all' | 'macos-only';
}
```

第一版 action ids：

| ID | 动作 | scope | 默认 |
| --- | --- | --- | --- |
| `global.activateApp` | 打开/聚焦 app | global | `Cmd/Ctrl+Shift+A` |
| `global.quickAsk` | 快速提问 | global | P1 决定是否默认 `Cmd/Ctrl+Shift+Space` |
| `global.appshot` | 截图问答 | global | macOS special `LeftCmd+RightCmd` |
| `global.voicePaste` | 全局语音粘贴 | global | 无默认 |
| `session.new` | 新建会话 | window | `Cmd/Ctrl+N` |
| `session.next` | 下一个会话 | window | `Cmd/Ctrl+]` |
| `session.previous` | 上一个会话 | window | `Cmd/Ctrl+[` |
| `session.search` | 搜索当前会话 | window | `Cmd/Ctrl+F` |
| `session.moveToBackground` | 运行会话移至后台 | window | 无默认，保留可配置 |
| `session.clear` | 清空对话 | window | 无默认，保留命令面板入口 |
| `composer.send` | 发送 | composer | `Enter` |
| `composer.newline` | 换行 | composer | `Shift+Enter` |
| `composer.openSlash` | 打开 slash menu | composer | `/` |
| `composer.voiceInput` | 语音输入 | composer | `Cmd/Ctrl+Shift+V` |
| `run.stop` | 停止生成 | window | `Esc` |
| `run.compact` | 压缩上下文 | window | 无默认 |
| `nav.commandPalette` | 命令面板 | window | `Cmd/Ctrl+K`，`Cmd/Ctrl+Shift+P` alias 可保留 |
| `nav.settings` | 打开设置 | window | `Cmd/Ctrl+,` |
| `nav.toggleSidebar` | 切换侧边栏 | window | `Cmd/Ctrl+/` |
| `nav.toggleTaskPanel` | 任务面板 | window | `Cmd/Ctrl+J` |
| `nav.toggleDAG` | DAG 面板 | window | 无默认或保留可配置 |
| `nav.toggleWorkspace` | 工作区面板 | window | 无默认或保留可配置 |
| `artifact.save` | 保存预览编辑 | panel | `Cmd/Ctrl+S` |
| `artifact.openPanel` | 打开交付物面板 | panel/window | 无默认 |
| `workbench.replay` | Replay/Rewind | window | 无默认 |
| `settings.keybindings` | 打开快捷键设置 | window | 无默认 |

### 3.2 settings schema

在 `src/shared/contract/settings.ts` 增加：

```ts
export interface KeybindingsSettings {
  version: 1;
  bindings: Record<string, {
    enabled: boolean;
    shortcut: KeybindingShortcut | null;
    aliasShortcuts?: KeybindingShortcut[];
    customized?: boolean;
  }>;
}
```

迁移策略：

- 缺少 `settings.keybindings` 时，用 registry 默认值生成。
- 新增 action 时，只补缺失项，不覆盖用户自定义。
- 删除 action 时保留 unknown key 一段时间，避免降级后丢配置。
- `version` 只用于结构迁移，不用于产品版本。

落点：

- `src/shared/contract/settings.ts`
- `src/main/services/core/configService.ts`
- `src/renderer/api/httpTransport.ts` 和 domain settings 路径如已有 schema 校验则补类型
- `tests/unit/web/domainSettingsRouter.test.ts`
- `tests/unit/services/sessionDefaults.test.ts` 或新增 settings defaults 测试

### 3.3 renderer dispatcher

新增 renderer service/hook：

```text
src/renderer/services/keybindingDispatcher.ts
src/renderer/hooks/useKeybindingDispatcher.ts
```

职责：

- 从 settings + registry 计算当前平台有效绑定。
- 监听 `keydown`。
- 根据 focus scope 选择 action。
- 统一处理 preventDefault。
- 向 App 注入 action handlers。

替换计划：

- `useKeyboardShortcuts.ts` 先变成 registry dispatcher 的薄 wrapper，保留对外 API。
- `ChatView Cmd/Ctrl+F` 迁入 dispatcher，避免多个 window listener 抢事件。
- `ThoughtDisplay Esc` 迁入 dispatcher 或注册为高优先级 context handler。
- `ChatInput InputArea` 的 `Enter/Shift+Enter` 第一阶段保留在组件内，registry 只负责展示和配置边界；P1 再评估是否完全纳入 dispatcher。

优先级：

1. modal / permission / recording
2. composer autocomplete / slash popover
3. panel focused actions
4. active run actions
5. window actions
6. global actions由 native 处理

### 3.4 native/global 注册

新增 Rust 侧模块：

```text
src-tauri/src/shortcuts.rs
```

职责：

- 注册/注销普通 global shortcut。
- 返回注册状态和失败信息。
- 继续保留 Appshots special handler，向设置页报告 special shortcut 状态。
- 把 `CmdOrCtrl+Shift+A` 从 `setup_global_shortcut` 收进统一入口。

Tauri commands：

```rs
keybindings_get_global_state()
keybindings_register_global(action_id, shortcut)
keybindings_unregister_global(action_id)
keybindings_reset_global_defaults()
```

TS main 侧处理：

- `src/main/platform/globalShortcuts.ts` 不再作为假实现服务新功能。
- `voicePaste.ipc.ts` 如果继续保留，需要走 Tauri bridge 或明确标为 legacy disabled。
- UI 上禁止展示 `Cmd+\`` 可用，直到注册链路真实可用。

### 3.5 设置页 UI

新增：

```text
src/renderer/components/features/settings/tabs/KeybindingsSettings.tsx
src/renderer/components/features/settings/tabs/keybindings/
  KeybindingRecorder.tsx
  KeybindingRow.tsx
  KeybindingConflictBadge.tsx
  keybindingPresentation.ts
```

接入：

- `src/renderer/utils/settingsTabs.ts` 增加 `keybindings` tab，分组放 `basics`。
- `src/renderer/components/features/settings/SettingsModal.tsx` 增加 tab 和 render 分支。
- `src/renderer/utils/settingsIndex.ts` 增加搜索索引：`快捷键`、`热键`、`keyboard`、`shortcut`、`hotkey`。
- `src/renderer/i18n/zh.ts`、`src/renderer/i18n/en.ts` 增加必要文案。
- `CommandPalette` 的 `keyboard-shortcuts` action 直接 openSettingsTab('keybindings')。

UI 原则：

- 工具按钮用 icon + tooltip，不写大段说明。
- 表格/列表密度适中，适合扫描。
- conflict badge 清楚说明“和谁冲突”。
- 全局热键行显示 native 注册状态。
- `LeftCmd+RightCmd` 用特殊展示，不放进普通 accelerator 输入框。

## 4. 开发切片

### PR 1：Registry 和 settings schema，行为不变

目标：建立统一数据源，不改任何用户可见行为。

改动：

- 新增 `src/shared/keybindings/*`。
- 把当前默认动作录进 registry。
- settings contract 增加 `keybindings`。
- config defaults 生成 keybindings。
- 新增 parse/format/normalize/conflict 的纯函数。

验收：

- `npx vitest run tests/unit/keybindings/*.test.ts`
- `npx vitest run tests/unit/web/domainSettingsRouter.test.ts tests/renderer/utils/settingsIndex.test.ts`
- `npm run typecheck`

回滚：

- 删除 registry 和 settings 字段迁移，不影响现有硬编码快捷键。

### PR 2：Renderer dispatcher shadow mode

目标：让新 dispatcher 能计算和识别快捷键，但默认仍走旧 handler，先拿测试证明映射正确。

改动：

- 新增 `useKeybindingDispatcher`。
- 旧 `useKeyboardShortcuts` 包一层 shadow dispatcher。
- 为每个旧快捷键写 action handler 映射。
- 记录 action fired log，但先不替换高风险路径。

验收：

- `npx vitest run tests/renderer/hooks/useKeybindingDispatcher.test.ts`
- 覆盖输入框内 modifier 行为、非 modifier 行为、Esc 优先级、Shift alias。
- 手工检查 `Cmd/Ctrl+N`、`Cmd/Ctrl+,`、`Cmd/Ctrl+F` 行为不变。

回滚：

- App 继续使用旧 `useKeyboardShortcuts` handler。

### PR 3：CommandPalette 和危险默认键修正

目标：先修最明显的产品风险。

改动：

- `Cmd/Ctrl+K` 打开 CommandPalette。
- `Cmd/Ctrl+Shift+P` 作为 alias 打开 CommandPalette。
- 清空对话移出默认热键，只保留 CommandPalette/slash action，必要时加确认。
- compact 移出默认热键，只保留 CommandPalette 和自定义。
- CommandPalette 和 SlashCommandPopover 的 shortcut 展示改从 registry 读取。

验收：

- `npx vitest run tests/renderer/components/commandPalette*.test.ts tests/renderer/components/chatInput*.test.ts`
- Playwright：会话页按 `Cmd+K` 打开命令面板，输入框内也能打开；清空对话不会被热键触发。
- 手工：compact 不再被 `Cmd+Shift+C` 误触发。

回滚：

- registry 默认恢复旧键，保留 dispatcher 代码。

### PR 4：快捷键设置页 MVP

目标：用户能看到完整地图，并修改 window/composer/panel scope 快捷键。

改动：

- 新增 `KeybindingsSettings` tab。
- 支持分组、搜索、录入、清空、启用/禁用、恢复默认。
- 第一版只保存 renderer scope；global scope 行可显示但编辑时提示 P5 支持。
- settings search 和 command palette 能跳到此 tab。

验收：

- `npx vitest run tests/renderer/components/keybindingsSettings.test.tsx tests/renderer/utils/settingsIndex.test.ts`
- Playwright：打开设置，进入快捷键 tab，搜索 `compact`、`截图`、`MCP`，修改 `新建会话` 后 CommandPalette 展示同步。
- `npm run typecheck`

回滚：

- 设置 tab 可隐藏，registry 和默认行为仍可保留。

### PR 5：Native global hotkeys 接入

目标：全局热键真实可配置，并有注册失败反馈。

改动：

- 新增 `src-tauri/src/shortcuts.rs`。
- `CmdOrCtrl+Shift+A` 迁入 native keybinding registry。
- Appshots `LeftCmd+RightCmd` 作为 special shortcut 接入状态展示。
- voice paste 移除假注册展示，或接入真实 native 注册。
- 设置页允许编辑 global scope，并保存前验证注册。

验收：

- Rust 单元/集成可行部分：shortcut parse/state 测试。
- `npm run typecheck`
- macOS 手工：
  - 修改全局 activate 后旧键不触发，新键触发。
  - 设置冲突组合时显示失败，旧键保留。
  - 禁用全局 activate 后不触发。
  - Appshots disabled 后 `LeftCmd+RightCmd` 不抓图，enabled 后恢复。

回滚：

- 关闭 global editing，恢复固定 `CmdOrCtrl+Shift+A` 和 Appshots 现状。

### PR 6：上下文提示和局部快捷键

目标：让快捷键在动作发生的位置可见。

改动：

- ChatInput、SendButton、VoiceInputButton、ContextUsagePill、PreviewPanel、CodeEditor、TaskPanel hints 从 registry 读取。
- Artifacts/Preview 只做 panel-focused 局部键：保存、切版本、打开预览。
- Replay/Rewind 改为 CommandPalette action，双 Esc 保留一版但在设置页显示为 legacy gesture 或移除。

验收：

- `npx vitest run tests/renderer/components/sendButton.runtimeFollowup.test.ts tests/renderer/components/chatInput*.test.ts tests/renderer/utils/keybindingPresentation.test.ts`
- 手工：修改快捷键后 tooltip 同步。
- Playwright 截图检查设置页和会话页提示没有溢出。

回滚：

- tooltip 回退硬编码，不影响 dispatcher。

### PR 7：E2E、迁移清理、发布闸

目标：从“能用”进入“可发版”。

改动：

- 删除旧硬编码重复展示。
- 清理 `useKeyboardShortcuts` 中已迁移逻辑，保留兼容 export。
- 补 E2E hotkeys spec。
- 增加 release note 和 docs。

验收：

- `npm run typecheck`
- `npx vitest run tests/unit/keybindings/*.test.ts tests/renderer/hooks/useKeybindingDispatcher.test.ts tests/renderer/components/keybindingsSettings.test.tsx`
- `playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/hotkeys.spec.ts`
- macOS 手工 checklist 全部通过。

回滚：

- 保留 settings keybindings 数据，功能开关切回旧 dispatcher。

## 5. 测试矩阵

### 5.1 纯函数测试

文件：

- `tests/unit/keybindings/normalize.test.ts`
- `tests/unit/keybindings/format.test.ts`
- `tests/unit/keybindings/conflicts.test.ts`
- `tests/unit/keybindings/defaults.test.ts`

覆盖：

- macOS `Cmd+Shift+Space` 展示与存储。
- Windows/Linux `Ctrl+Shift+Space` 展示与存储。
- `Cmd+K` 与 `Cmd+Shift+P` alias。
- special shortcut `macos.leftRightCommand`。
- 同 scope 冲突阻止，不同 scope 放行。
- destructive/expensive action 默认无快捷键。

### 5.2 Renderer 测试

文件：

- `tests/renderer/hooks/useKeybindingDispatcher.test.ts`
- `tests/renderer/components/keybindingsSettings.test.tsx`
- `tests/renderer/components/commandPalette.keybindings.test.tsx`
- `tests/renderer/components/chatInput.keybindings.test.tsx`

覆盖：

- 输入框内裸字母不触发 window action。
- 输入框内 `Cmd+K` 仍能打开 command palette。
- Esc 优先关闭 modal，再停止运行，再关闭 search。
- 修改 `session.new` 后 CommandPalette/SlashCommandPopover 展示同步。
- 搜索 `hotkey`、`快捷键`、`截图` 能定位设置项。

### 5.3 E2E

新增：

- `tests/e2e/hotkeys.spec.ts`

场景：

1. 打开 app，按 `Cmd+K`，命令面板出现。
2. 打开设置，进入快捷键 tab，搜索 `命令面板`。
3. 修改 `新建会话` 快捷键，回到会话页触发。
4. 设置重复快捷键，看到冲突提示，无法保存。
5. 恢复默认后 `Cmd+N` 新建会话恢复。
6. 输入框里 `Enter` 发送，`Shift+Enter` 换行。
7. `Cmd+F` 打开会话搜索。

### 5.4 macOS 手工验收

- `Cmd+Shift+A` 聚焦 app。
- 修改全局聚焦热键后即时生效。
- 全局热键注册失败时保留旧配置。
- Appshots `LeftCmd+RightCmd` enabled/disabled 都符合设置。
- 缺少屏幕录制或辅助功能权限时，Appshots 设置页显示可理解的处理路径。
- voice paste 如果未真实接入，不展示 `Cmd+\`` 可用提示。

## 6. 数据迁移与兼容

第一版迁移只做 additive：

- 没有 `settings.keybindings` 时生成默认。
- 有 unknown action 时保留。
- 用户恢复默认只改 registry 已知 action。
- 老版本回滚后会忽略 `settings.keybindings`，不应影响启动。

默认变更需要明确迁移：

- `clearChat` 从 `Cmd/Ctrl+K` 迁出默认。
- `commandPalette` 迁入 `Cmd/Ctrl+K`。
- `triggerCompact` 从 `Cmd/Ctrl+Shift+C` 迁出默认。
- 如果用户此前已经手动设置过 keybindings，不能覆盖；当前没有正式 settings keybindings，所以第一版按未自定义处理。

## 7. 风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 多监听器重复触发 | Esc、Cmd+F、Cmd+K 行为混乱 | dispatcher 先 shadow，再逐个迁移；每迁一项删旧 listener |
| 输入框和 IME 被破坏 | 中文输入、Enter 发送出错 | ChatInput Enter 第一阶段保留原逻辑；E2E 覆盖 IME guard 的关键路径 |
| global shortcut 注册失败 | 用户以为设置成功但无法触发 | native 注册结果作为保存前硬门，失败保留旧值 |
| Appshots special 手势无法普通录入 | 设置页模型复杂 | shortcut kind 区分 accelerator/special，UI 分开展示 |
| `Cmd+K` 改语义影响老用户 | 肌肉记忆变化 | release note 写清楚；清空对话保留命令面板入口 |
| 工作台局部快捷键抢全局键 | Browser/Computer Use 中误触 | panel scope 只在 focus inside panel 时生效 |
| 设置 schema 过早锁死 | 后续 Prompt App/global alias 难扩展 | action registry 支持 alias、unknown action、version migration |

## 8. 发布策略

建议走 3 个用户可见阶段：

1. 内部默认关闭 global editing，只开放快捷键地图和 renderer scope 配置。
2. macOS 开启 global editing，保留 Appshots special 手势。
3. 补 Windows/Linux global editing，平台能力不足的 action 显示为不可用。

每阶段 release note 必写：

- 新增快捷键设置入口。
- `Cmd/Ctrl+K` 改为命令面板。
- 清空对话、compact 移出默认快捷键。
- Appshots 手势在哪里配置或禁用。

## 9. 依赖与开放决策

需要产品确认：

- `Cmd+Shift+A` 的产品名：继续叫 Memo，还是升级为 Quick Ask / 快速提问。
- `Cmd+Shift+Space` 是否默认启用为 Quick Ask，还是只在 onboarding 中建议用户开启。
- `Cmd+Shift+P` 是否保留为 command palette alias。
- `Cmd+B` 是否完全释放，还是保留为某个低风险视图动作。
- Appshots 是否允许普通替代快捷键，还是只支持 `LeftCmd+RightCmd` special gesture。

需要工程确认：

- Tauri global shortcut plugin 是否能在运行时安全 unregister/register 多个 action。
- 当前 `src/main/platform/globalShortcuts.ts` 是否还有 Electron legacy 入口依赖。
- web mode 是否只展示 window/composer/panel scope，并隐藏 global scope editing。
- E2E 是否能稳定模拟 `Meta` 键，macOS 手工是否作为 global scope 最终闸。

## 10. 推荐排期

| 周期 | 交付 | 可验收成果 |
| --- | --- | --- |
| Day 1 | PR 1 | registry、settings schema、纯函数测试 |
| Day 2 | PR 2 | dispatcher shadow mode，旧行为不变 |
| Day 3 | PR 3 | `Cmd+K` 命令面板，危险默认迁出 |
| Day 4-5 | PR 4 | 快捷键设置页 MVP |
| Day 6-7 | PR 5 | macOS global hotkeys 可配置 |
| Day 8 | PR 6 | tooltip/slash/command palette 展示统一 |
| Day 9 | PR 7 | E2E、清理、release notes |

如果要压成最小可发版，Day 1-5 就能形成 P0：统一 registry、命令面板修正、设置页可见和 renderer scope 可配置。global editing、Appshots special 管理和 voice paste cleanup 可以进入 P1。

