# Agent-Extension 提示词

> 用途：执行 TASK-06 扩展性增强
> 预估时间：2 周
> 依赖：TASK-05 完成后开始

---

## 角色设定

你是一个专注于系统扩展性的 Agent。你的任务是为 Code Agent 添加工具装饰器和插件系统，提升可扩展性。

## 任务文档

请阅读 `docs/refactor/TASK-06-extension.md` 获取详细任务清单。

## 前置条件

**开始前必须确认**：
- [ ] TASK-05 (编码规范统一) 已合并到 main
- [ ] 命名规范已统一
- [ ] `npm run lint` 零警告
- [ ] `npm run typecheck` 通过

## 工作范围

### 你的任务

1. **工具注册装饰器**
   - 实现 `@Tool`, `@Param`, `@Description`
   - 迁移 3 个工具验证

2. **插件系统雏形**
   - Plugin 接口定义
   - PluginLoader 实现
   - PluginRegistry 实现

3. **MCP 配置热更新**
   - 云端配置支持
   - 动态添加/移除 Server

### 你负责的文件

```
# 新增
src/main/tools/decorators/
├── index.ts
├── tool.ts
├── param.ts
└── description.ts

src/main/plugin/
├── types.ts
├── pluginLoader.ts
├── pluginRegistry.ts
└── index.ts

# 修改
src/main/tools/toolRegistry.ts
src/main/mcp/mcpClientManager.ts
src/main/services/cloud/cloudConfigService.ts
vercel-api/api/v1/config.ts
src/renderer/components/settingsPanel.tsx
tsconfig.json
```

## 工作流程

1. **拉取最新代码**
   ```bash
   git checkout main
   git pull
   git checkout -b feature/task-06-extension
   ```

2. **实现装饰器**
   - 安装 reflect-metadata
   - 配置 tsconfig
   - 实现 @Tool, @Param, @Description
   - 迁移 read_file, bash, glob 验证

3. **实现插件系统**
   - 定义 Plugin 接口
   - 实现 PluginLoader
   - 实现 PluginRegistry
   - 集成到 bootstrap

4. **MCP 热更新**
   - 云端添加 mcpServers 配置
   - MCPClientManager 支持动态操作
   - 设置页面显示状态

5. **验证**
   ```bash
   npm run typecheck
   npm run dev

   # 测试装饰器工具
   # 测试插件加载
   # 测试 MCP 热更新
   ```

6. **提交**
   ```bash
   git add .
   git commit -m "feat(extension): 完成扩展性增强 TASK-06"
   git push origin feature/task-06-extension
   ```

## 关键技术点

### 装饰器实现

```typescript
// 安装依赖
npm install reflect-metadata

// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

```typescript
// src/main/tools/decorators/tool.ts
import 'reflect-metadata';

const TOOL_METADATA_KEY = Symbol('tool');

interface ToolOptions {
  generations: GenerationId[] | string;
  permission?: 'read' | 'write' | 'execute' | 'none';
}

export function Tool(name: string, options: ToolOptions): ClassDecorator {
  return (target: Function) => {
    const metadata = {
      name,
      ...options,
      generations: parseGenerations(options.generations),
    };
    Reflect.defineMetadata(TOOL_METADATA_KEY, metadata, target);
    ToolRegistry.register(target);
  };
}

// 支持 'gen1+' 语法
function parseGenerations(input: GenerationId[] | string): GenerationId[] {
  if (Array.isArray(input)) return input;
  const match = input.match(/^(gen\d)\+$/);
  if (match) {
    const start = parseInt(match[1].replace('gen', ''));
    return Array.from({ length: 9 - start }, (_, i) => `gen${start + i}` as GenerationId);
  }
  return [input as GenerationId];
}
```

### 工具使用装饰器

```typescript
// 改造后的工具定义
@Tool('read_file', {
  generations: 'gen1+',
  permission: 'read',
})
@Description('Read the contents of a file from the filesystem')
@Param('file_path', { type: 'string', required: true })
@Param('encoding', { type: 'string', default: 'utf-8' })
class ReadFileTool implements ITool {
  async execute(params: ReadFileParams, ctx: ToolContext): Promise<ToolResult> {
    // 只写核心逻辑
  }
}
```

### Plugin 接口

```typescript
// src/main/plugin/types.ts
export interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  tools?: ToolDefinition[];
  skills?: SkillDefinition[];
  mcpServers?: MCPServerConfig[];
  hooks?: PluginHooks;
}

export interface PluginHooks {
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
  beforeToolExecute?: (tool: string, params: unknown) => Promise<unknown>;
  afterToolExecute?: (tool: string, result: ToolResult) => Promise<ToolResult>;
}
```

### 插件目录结构

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
  "main": "index.js"
}
```

### MCP 云端配置

```typescript
// CloudConfig 新增字段
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
  };
}
```

## 验收标准

- [ ] 至少 3 个工具使用装饰器定义
- [ ] 装饰器文档完整
- [ ] 插件系统可加载本地插件
- [ ] 示例插件可正常运行
- [ ] MCP 配置可从云端更新
- [ ] 设置页面显示 MCP 状态
- [ ] `npm run typecheck` 通过

## 注意事项

1. **装饰器需要 TypeScript 配置**：必须启用相关选项
2. **reflect-metadata 要在入口导入**：`import 'reflect-metadata'`
3. **插件加载要处理错误**：不能因插件问题崩溃
4. **MCP 热更新要保持连接**：不要断开正常的连接
5. **不要改已有工具逻辑**：只重构定义方式

## 与其他 Agent 的边界

- 依赖 TASK-05 完成的命名规范
- 不要修改核心 Agent 流程
- 不要修改已有工具的执行逻辑
