# TASK-06: 扩展性增强

> 负责 Agent: Agent-Extension
> 优先级: P2
> 预估时间: 2 周
> 依赖: TASK-05 完成
> 状态: ✅ 已完成

---

## 目标

1. 实现工具注册装饰器，简化工具定义
2. 构建插件系统雏形
3. MCP 配置支持热更新

---

## 前置检查

开始前确认：
- [ ] TASK-05 (编码规范统一) 已完成
- [ ] 命名规范已统一
- [ ] `npm run lint` 零警告
- [ ] `npm run typecheck` 通过

---

## 任务清单

### 6.1 工具注册装饰器

**目标**: 简化工具定义，减少样板代码

**现状**: 每个工具 50+ 行定义
```typescript
// 现状：冗长的工具定义
export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file...',
  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      encoding: { type: 'string', default: 'utf-8' },
    },
    required: ['file_path'],
  },
  async execute(params: ReadFileParams, context: ToolContext): Promise<ToolResult> {
    // 执行逻辑
  }
};
```

**改造后**: 装饰器 + 类
```typescript
// 改造后：简洁的装饰器定义
@Tool('read_file', {
  generations: 'gen1+',      // 语法糖：gen1 及以上
  permission: 'read',
})
@Description('Read the contents of a file from the filesystem')
@Param('file_path', { type: 'string', required: true, description: 'Path to the file' })
@Param('encoding', { type: 'string', default: 'utf-8' })
class ReadFileTool implements ITool {
  async execute(params: ReadFileParams, ctx: ToolContext): Promise<ToolResult> {
    // 只写核心逻辑
  }
}
```

**新增文件**:
- `src/main/tools/decorators/index.ts`
- `src/main/tools/decorators/tool.ts`
- `src/main/tools/decorators/param.ts`
- `src/main/tools/decorators/description.ts`

**装饰器实现**:
```typescript
// src/main/tools/decorators/tool.ts
import 'reflect-metadata';

interface ToolOptions {
  generations: GenerationId[] | string;  // 支持 'gen1+' 语法
  permission?: 'read' | 'write' | 'execute' | 'none';
  requiresConfirmation?: boolean;
}

const TOOL_METADATA_KEY = Symbol('tool');

export function Tool(name: string, options: ToolOptions): ClassDecorator {
  return (target: Function) => {
    const metadata = {
      name,
      ...options,
      generations: parseGenerations(options.generations),
    };
    Reflect.defineMetadata(TOOL_METADATA_KEY, metadata, target);

    // 自动注册到 ToolRegistry
    ToolRegistry.register(target);
  };
}

function parseGenerations(input: GenerationId[] | string): GenerationId[] {
  if (Array.isArray(input)) return input;
  // 解析 'gen1+' → ['gen1', 'gen2', ..., 'gen8']
  const match = input.match(/^(gen\d)\+$/);
  if (match) {
    const start = parseInt(match[1].replace('gen', ''));
    return Array.from({ length: 9 - start }, (_, i) => `gen${start + i}` as GenerationId);
  }
  return [input as GenerationId];
}
```

```typescript
// src/main/tools/decorators/param.ts
interface ParamOptions {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  default?: unknown;
  description?: string;
  enum?: string[];
}

const PARAMS_METADATA_KEY = Symbol('params');

export function Param(name: string, options: ParamOptions): ClassDecorator {
  return (target: Function) => {
    const existing = Reflect.getMetadata(PARAMS_METADATA_KEY, target) || [];
    existing.push({ name, ...options });
    Reflect.defineMetadata(PARAMS_METADATA_KEY, existing, target);
  };
}
```

**步骤**:
- [ ] 安装 `reflect-metadata`: `npm install reflect-metadata`
- [ ] 配置 `tsconfig.json`: `"emitDecoratorMetadata": true`
- [ ] 实现 `@Tool` 装饰器
- [ ] 实现 `@Param` 装饰器
- [ ] 实现 `@Description` 装饰器
- [ ] 修改 `ToolRegistry` 支持装饰器注册
- [ ] 迁移 3 个工具验证（read_file, bash, glob）
- [ ] 编写装饰器使用文档

---

### 6.2 插件系统雏形

**目标**: 支持本地插件加载，为第三方扩展做准备

**新增目录**:
```
src/main/plugin/
├── types.ts          # 插件接口定义
├── pluginLoader.ts   # 插件加载器
├── pluginRegistry.ts # 插件注册表
└── index.ts          # 导出
```

**插件接口**:
```typescript
// src/main/plugin/types.ts

export interface Plugin {
  id: string;                    // 唯一标识，如 "my-plugin"
  name: string;                  // 显示名称
  version: string;               // 语义化版本
  description?: string;
  author?: string;

  // 提供的能力
  tools?: ToolDefinition[];      // 新增工具
  skills?: SkillDefinition[];    // 新增 Skill
  mcpServers?: MCPServerConfig[]; // 新增 MCP Server

  // 生命周期钩子
  hooks?: PluginHooks;
}

export interface PluginHooks {
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
  beforeToolExecute?: (tool: string, params: unknown) => Promise<unknown>;
  afterToolExecute?: (tool: string, result: ToolResult) => Promise<ToolResult>;
  beforeAgentLoop?: (context: AgentContext) => Promise<void>;
  afterAgentLoop?: (context: AgentContext, result: AgentResult) => Promise<void>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  main: string;         // 入口文件
  description?: string;
  author?: string;
  permissions?: string[];  // 请求的权限
}
```

**插件加载器**:
```typescript
// src/main/plugin/pluginLoader.ts

import { Plugin, PluginManifest } from './types';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

export class PluginLoader {
  private pluginDir: string;

  constructor() {
    // ~/.code-agent/plugins/
    this.pluginDir = join(app.getPath('home'), '.code-agent', 'plugins');
  }

  async loadAll(): Promise<Plugin[]> {
    if (!existsSync(this.pluginDir)) return [];

    const plugins: Plugin[] = [];
    const dirs = readdirSync(this.pluginDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      try {
        const plugin = await this.loadPlugin(join(this.pluginDir, dir.name));
        if (plugin) plugins.push(plugin);
      } catch (error) {
        logger.warn(`Failed to load plugin: ${dir.name}`, { error });
      }
    }

    return plugins;
  }

  private async loadPlugin(pluginPath: string): Promise<Plugin | null> {
    const manifestPath = join(pluginPath, 'manifest.json');
    if (!existsSync(manifestPath)) return null;

    const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    // 验证 manifest
    if (!manifest.id || !manifest.main) {
      throw new Error('Invalid plugin manifest');
    }

    // 加载插件模块
    const mainPath = join(pluginPath, manifest.main);
    const module = await import(mainPath);

    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      ...module.default,
    };
  }
}
```

**插件注册表**:
```typescript
// src/main/plugin/pluginRegistry.ts

export class PluginRegistry {
  private plugins: Map<string, Plugin> = new Map();
  private loader: PluginLoader;

  async initialize(): Promise<void> {
    const plugins = await this.loader.loadAll();
    for (const plugin of plugins) {
      await this.register(plugin);
    }
  }

  async register(plugin: Plugin): Promise<void> {
    // 调用 onLoad 钩子
    if (plugin.hooks?.onLoad) {
      await plugin.hooks.onLoad();
    }

    // 注册工具
    if (plugin.tools) {
      for (const tool of plugin.tools) {
        ToolRegistry.register({ ...tool, source: `plugin:${plugin.id}` });
      }
    }

    // 注册 Skills
    if (plugin.skills) {
      // 通过 CloudConfigService 注入本地 Skills
    }

    // 注册 MCP Servers
    if (plugin.mcpServers) {
      for (const server of plugin.mcpServers) {
        await MCPClientManager.addServer(server);
      }
    }

    this.plugins.set(plugin.id, plugin);
    logger.info(`Plugin loaded: ${plugin.name} v${plugin.version}`);
  }

  async unregister(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    if (plugin.hooks?.onUnload) {
      await plugin.hooks.onUnload();
    }

    // 移除注册的工具、Skills、MCP Servers
    this.plugins.delete(pluginId);
  }

  getPlugin(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  getAllPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }
}
```

**步骤**:
- [ ] 创建 `src/main/plugin/` 目录
- [ ] 实现 Plugin 接口
- [ ] 实现 PluginLoader
- [ ] 实现 PluginRegistry
- [ ] 集成到 bootstrap 流程
- [ ] 添加设置页面「插件管理」入口
- [ ] 编写示例插件文档

**示例插件结构**:
```
~/.code-agent/plugins/my-plugin/
├── manifest.json
└── index.js
```

```json
// manifest.json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "main": "index.js",
  "description": "A sample plugin",
  "author": "Your Name"
}
```

---

### 6.3 MCP 配置热更新

**目标**: MCP Server 配置从云端获取，支持动态添加/移除

**修改文件**:
- `src/main/mcp/mcpClientManager.ts`
- `src/main/services/cloud/cloudConfigService.ts`

**云端配置新增字段**:
```typescript
interface CloudConfig {
  // ... 现有字段
  mcpServers: MCPServerConfig[];
}

interface MCPServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse';
  enabled: boolean;
  config: {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  };
  requiredEnvVars?: string[];  // 需要的环境变量
}
```

**步骤**:
- [ ] 云端 `/api/v1/config` 添加 `mcpServers` 字段
- [ ] `MCPClientManager` 启动时从 `CloudConfigService` 读取配置
- [ ] 支持动态添加 Server：`MCPClientManager.addServer(config)`
- [ ] 支持动态移除 Server：`MCPClientManager.removeServer(id)`
- [ ] 设置页面显示 MCP 连接状态
- [ ] 支持手动「重连」按钮

**UI 需求**:
- 设置页面 → MCP 服务器列表
- 显示每个 Server 的连接状态（已连接/断开/错误）
- 启用/禁用开关
- 重连按钮

---

## 涉及文件汇总

| 操作 | 文件 |
|------|------|
| 新增 | `src/main/tools/decorators/*.ts` (4 个) |
| 新增 | `src/main/plugin/*.ts` (4 个) |
| 修改 | `src/main/tools/toolRegistry.ts` |
| 修改 | `src/main/mcp/mcpClientManager.ts` |
| 修改 | `src/main/services/cloud/cloudConfigService.ts` |
| 修改 | `vercel-api/api/v1/config.ts` |
| 修改 | `src/renderer/components/settingsPanel.tsx` |
| 修改 | `tsconfig.json` |

---

## 禁止修改

- 已有工具的执行逻辑（只重构定义方式）
- 核心 Agent 流程（只通过钩子扩展）

---

## 验收标准

- [ ] 至少 3 个工具使用装饰器定义
- [ ] 装饰器文档完整
- [ ] 插件系统可加载本地插件
- [ ] 示例插件可正常运行
- [ ] MCP 配置可从云端更新
- [ ] 设置页面显示 MCP 状态
- [ ] `npm run typecheck` 通过

---

## 交接备注

- **完成时间**: 2026-01-20
- **状态**: ✅ 已完成

### 6.1 工具装饰器 API

**位置**: `src/main/tools/decorators/`

**使用示例**:
```typescript
import { Tool, Param, Description, ITool, buildToolFromClass } from '../decorators';

@Description('Read file contents from filesystem')
@Tool('read_file', { generations: 'gen1+', permission: 'read' })
@Param('file_path', { type: 'string', required: true, description: 'Path to file' })
@Param('offset', { type: 'number', required: false })
class ReadFileTool implements ITool {
  async execute(params, context) { /* ... */ }
}

export const readFileTool = buildToolFromClass(ReadFileTool);
```

**已迁移工具**: `readDecorated.ts`, `globDecorated.ts`, `bashDecorated.ts`

### 6.2 插件系统

**位置**: `src/main/plugins/`

**插件目录**: `~/Library/Application Support/code-agent/plugins/`

**插件结构**:
```
my-plugin/
├── plugin.json (或 package.json)
└── index.js
```

**manifest 格式**:
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "main": "index.js"
}
```

**Plugin API**:
- `api.registerTool(tool)` - 注册工具 (自动添加 `pluginId:` 前缀)
- `api.unregisterTool(name)` - 注销工具
- `api.log(level, message)` - 日志
- `api.getStorage()` - 获取持久存储

### 6.3 MCP 配置热更新

**云端 API**: `/api/v1/config?section=mcpServers`

**配置格式**:
```typescript
interface MCPServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse';
  enabled: boolean;
  config: { command?, args?, url?, env? };
  requiredEnvVars?: string[];
  description?: string;
}
```

**热更新函数**: `refreshMCPServersFromCloud()`

**IPC Actions** (domain: `domain:mcp`):
- `getServerStates` - 获取所有服务器状态
- `setServerEnabled` - 启用/禁用服务器
- `reconnectServer` - 重连服务器
- `refreshFromCloud` - 从云端刷新配置

**设置页面**: 新增 MCP Tab，显示服务器状态和管理功能

### 下游 Agent 注意事项

1. **新增依赖**: `reflect-metadata` 已添加到 package.json
2. **tsconfig 改动**: 启用了 `experimentalDecorators` 和 `emitDecoratorMetadata`
3. **ToolRegistry 新增方法**: `unregister(name)`, `getToolRegistry()`, `registerTool()`, `unregisterTool()`
4. **插件系统**: 启动时异步初始化，不阻塞主流程
5. **MCP IPC_DOMAINS.MCP**: 使用 `domain:mcp` 通道，新增 4 个 actions
