# 插件系统与 Capability Center 架构

> 扩展 Agent Neo 能力的插件机制，以及 2026-05 后本地能力货架的边界

## 概述

Code Agent 提供插件系统，允许开发者扩展 Agent 的能力。插件可以：
- 注册自定义工具
- 访问本地存储
- 订阅事件

2026-05-15 后，产品层新增 `Capability Center`。插件系统负责可执行扩展的生命周期，Capability Center 负责统一发现和管理：把 plugin、skill、MCP template、tool bundle、channel adapter、workflow recipe、connector、agent engine 放到同一张本地货架里展示、审计和跳转配置。

| 层 | 职责 | 文件 |
|----|------|------|
| Plugin System | 加载可执行插件，提供生命周期和 API | `src/main/plugins/*` |
| Skill Discovery | 发现 builtin/user/library/project skills，并注册到 ToolSearch | `src/main/services/skills/skillDiscoveryService.ts` |
| Capability Center | 汇总能力清单、requirements、risk、runtime state、install plan 和 action | `src/main/services/capabilities/capabilityCenterService.ts` |
| Curated Registry | 本地 curated catalog，带 source hash、review 信息和模板定义 | `docs/capabilities/local-curated-registry.json`、`registry.schema.json` |
| MCP Draft 安装 | 根据 template 写入项目 `.code-agent/mcp.json` 的 disabled server；删除时只回滚带 `capabilityDraft` 元数据的草稿 | `capabilityDraftResolver.ts` |
| Agent Engine 能力卡 | Native / Codex CLI / Claude Code 作为 `agent_engine` kind 展示安装和运行状态 | `agentEngineCapabilityItems.ts` |

当前边界：
- Capability Center 可以生成本地 disabled draft，但不会自动启用 MCP，也不会自动连接外部服务。
- 远程 marketplace 还没有接入；`remote / marketplace` source kind 是后续兼容位。
- 手写 MCP 配置、普通插件和项目私有 skill 不会被 Capability Center 的 draft 删除动作误删。

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| PluginRegistry | pluginRegistry.ts | 插件生命周期管理 |
| PluginLoader | pluginLoader.ts | 插件发现和加载 |
| PluginAPI | types.ts | 插件 API 接口定义 |

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

插件通过 `api` 对象与系统交互：

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
src/main/plugins/
├── index.ts           # 导出入口
├── types.ts           # 类型定义
├── pluginRegistry.ts  # 插件注册表
├── pluginLoader.ts    # 插件加载器
└── pluginStorage.ts   # 持久化存储（SQLite）
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
