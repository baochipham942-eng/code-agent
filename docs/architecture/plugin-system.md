# 插件系统与 Capability Center 架构

> 扩展 Agent Neo 能力的插件机制（PluginAPI v2 + builtin plugins），以及 2026-05 后本地能力货架的边界

## 概述

Code Agent 提供插件系统，允许扩展 Agent 的能力。插件可以：
- 注册工具（v1 `registerTool` / v2 `registerToolModule`）
- 读取受控的 API key / 用户身份 / 项目常量（PluginAPI v2）
- 访问本地存储
- 订阅事件

2026-05-19 起（`ccf03328` PluginAPI v2），项目把"插件"明确分成两类：**builtin plugin**（与 host 同 bundle，承载内置多模态/桌面能力）和**第三方 plugin**（用户目录磁盘加载）。首批已把 6 个多模态能力 + 桌面能力剥成 7 个 builtin plugin，见下文。

2026-05-15 后，产品层新增 `Capability Center`。插件系统负责可执行扩展的生命周期，Capability Center 负责统一发现和管理：把 plugin、skill、MCP template、tool bundle、channel adapter、workflow recipe、connector、agent engine 放到同一张本地货架里展示、审计和跳转配置。

| 层 | 职责 | 文件 |
|----|------|------|
| Plugin System | 加载可执行插件，提供生命周期和 API | `src/host/plugins/*` |
| Skill Discovery | 发现 builtin/user/library/project skills，并注册到 ToolSearch | `src/host/services/skills/skillDiscoveryService.ts` |
| **Extension Registry** | **只读聚合层：把 LoadedPlugin / ParsedSkill 投影成统一的 `AgentExtension`（含 `runtimeState`），供消费方按统一形态读取**（2026-05-28 落地，D2 Phase 1-3a） | `src/host/extension/*` |
| Capability Center | 汇总能力清单、requirements、risk、runtime state、install plan 和 action | `src/host/services/capabilities/capabilityCenterService.ts` |
| Curated Registry | 本地 curated catalog，带 source hash、review 信息和模板定义 | `docs/capabilities/local-curated-registry.json`、`registry.schema.json` |
| MCP Draft 安装 | 根据 template 写入项目 `.code-agent/mcp.json` 的 disabled server；删除时只回滚带 `capabilityDraft` 元数据的草稿 | `capabilityDraftResolver.ts` |
| Agent Engine 能力卡 | Native / Codex CLI / Claude Code 作为 `agent_engine` kind 展示安装和运行状态 | `agentEngineCapabilityItems.ts` |

当前边界：
- Capability Center 可以生成本地 disabled draft，但不会自动启用 MCP，也不会自动连接外部服务。
- 远程 marketplace 还没有接入；`remote / marketplace` source kind 是后续兼容位。
- 手写 MCP 配置、普通插件和项目私有 skill 不会被 Capability Center 的 draft 删除动作误删。

### Extension Registry 边界（2026-05-28）

2026-05-28 引入 `ExtensionRegistry` 作为 plugin + skill 的**只读聚合层**：

- **AgentExtension** 公共形态：当前仅 `{ metadata, runtimeState? }`（src/host/extension/types.ts）。`tools?` / `skillPrompt?` / `handlers?` / `searchMeta?` 按 Phase 3b+ 按需追加，**今天读取这些字段会拿到 `undefined`**
- **ExtensionRuntimeState** 与 `PluginState` 字面量对齐（编译期 sanity check 保证）；skill 默认 `'active'`，plugin 跟随 `LoadedPlugin.state`
- **Adapter**：`loadedPluginToExtension(plugin)` / `parsedSkillToExtension(skill)`
- **首个消费方**：`CapabilityRecommender` 已迁到 `ExtensionRegistry`，不再直读 `PluginRegistry`

**仍未迁移**：
- ExtensionRegistry **不**拥有 lifecycle，副作用仍归 `PluginRegistry` / `SkillDiscoveryService`
- `messageBuild` / `extensionOpsService` 等仍直读 `PluginRegistry`（"未全迁"而非"漏洞"）
- 关账依据：[docs/audits/2026-05-28-d2-phase3b-skip-decision.md](../audits/2026-05-28-d2-phase3b-skip-decision.md)
- 实施进度详见 [docs/designs/extension-union-blueprint.md § F](../designs/extension-union-blueprint.md#f-实施进度2026-05-28-收口)

### registerTool 冲突语义对齐（2026-05-28，E4 行为变更）

`registerTool` 与 `registerToolModule` 对命名冲突的处理**统一为抛错**（commit `6a7f7cd7`）。原 `registerTool` 走 `protocolRegistry.register()` 的幂等覆盖路径被废弃 — 重复注册同名工具现在会抛错，与 `registerToolModule` 行为对齐。

**影响**：依赖隐式覆盖行为的 builtin plugin 或第三方 plugin 现在会启动失败，需要在 activate 前显式 unregister 或改名。

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| PluginRegistry | `pluginRegistry.ts` | 插件生命周期管理 + PluginAPI v2 实现 + builtin 加载 |
| PluginLoader | `pluginLoader.ts` | 第三方插件磁盘发现和加载（`discoverPlugins` / `loadPlugin` / `watchPluginsDir`）|
| PluginAPI | `types.ts` | 插件 API 接口定义（`pluginApiVersion: 2`）|
| Builtin Loader | `pluginRegistry.loadBuiltinPlugins()` | `initialize()` 时静态 import 7 个 builtin manifest+entry，与 host 同 bundle |
| PluginStorage | `pluginStorage.ts` | 插件持久化存储（SQLite）|

---

## 两类插件：builtin vs 第三方

PluginAPI v2（`ccf03328`）落地后，"插件"明确分成两类，安全模型不同：

| 维度 | Builtin Plugin | 第三方 Plugin |
|------|---------------|--------------|
| 分发 | 与 host 同 bundle 编译，esbuild tree-shake | 用户目录磁盘加载 |
| 注册 | `loadBuiltinPlugins()` 硬编码静态 import | `discoverPlugins` / `loadPlugin` / `watchPluginsDir` |
| 内部 API | 可直接 import host 内部模块（sharp / artifact / ModelRouter），不经 PluginAPI | 仅能用 PluginAPI 暴露的能力 |
| 工具命名 | `registerToolModule(m, { prefixWithPluginId: false })` 保留原工具名 | `registerToolModule(m)` 强制加 `${pluginId}:` 前缀隔离 |
| reload | `reloadPlugin()` 早期 return（`rootPath` 以 `builtin:` 开头）| 支持运行时热加载/卸载 |
| 信任 | 随主包审计，等同核心代码 | 安全模型依赖前缀隔离 + manifest permissions + review |

> Builtin plugin 用 opt-out 前缀的目的：工具名保持 `image_process` 等不变，避免破坏 executionPhase 分类、ToolSearch deferredTools 注册、LLM prompt / cache / eval baseline——外部观察行为完全一致。

---

## Builtin Plugins（首发 7 个）

2026-05-19 起把 6 个多模态能力 + 桌面能力从 `tools/modules/` 剥离成 builtin plugin，验证 PluginAPI v2 框架可用（首发 `imageProcess` 选最干净的：无 API key、无 auth、只依赖 sharp + 内部 artifact 工具）：

| Plugin ID | capabilities | permissions | 说明 |
|-----------|-------------|-------------|------|
| `builtin.imageProcess` | image-processing | filesystem | 图片处理（格式转换/压缩/缩放/放大） |
| `builtin.audioProcessing` | audio-processing / stt / tts | filesystem, network | 语音转文字 + 文字转语音（GLM-ASR / GLM-TTS） |
| `builtin.videoGeneration` | video-generation | filesystem, network | 视频生成（CogVideoX-2 异步任务 + GLM prompt 扩写） |
| `builtin.imageCreation` | image-generation / annotation | filesystem, network | AI 图片生成 + 标注（CogView-4 / FLUX.2 / 智谱视觉） |
| `builtin.browserControl` | browser-control | filesystem, network | 浏览器与 in-app HTML 验证工具集（Playwright） |
| `builtin.computerUse` | computer-use / ocr | filesystem, shell | macOS 桌面控制 + Vision OCR（AXUIElement / 截图，仅 macOS） |
| `builtin.photoArchive` | photo-archive / image-search | filesystem, shell | macOS 相册归档（Photos.app + Vision 主题/人脸聚类，仅 macOS） |

文件位置：`src/host/plugins/builtin/<name>/index.ts`（`manifest` + `activate(api)` 入口）。`pluginRegistry.initialize()` 调 `loadBuiltinPlugins()` 把这些 manifest+entry 静态 import 进 registry（`rootPath` 标记为 `builtin:${id}`），让 esbuild tree-shake 到 host 同 bundle；第三方磁盘加载链路原样保留、互不干扰。

```typescript
// src/host/plugins/builtin/imageProcess/index.ts
export const manifest: PluginManifest = {
  id: 'builtin.imageProcess',
  name: 'Image Process',
  surfaces: ['tools'],
  capabilities: ['image-processing'],
  permissions: ['filesystem'],
  // ...
};

export async function activate(api: PluginAPI): Promise<void> {
  // opt-out 前缀：保留原工具名 `image_process`，不破坏外部观察行为
  api.registerToolModule(imageProcessModule, { prefixWithPluginId: false });
}
```

---

## PluginAPI v2

`pluginApiVersion: 2`，插件可 runtime guard 探测。v1 = 仅 tools/hooks/storage；v2 在此之上增加 4 个受控能力（`types.ts` 定义，`pluginRegistry.ts` 实现，全部走单例委托 + 静态白名单 + frozen 投影）：

| 能力 | 签名 | 安全闸门 |
|------|------|---------|
| `getApiKey(provider)` | `(PluginApiKeyProvider) => Promise<string \| undefined>` | 15 provider 白名单（`ALLOWED_PROVIDERS` ReadonlySet runtime 校验，防 TS 类型擦除绕过）；返回明文 key，插件不应 log / 持久化 / 外发 |
| `getCurrentUser()` | `() => PluginUserSnapshot \| null` | 仅返回 `{ id, isAdmin }`；走 admin trust-gate，未经服务端验证的 cached session 强制 `isAdmin: false` |
| `getConstants(namespace)` | `(namespace) => Readonly<Record<string, unknown>>` | 4 桶（`models` / `providers` / `pricing` / `timeouts`），双层 `Object.freeze` 防写；`providers` 已过滤内部代理 URL（zhipu/zhipuCoding/kimiK25），只留公开端点 |
| `registerToolModule(module, opts?)` | `(ToolModule, { prefixWithPluginId? }) => void` | 新 ToolModule 协议（ToolContext + emit + artifact）；默认加 `${pluginId}:` 前缀，仅 builtin 可 opt-out；与 `registerTool` 双通道共享重名检查 |

> ⚠️ 新增 provider 白名单时必须**同步**更新 `types.ts` 的 `PluginApiKeyProvider` 类型 **和** `pluginRegistry.ts` 的 `ALLOWED_PROVIDERS` 运行时 Set——类型擦除后只剩 Set 这道防线。

---

## Plugin 化边界 — 三层 RED 分类（[ADR-017](../decisions/017-plugin-boundary-three-layers.md)）

Step 1-6 剥完 7 个 builtin plugin 后，Step 8 计划剥 `src/host/desktop/` 时发现这些 service 深度耦合 conversationRuntime 内部状态（`messages` / `systemPrompt` / `modelConfig`），**不适合**当前 PluginAPI v2 剥成 plugin。为避免"按不能 plugin 化命名的层"沦为垃圾桶（任何难剥 service 都能进 core），ADR-017 把 11 个难剥 service 按性质拆三层，各有明确判断标准：

| 层 | 性质 | 判断标准 | 长期归宿 |
|----|------|---------|---------|
| **Prompt Context Contributors**（9 个）| 每轮 turn 向 system prompt 注入动态 context block，不持有控制状态 | 输出落入 system prompt / 绑定 turn 生命周期 / 受 token 预算约束 / 不仲裁工具结果或 plan | 未来 PluginAPI v3 的 ContextContributor 接口 |
| **Runtime Planning State** | 持有 agent loop 一等公民的 plan/task 控制状态，多模块直接读写 | `RuntimeContext` 字段 / agent loop 6+ 模块读写 | 留在 core，不 plugin 化 |
| **Assembly Policy** | context pressure 计算 + token 预算决定，编排上面两层 | 决定"注入什么、注入多少" | 留在 core（`conversationRuntime` / `desktopContextBridge`）|

配套（`90eadb7a`）：`conversationRuntime` 的 desktop 直接 import 收敛进 `src/host/desktop/desktopContextBridge.ts`（`bootstrapDesktopTurnContext` facade），`bootstrapDesktopDerivedContext` 主体从 ~165 行收成 ~70 行，只保留 Assembly Policy 层职责。

---

## 插件结构

```
my-plugin/
├── manifest.json      # 插件元数据
├── index.js           # 入口文件
└── icon.png           # 插件图标（可选）
```

### manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A sample plugin",
  "author": "Author Name",
  "main": "index.js",
  "permissions": ["tools", "storage", "events"]
}
```

### 入口文件 (index.js)

```javascript
module.exports = {
  activate(api) {
    // 插件激活时调用
    api.registerTool({
      name: 'my_tool',
      description: 'My custom tool',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string' }
        },
        required: ['input']
      },
      generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
      requiresPermission: false,
      permissionLevel: 'read',
      async execute(params, context) {
        return {
          success: true,
          output: `Processed: ${params.input}`
        };
      }
    });
  },

  deactivate() {
    // 插件停用时调用
    console.log('Plugin deactivated');
  }
};
```

---

## 生命周期

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   discover  │ ──▶ │    load     │ ──▶ │  activate   │
│  扫描目录    │     │  解析配置    │     │  调用入口    │
└─────────────┘     └─────────────┘     └─────────────┘
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │   running   │
                                        │   运行中     │
                                        └─────────────┘
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │ deactivate  │
                                        │   停用      │
                                        └─────────────┘
```

### 1. Discover（发现）

扫描插件目录，查找 `manifest.json` 文件：

```typescript
const plugins = await discoverPlugins();
// 返回: PluginManifest[]
```

### 2. Load（加载）

解析 manifest 并加载入口文件：

```typescript
const loaded = await loadPlugin(manifest);
// 返回: LoadedPlugin
```

### 3. Activate（激活）

调用插件的 `activate(api)` 方法：

```typescript
await plugin.module.activate(api);
```

### 4. Deactivate（停用）

调用插件的 `deactivate()` 方法：

```typescript
await plugin.module.deactivate?.();
```

---

## Plugin API

插件通过 `api` 对象与系统交互。下面是 **v1** 工具/存储/事件接口；v2 新增的 `getApiKey` / `getCurrentUser` / `getConstants` / `registerToolModule` 见上文 [PluginAPI v2](#pluginapi-v2)。

### registerTool

注册自定义工具：

```typescript
api.registerTool({
  name: string;
  description: string;
  inputSchema: JSONSchema;
  generations: GenerationId[];
  requiresPermission: boolean;
  permissionLevel: 'read' | 'write' | 'execute' | 'network';
  execute: (params, context) => Promise<ToolExecutionResult>;
});
```

### unregisterTool

注销工具：

```typescript
api.unregisterTool('my_tool');
```

### storage

本地存储接口：

```typescript
// 存储数据
await api.storage.set('key', { value: 'data' });

// 读取数据
const data = await api.storage.get('key');

// 删除数据
await api.storage.delete('key');
```

### events

事件订阅：

```typescript
// 订阅事件
const unsubscribe = api.events.on('agent:message', (data) => {
  console.log('New message:', data);
});

// 取消订阅
unsubscribe();
```

---

## 插件目录

插件存储在以下目录：

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/code-agent/plugins/` |
| Windows | `%APPDATA%/code-agent/plugins/` |
| Linux | `~/.config/code-agent/plugins/` |

---

## 权限系统

插件需要在 manifest 中声明权限：

| 权限 | 说明 |
|------|------|
| `tools` | 注册/注销工具 |
| `storage` | 访问本地存储 |
| `events` | 订阅事件 |
| `network` | 网络请求 |

---

## 使用示例

### 启用插件

```typescript
const registry = getPluginRegistry();
await registry.enablePlugin('my-plugin');
```

### 禁用插件

```typescript
await registry.disablePlugin('my-plugin');
```

### 列出插件

```typescript
const plugins = registry.getPlugins();
plugins.forEach(p => {
  console.log(`${p.manifest.name}: ${p.state}`);
});
```

---

## 文件结构

```
src/host/plugins/
├── index.ts           # 导出入口
├── types.ts           # 类型定义（PluginAPI v1 + v2、ToolModule、白名单类型）
├── pluginRegistry.ts  # 插件注册表 + PluginAPI v2 实现 + loadBuiltinPlugins()
├── pluginLoader.ts    # 第三方插件磁盘加载器
├── pluginStorage.ts   # 持久化存储（SQLite）
└── builtin/           # 7 个 builtin plugin（imageProcess / audioProcessing / videoGeneration
    │                  #   / imageCreation / browserControl / computerUse / photoArchive）
    └── <name>/index.ts  # 每个含 manifest + activate(api) 入口
```

---

## 持久化存储

插件存储使用 SQLite 实现持久化：

```typescript
// 获取存储接口
const storage = api.getStorage();

// 存储会持久化到 SQLite 数据库
await storage.set('user_config', { theme: 'dark', language: 'zh' });

// 应用重启后数据仍然存在
const config = await storage.get('user_config');
```

存储表结构：

```sql
CREATE TABLE plugin_storage (
  key TEXT PRIMARY KEY,      -- 格式: plugin:{pluginId}:{key}
  value TEXT NOT NULL,       -- JSON 序列化的值
  updated_at INTEGER NOT NULL
);
```

---

## 注意事项

1. **安全性**: 插件在隔离环境中运行，但仍需谨慎安装未知来源的插件
2. **版本兼容**: 插件需要声明兼容的 Code Agent 版本
3. **热加载**: 支持运行时加载/卸载插件，无需重启应用
