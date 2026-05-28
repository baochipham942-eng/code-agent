# Extension Union 设计 Blueprint — 2026-05-28

Worktree: `extension-union-design`
Branch: `design/extension-union` (base main)
Evaluator: feature-dev:code-explorer subagent
Leader spot-check: 3 key citations verified (pluginRegistry.ts:738 / installService.ts:289 / toolSearchService.ts:363)

## TL;DR

Agent Neo 当前 5 套扩展系统中,**plugins 和 skills 重叠最大**,是 union 设计的优先合并目标。hooks 系统成熟且独立语义明确,不急着并入。mcp 是协议层而非架构层,不适合压入 union。deferredTools 是工具发现辅助索引。**推荐 D2 中庸路径**:先合并 plugins + skills,其余接统一 union interface 但不重写。

---

## A. 5 套系统 API Surface

### plugins

**入口/注册 API:** `src/main/plugins/pluginRegistry.ts:203 initialize()` 调用 `loadBuiltinPlugins()` + `discoverPlugins()` + `activateAll()`。插件通过 `PluginEntry.activate(api: PluginAPI)` 自注册。第三方插件在 `~/.code-agent/plugins/` 目录,读 `plugin.json` manifest。

**运行时调度:** `pluginRegistry.ts:484 activatePlugin()` 调用 `plugin.entry.activate(api)`,注册期完成工具绑定。两条工具注册通道:v1 `api.registerTool()` (types.ts:118) → v2 `api.registerToolModule()` (types.ts:186),均最终写入 `getProtocolRegistry()` (pluginRegistry.ts:325/447)。

**数据形状** (`src/main/plugins/types.ts:32`):
- `PluginManifest`: `{ id, name, version, main, surfaces[], capabilities[], platforms[], permissions[] }`
- `PluginEntry`: `{ activate(api) => Promise<void>, deactivate?() }`
- `LoadedPlugin`: `{ manifest, rootPath, state: PluginState, registeredTools[], registeredHooks[] }`

**持久化/发现:** Builtin 硬编码 import (`pluginRegistry.ts:241`),rootPath 占位 `builtin:<id>`。Third-party 磁盘扫描,支持 watcher 热重载 (debounce 500ms)。

### skills

**入口/注册 API:** `src/main/services/skills/skillDiscoveryService.ts:110 initialize()` 按优先级扫描 5 个来源:builtin < user-legacy(`~/.claude/commands/`) < user-new(`~/.code-agent/skills/`) < library < project(`.code-agent/skills/`)。每个 skill 是包含 SKILL.md 的目录。

**运行时调度:** Skills 不直接暴露为 tool definition,而是注册到 `ToolSearchService.registerSkills()` (`toolSearchService.ts:265`) 成为虚拟工具 `skill:<name>`。实际调用路径:`Skill` 元工具 → `skillInvocationResolver.ts`。

**数据形状** (`src/shared/contract/agentSkill.ts:9`):
- `SkillFrontmatter`: `{ name, description, aliases, allowed-tools, model, context, agent, argument-hint, bins, env-vars }`
- `ParsedSkill`: `{ name, description, promptContent, basePath, allowedTools, executionContext, source: SkillSource }`

**持久化/发现:** 文件系统目录扫描。通过 marketplace `installPlugin()` (`installService.ts:220`) 从 github/url/directory 下载,状态存 `installed-plugins.json`。Metadata 有 disk cache `skill-metadata-index-v2.json`。

### hooks

**入口/注册 API:** `src/main/hooks/hookManager.ts:136 initialize()` 调用 `loadAllHooksConfig(workingDirectory)` (`configParser.ts:471`) 从 JSON 配置读取。每个 session 创建独立 `HookManager` 实例 via `createHookManager(config)` (`hookManager.ts:765`)。

**运行时调度:** `hookManager.ts:660 triggerToolHooks()` / `triggerEventHooks()` 找匹配 hooks 后调用 `hookExecutionEngine.executeHooks()`。内置 hook 由 `BuiltinHookExecutor` 独立处理,最终 merge (`hookManager.ts:714`)。

**数据形状** (`src/main/hooks/configParser.ts:22`):
- `HookDefinition`: `{ type: 'command'|'prompt'|'agent'|'http', command?, prompt?, url?, timeout?, once?, if? }`
- `HookMatcher`: `{ matcher?, hooks[], parallel?, mcpServer?, hookType: 'decision'|'observer' }`
- 19 个事件 (`hookTypes.ts:22`):`PreToolUse | PostToolUse | PostToolUseFailure | UserPromptSubmit | Stop | StopFailure | PostExecution | PreCompact | PostCompact | SessionStart | SessionEnd | SubagentStart | SubagentStop | PermissionRequest | PermissionDenied | TaskCreated | TaskCompleted | Setup | Notification`

**持久化/发现:** 两格式:新 `~/.code-agent/hooks/hooks.json` (priority 0) + 旧 `~/.claude/settings.json` (priority 1)。Global + project 两层,project 覆盖 global。

### mcp

**入口/注册 API:** `src/main/mcp/mcpToolRegistry.ts:123 discoverCapabilities(serverName, client)` 调用 `client.listTools()` 发现工具。进程内服务器走 `discoverInProcessCapabilities()` (`mcpToolRegistry.ts:194`)。配置从 `mcpConfigFile.ts` 三档 scope 加载。

**运行时调度:** 发现后 `registerMCPToolsToSearch(serverName)` (`mcpToolRegistry.ts:233`) 写入 `ToolSearchService`。工具调用:`callExternalTool()` (`mcpToolRegistry.ts:408`) via SDK Client 或 `callInProcessTool()` (`mcpToolRegistry.ts:513`)。工具名格式:`mcp__serverName__toolName`。

**数据形状** (`src/main/mcp/types.ts`):
- `MCPTool`: `{ name, description, inputSchema, serverName, annotations? }`
- `MCPServerConfig`: stdio | sse | http-streamable | in-process 四种
- Scope 优先级:builtin/cloud < user < project < local < runtime

**持久化/发现:** 三档配置文件 `~/.code-agent/mcp.json` / `.code-agent/mcp.json` / `.code-agent/mcp.local.json`。动态 listChanged 支持热刷新 (`mcpToolRegistry.ts:276`)。

### deferredTools (toolSearch)

**入口/注册 API:** `src/main/services/toolSearch/toolSearchService.ts:31 ToolSearchService` 单例,构造时 `buildDeferredToolIndex()` (`deferredTools.ts:698`) 从静态 `DEFERRED_TOOLS_META` 数组(约 70+ 工具)建索引。动态来源通过 `registerMCPTools()` (`toolSearchService.ts:237`) 和 `registerSkills()` (`toolSearchService.ts:280`) 注入。

**运行时调度:** `searchTools(query)` (`toolSearchService.ts:75`) 关键字匹配评分,命中后 builtin 工具加入 `loadedDeferredTools` Set。下轮 LLM 请求时 `getLoadedDeferredToolDefinitions()` (`toolDefinitions.ts:101`) 把已加载工具合入 tool definitions。

**数据形状** (`src/shared/contract/toolSearch.ts`):
- `DeferredToolMeta`: `{ name, shortDescription, tags, aliases, source: 'builtin'|'mcp'|'dynamic', mcpServer?, searchHint? }`
- `CORE_TOOLS` (`deferredTools.ts:12`):始终发送给 LLM,不需要 ToolSearch

**持久化/发现:** Builtin 静态数组。MCP/skills 运行时注册,session 级状态不持久化。`loadedDeferredTools` Set session 内有效。

---

## B. 交叉边界 — 实际重叠

### 重叠 1:工具注册两条独立入口,在聚合点才合并

能力"把工具注册到 LLM 可用工具池"在 plugins 和 mcp 各有实现:

- **plugins** 走 `api.registerTool()/registerToolModule()` → 写入 `getProtocolRegistry()` (`pluginRegistry.ts:325/447`)— **ProtocolRegistry (Tier A, native)**
- **mcp** 走 `MCPToolRegistry.discoverCapabilities()` → 写入自身 `this.tools[]` — **MCPToolRegistry (Tier B, external protocol)**

两套在 `toolDefinitions.ts:101-118 getLoadedDeferredToolDefinitions()` 才合并:先取 ProtocolRegistry 的,再追加 MCPClient 的。设计上是有意的 Tier 分层,但消费者必须知道两套并手动合并,**没有单一入口**。

### 重叠 2:SessionStart 生命周期 hook 有两个平行实现

能力"在 session 开始执行某些逻辑"在 HookManager 和 PluginRegistry 各实现了一套:

- **HookManager** 用 `triggerSessionStart()` (`hookManager.ts:321`)— 完整执行链,含 builtin merge、decision/observer 分类、triggerHistory 记录
- **PluginRegistry** 用 `executeSessionStartHooks()` (`pluginRegistry.ts:738`)— 简单循环执行,**不走 hookExecutionEngine,不记录 history**

两者都触发 `SessionStart` 语义,但执行路径完全不同。消费者需要分别调用两套,容易遗漏其中一个。语义差异:PluginRegistry 版本是"插件注册的 hook",HookManager 版本是"用户配置的 hook + 内置 hook"。

### 重叠 3:Slash command 概念在两处有不同程度的实现

- **`skills/marketplace/types.ts:41`** `PluginEntry.commands[]` — 文件路径数组,安装后复制到 `~/.code-agent/commands/` 目录 (`installService.ts:289`)
- **`skills/agentSkill.ts`** `ParsedSkill` — SKILL.md 驱动,通过 `Skill` 元工具 + `skillInvocationResolver.ts` 完整可调用

两者都对应"用户通过 `/name` 调用的扩展行为",但 `commands` 字段**没有发现/加载机制** — 安装后没有任何代码从 `commands/` 目录读取并暴露可调用入口(详见 E 节)。

### 重叠 4:plugins 和 skills 的 metadata schema 有字段级重叠

- `PluginManifest` (`plugins/types.ts:32`): `id, name, version, description, author, surfaces[], capabilities[], platforms[]`
- `PluginEntry` from marketplace (`marketplace/types.ts:41`): `name, description, source, skills[], commands[], tags[], version, author`
- `SkillFrontmatter` (`agentSkill.ts:9`): `name, description, aliases, license, metadata`

三种"扩展元数据"都需要 `name/description/version/author`,但各自独立定义,**没有公共基类型**。

### 重叠 5:mcpToolRegistry vs protocolRegistry — 两套工具注册,聚合层手动合并

两者有意分层但消费者负担重:

- **`protocolRegistry`** (`src/main/tools/protocolRegistry.ts:17`):native 工具,单例,启动时全量注册 schema,跨 session 持久
- **`MCPToolRegistry`** (`mcpToolRegistry.ts:111`):外部协议工具,会话级,`mcp__` 前缀

`toolDefinitions.ts` 是目前唯一的聚合点,每次调用都要同时查两个注册表并手动合并。**union 设计的核心价值之一是提供单一聚合入口**。

---

## C. Pi Extension 形状对照

### 字段映射表

| Pi 字段 | Agent Neo 对应 | 差距 |
|---|---|---|
| `tools` | `PluginAPI.registerToolModule()` + `MCPToolRegistry.tools[]` | 存在,**两套入口未统一** |
| `handlers` | `HookManager` 19 个事件 | 存在但不是 extension-native,是配置文件驱动 |
| `commands` | `ParsedSkill` + `Skill` 元工具 | 部分存在,**无 slash command 直接注册机制** |
| `messageRenderers` | `ToolDetails.tsx` (renderer 侧) | 存在但解耦到 renderer 进程,**无法随 extension 注册** |
| `flags` | 不存在 | **缺失** |
| `shortcuts` | 不存在 | **缺失** |

### handlers 事件对照

Pi 11 个 vs Agent Neo 19 个 HookEvent:

| Pi 事件 | Agent Neo 对应 |
|---|---|
| `session_start` | `SessionStart` (完全对应) |
| `tool_call` | `PreToolUse` (语义接近) |
| `tool_result` | `PostToolUse` (语义接近) |
| `agent_start` | `SubagentStart` (experimental) |
| `input` | `UserPromptSubmit` (语义接近) |
| `context` | 无直接对应(builtin hook 注入上下文,非 extension 层) |
| `message_update` | 无对应(流式输出在 renderer 侧) |
| `model_select` | 无对应(无 per-extension 模型选择钩子) |
| `before_agent_start` | 无对应 |
| `session_before_switch` | 无对应 |
| `resources_discover` | 无对应(Pi 的资源发现概念) |

Agent Neo 额外有:`PostToolUseFailure / Stop / SubagentStop / PostExecution / PreCompact / TaskCreated / TaskCompleted / PermissionRequest / PermissionDenied / PostCompact / StopFailure / Setup / Notification` — Pi 没有这些更细粒度的事件。

### messageRenderers — 关键架构分叉

Pi 把渲染逻辑和工具实现绑在同一个 Extension 单元。Agent Neo 把渲染完全拆到 renderer 进程的 `ToolDetails.tsx` (`src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails.tsx:58`),工具 schema 里没有任何渲染字段。

**这是 Tauri 架构的必然结果**:main process (Node) 和 renderer (React) 分离。在 Agent Neo 引入 `messageRenderers` 意味着渲染函数要跨越 IPC 边界(序列化困难)或在 main process 运行 React(不可行)。

**结论**:Pi 的 `messageRenderers` 在 Agent Neo 不适用。应替换为 renderer 侧的 `ToolDisplayConfig` 注册机制,或保留 `ToolDetails.tsx` 中现有的 per-tool 渲染逻辑。Union interface 里 `messageRenderers` 字段可定义为 `renderConfig?: ToolDisplayConfig`,由 renderer 侧消费。

### flags / shortcuts — 平台差异

Pi 是 TUI,flags 是 CLI 参数,shortcuts 是终端快捷键。Agent Neo 是 Tauri 桌面应用,两者概念不直接映射。

**结论:union interface 可省略这两个字段**,或替换为 Tauri-specific 的 `tauriShortcuts?: string[]`。

---

## D. 3 条迁移路径

### D1. 保守 — 适配层 union,5 套内部不动

新增 `src/main/extension/` 目录,定义 `AgentExtension` interface 作为聚合视图,5 套系统内部实现完全不变:

```ts
// src/main/extension/types.ts
interface AgentExtension {
  tools: ToolDefinition[];
  hooks: ParsedHookConfig[];
  skills: ParsedSkill[];
  mcpServers: MCPServerConfig[];
  deferredMeta: DeferredToolMeta[];
}
```

消费者(agentLoop、contextAssembly)改为通过 `ExtensionAggregator.getSnapshot()` 获取统一视图,不再直接依赖各子系统。适配层做转换,不修改现有代码。

**估算**:
- 代码变化:+400 / -0(纯新增聚合层)
- 工作量:**2-3 人天**
- 风险:**低**。不改现有代码。
- 局限:只是视图投影,**不解决注册机制分散问题**,SessionStart 双路径等继续存在。

### D2. 中庸 — plugins + skills 合并,其余接 union interface ★ 推荐 ★

plugins 和 skills 合并成单一 `Extension` 概念,新 `ExtensionRegistry` 统一管理。mcp / hooks / deferredTools 维持现有实现,但暴露 union interface:

```ts
// src/main/extension/types.ts
interface AgentExtension {
  metadata: ExtensionMetadata;        // 合并 PluginManifest + SkillFrontmatter 公共字段
  tools?: ToolModule[];               // 原 plugin 工具注册
  skillPrompt?: string;               // 原 ParsedSkill.promptContent
  handlers?: HookDefinition[];        // 可选 hook 配置
  searchMeta?: DeferredToolMeta[];    // 工具发现元数据
}

interface ExtensionMetadata {
  id: string;
  name: string;
  version?: string;
  description: string;
  author?: string;
  surfaces?: ('tools' | 'skills' | 'hooks')[];
}
```

`PluginRegistry` + `SkillDiscoveryService` 合并为 `ExtensionRegistry`,marketplace 安装统一入口。原 builtin plugins 通过静态 import 继续走,原 SKILL.md 发现逻辑迁移到 ExtensionRegistry。

**估算**:
- 代码变化:+1500 / -2800(plugins ~1230 + skills/marketplace ~1230 主体,新 ExtensionRegistry ~1500)
- 工作量:**8-12 人天**
- 风险:**中**。Builtin plugins 的 activate/deactivate 生命周期比 skills 复杂;marketplace 的 `commands[]` 字段语义未完工需先清理(E1)。

### D3. 激进 — 5 套压成 1 套 union

全部废弃,只保留 mcp 协议层和一套新的 `Extension` + `ExtensionRegistry`。原 plugins 工具 → Extension.tools,原 skills prompt → Extension.skillPrompt,原 hooks 配置 → Extension.handlers,原 deferredTools 元数据 → Extension.searchMeta。

**估算**:
- 代码变化:+2000 / -12000(hooks ~4488 + plugins ~7445 + skills ~1230 + deferredTools ~1218 大量废弃)
- 工作量:**30-45 人天**
- 风险:**极高**。hooks 系统有 19 个精细事件类型 + decision/observer 语义分类 + builtin hook executor — 压平后难以保留精细控制;deferredTools 的三级可见性控制 (`canExposeLoadedTool`) 复杂,压平容易破坏工具发现语义。

---

## E. 顺手可清理的低悬果

1. **`commands` 字段是未完工的死代码**
   `src/main/skills/marketplace/installService.ts:289-316` — `PluginEntry.commands[]` 字段指向的文件被复制到 `~/.code-agent/commands/` 目录,但**没有任何代码从该目录发现并暴露可调用的命令**。安装后的 commands 只存活在 `installed-plugins.json` record 里。可清除 `commands` 字段 + 安装/卸载相关代码约 30 行,或补全缺失的发现逻辑。

2. **PluginRegistry.executeSessionStartHooks() 游离于 HookManager 之外**
   `src/main/plugins/pluginRegistry.ts:738` — 独立实现了一套 hook 执行循环,不走 `HookManager.triggerSessionStart()` 的 builtin merge、decision/observer 分类、triggerHistory 记录。消费者需要分别调用两套。**应整合为 HookManager 的一个 hook source**,让 plugin hooks 走统一调用链。

3. **ToolSearchService skills 的 `notCallableReason` 提示语不够清晰**
   `src/main/services/toolSearch/toolSearchService.ts:377` — `source === 'dynamic'` 的 skill 搜索命中后显示 `"skill search result; invoke through the Skill tool"`,但**没有给出具体的调用示例**。可改为 `canonicalInvocation` 字段已有的格式 `Skill({"command":"xxx"})`,与 `toolSearchService.ts:388` 的 `getCanonicalInvocation()` 统一处理。

4. **`registerTool()` vs `registerToolModule()` 冲突检查不对称**
   `src/main/plugins/pluginRegistry.ts:314-330` vs `pluginRegistry.ts:441-444` — `registerToolModule` 检查 `plugin.registeredTools.includes(finalName)` 并抛错;`registerTool` 通过 `protocolRegistry.register()` 走幂等覆盖(`registry.ts:29-37`),不抛错。**两个通道对命名冲突的处理语义不一致**,应统一为都抛错。

5. **hooks/configParser.ts 有 `@deprecated` 函数但未标注清晰的移除计划**
   `src/main/hooks/configParser.ts:391 getLegacyHooksConfigPaths()` — 标注了 `@deprecated Use getHooksConfigPaths instead`,但 codebase 里是否还有调用者未确认。**可 grep 清理**,减少维护负担。

---

## 总结建议

**推荐 D2 中庸路径**。

plugins 和 skills 从用户视角是同一件事:"安装一个扩展包让 Agent 获得新能力"。两套独立的安装机制(`pluginLoader.ts` vs `installService.ts`)、两套 metadata schema、两套发现逻辑是**最明显的维护负担和用户困惑来源**。

合并两者的成本(8-12 人天)在当前代码量下是合理的,主要工作量:
- 统一 `ExtensionMetadata` 基类型
- 把 builtin plugin 的 `activate()` 生命周期移植到 ExtensionRegistry
- 清理 `commands` 死代码(E1)和游离的 SessionStart 路径(E2)

hooks / mcp / deferredTools 保持现有实现不动,原因:
- **hooks** 的 19 事件 + decision/observer 分类已经是成熟设计,比 Pi 更丰富
- **mcp** 是外部协议,天然独立层
- **deferredTools** 是工具发现辅助索引,不是扩展定义层

Pi 的 `messageRenderers` 字段在 Tauri 架构下不可直接照搬,需要替换为 renderer 侧的 ToolDisplayConfig 注册机制。Pi 的 `flags/shortcuts` 对 desktop 应用意义有限,可省略或替换为 Tauri-specific 扩展点。

**最高价值的单点行动**:先做 E1 + E2 清理(1-2 人天),消除 dead code 和游离路径,为后续 D2 合并奠定干净基础。

---

## F. 实施进度（2026-05-28 收口）

Blueprint 落地按 D2 推荐路径走，**当日完成 Phase 1 → Phase 3a + E1-E5 cleanup**，Phase 3b/3c 评估后关账。

### 已完成

| 阶段 | 内容 | Commit | 备注 |
|------|------|--------|------|
| **E1/E2/E3/E5 cleanup** | 4 个低悬果同批清理 | `6f6b9cc0` | 移除 `commands` 死代码、`notCallableReason` 提示语统一、`@deprecated` 函数标注收敛、`PluginRegistry.executeSessionStartHooks` 路径标注 |
| **E4 — 行为变更** | `registerTool` 与 `registerToolModule` 对命名冲突的处理统一为抛错 | `6a7f7cd7` | E 节中唯一会改运行时行为的项 |
| **D2 Phase 1** | 公共 `ExtensionMetadata` + adapter | `6ef4ec7a` | `src/main/extension/types.ts` 建立，`pluginManifestToMetadata` / `skillFrontmatterToMetadata` 落地 |
| **D2 Phase 2** | `ExtensionRegistry` skeleton | `5fc28470` | 只读聚合层，`getExtensions()` 返回合并后的 `AgentExtension[]` |
| **Phase 3 前置清理** | `ExtensionSource` → `ExtensionOrigin` 改名 | `e1d1d79f` | 与 UI 层 `src/shared/contract/extension.ts` 的同名类型解耦，零行为变更 |
| **D2 Phase 3a** | `AgentExtension.runtimeState` + `CapabilityRecommender` 迁移 | `cfe48009` | `loadedPluginToExtension` / `parsedSkillToExtension` 落地；编译期 sanity check (`const _runtimeStateCompat = (s: PluginState): ExtensionRuntimeState => s` at `adapters.ts:140-143`，等价于 subset check)；首个消费方 `CapabilityRecommender` 改读 `ExtensionRegistry` |

### 关账：D2 Phase 3b/3c 不做

详见 [docs/audits/2026-05-28-d2-phase3b-skip-decision.md](../audits/2026-05-28-d2-phase3b-skip-decision.md)（Claude 调研 + Codex 独立二次评估，verdict 一致）。

**核心理由**：
1. Phase 3a 已经是**可用读模型**，不是半成品。`messageBuild` / `extensionOpsService` 仍直读 `PluginRegistry` 是"未全迁"而非"漏洞"。
2. Phase 3b 风险高收益低：把 `ExtensionRegistry` 从只读聚合层变成副作用 owner，需先拆新 core 防循环依赖，且不解决任何已知 bug、不解锁任何用户能力。
3. lifecycle 归一的触发条件未达成：需等 skill 加真 runtime lifecycle，或 marketplace/cloud sync 需要统一 inventory+events 时再启动。
4. 未来真要做的不是 3b，是**统一 inventory/status/events 层**，与 lifecycle 搬家无关。

### 当前架构形态

```
┌──────────────────────────┐     ┌────────────────────────────┐
│   PluginRegistry         │     │   SkillDiscoveryService    │
│   (LoadedPlugin lifecycle)│     │   (ParsedSkill 扫描)        │
└─────────────┬────────────┘     └──────────────┬─────────────┘
              │                                  │
              │  loadedPluginToExtension         │  parsedSkillToExtension
              ▼                                  ▼
        ┌──────────────────────────────────────────────────┐
        │           ExtensionRegistry                       │
        │   getExtensions(): AgentExtension[]               │
        │   (只读聚合层，runtimeState 统一暴露)              │
        └────────────────┬──────────────────────────────────┘
                         │
                         ▼
                ┌────────────────────────┐
                │ CapabilityRecommender  │  ← 首个消费方
                └────────────────────────┘
```

### 未做且不打算做（直到触发条件出现）

- **Phase 3b**: 把 lifecycle 副作用从 PluginRegistry/SkillDiscoveryService 搬到 ExtensionRegistry — 等 skill 有真 runtime lifecycle 时再谈
- **Phase 3c**: 统一 inventory/status/events 层 — 等 marketplace/cloud sync 接入时再谈
- **D3 激进路径**: 5 套压成 1 套 — 不做（hooks / mcp / deferredTools 各自语义独立，压平损失大于收益）
