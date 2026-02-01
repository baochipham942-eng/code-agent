# Code Agent 工具系统架构分析

## 📋 概述

Code Agent 的工具系统是一个高度模块化的架构，支持多种工具类型：
- **内置工具** - 本地实现的核心工具（bash, readFile, writeFile等）
- **MCP工具** - 通过 Model Context Protocol 集成的外部服务工具
- **技能工具** - 封装成工具的预定义技能
- **云端工具** - 通过 Vercel API 提供的云端服务工具

## 🏗️ 核心架构

### 1. 类型定义层

**文件**: `src/shared/types/tool.ts`

```typescript
// 工具输入参数定义
interface ToolInput {
  name: string;           // 工具名称
  arguments?: Record<string, unknown>;  // 参数对象
}

// 工具输出结果定义
interface ToolOutput {
  success: boolean;       // 执行是否成功
  output?: string;        // 标准输出
  error?: string;         // 错误信息
  duration?: number;      // 执行时长（毫秒）
  metadata?: Record<string, unknown>;  // 元数据（imagePath等）
}

// 工具元数据定义
interface ToolMetadata {
  name: string;           // 工具名称
  description: string;    // 工具描述
  inputSchema: JSONSchema; // 参数的 JSON Schema
}
```

### 2. 装饰器系统

**文件**: `src/main/tools/decorators/tool.ts`

使用 TypeScript 类装饰器来定义工具，提供类型安全的声明式 API。

```typescript
@Tool({
  name: 'bash',
  description: 'Execute shell commands',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number' }
    }
  }
})
export class BashTool {
  execute(input: ToolInput): ToolOutput {
    // 工具实现
  }
}
```

**核心机制**：
- 使用 `Reflect.getMetadata()` 存储工具元数据
- 元数据键: `TOOL_METADATA_KEY = 'code-agent:tool-metadata'`
- 运行时通过 `getToolMetadata()` 获取工具定义

### 3. 工具注册表

**文件**: `src/main/tools/toolRegistry.ts`

**主要职责**：
- 管理所有已注册的工具
- 提供工具查询接口
- 生成 Claude 可用的工具列表

**核心方法**：

```typescript
class ToolRegistry {
  // 注册单个工具
  register(tool: ToolImplementation): void;

  // 批量注册工具
  registerAll(tools: ToolImplementation[]): void;

  // 获取工具实例
  get(name: string): ToolImplementation | undefined;

  // 列出所有工具
  list(): ToolImplementation[];

  // 生成 Claude 用的工具列表（JSON Schema格式）
  generateToolList(): ClaudeToolDefinition[];

  // 按命名空间过滤工具
  getToolsByNamespace(namespace: string): ToolImplementation[];
}
```

**工具命名空间**：
- `builtin` - 内置工具（bash, readFile, writeFile等）
- `mcp` - MCP 工具
- `skill` - 技能工具
- `cloud` - 云端工具

### 4. 工具执行器

**文件**: `src/main/tools/toolExecutor.ts`

**执行流程**：

```
1. 接收工具调用请求 (ToolInput)
         ↓
2. 从注册表查找工具实例
         ↓
3. 验证参数是否符合 Schema
         ↓
4. 执行工具实现
         ↓
5. 捕获错误/超时
         ↓
6. 返回标准化结果 (ToolOutput)
```

**核心代码**：

```typescript
class ToolExecutor {
  async executeTool(input: ToolInput): Promise<ToolOutput> {
    const startTime = Date.now();

    // 1. 获取工具实例
    const tool = registry.get(input.name);
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${input.name}`
      };
    }

    // 2. 验证参数
    const validation = validateInput(input, tool.metadata);
    if (!validation.valid) {
      return {
        success: false,
        error: `Invalid arguments: ${validation.errors.join(', ')}`
      };
    }

    // 3. 执行工具（带超时保护）
    try {
      const result = await this.executeWithTimeout(
        () => tool.execute(input),
        timeout || 120000
      );

      return {
        success: true,
        output: result,
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }
}
```

## 🔧 工具类型详解

### 内置工具 (Builtin Tools)

**位置**: `src/main/tools/decorated/`

**示例工具**：

#### BashTool
```typescript
@Tool({
  name: 'bash',
  description: 'Execute shell commands',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds'
      }
    }
  }
})
export class BashTool {
  async execute(input: ToolInput): Promise<ToolOutput> {
    const { command, timeout = 120000 } = input.arguments || {};
    
    const execResult = await exec(command, { timeout });
    
    return {
      success: true,
      output: execResult.stdout
    };
  }
}
```

**其他内置工具**：
- `ReadFileTool` - 读取文件
- `WriteFileTool` - 写入文件
- `EditFileTool` - 编辑文件
- `GlobTool` - 文件匹配
- `GrepTool` - 文件内容搜索

### MCP 工具 (Model Context Protocol Tools)

**文件**: `src/main/tools/mcp/mcpTool.ts`

**作用**：动态调用 MCP 服务器提供的工具

**特性**：
- 运行时发现 MCP 工具
- 自动生成工具 Schema
- 支持多个 MCP 服务器

**执行流程**：

```
1. 连接到 MCP 服务器
         ↓
2. 调用 mcp_list_tools 获取可用工具列表
         ↓
3. 为每个 MCP 工具创建代理实例
         ↓
4. 执行时转发请求到 MCP 服务器
         ↓
5. 返回标准化结果
```

**代码片段**：

```typescript
export const mcpTool = {
  name: 'mcp',
  description: '调用 MCP 服务器工具',
  
  async execute({ server, tool, arguments }: MCPInput): Promise<ToolOutput> {
    // 调用 MCP 服务器
    const result = await callMCPTool(server, tool, arguments);
    
    return {
      success: true,
      output: result.output,
      metadata: {
        server,
        tool
      }
    };
  }
};
```

### 技能工具 (Skill Tools)

**文件**: `src/main/tools/skill/skillMetaTool.ts`

**作用**：将预定义的技能封装成 Claude 可调用的工具

**支持的技能类型**：
- `commit` - Git 提交
- `code-review` - 代码审查
- `test` - 运行测试
- `build` - 构建项目

**元数据生成**：

```typescript
function generateDescription(): string {
  return `调用预定义技能

可用技能：
- commit: 执行 Git 提交流程
- code-review: 审查代码变更
- test: 运行测试套件
- build: 构建项目

参数格式：
{
  "command": "技能名称",
  "args": "技能参数（可选）"
}`;
}
```

### 云端工具 (Cloud Tools)

**文件**:
- `vercel-api/lib/tools/CloudToolRegistry.ts` - 云端工具注册表
- `vercel-api/api/tools.ts` - 云端工具 API

**特性**：
- 通过 HTTP API 调用
- 支持云端服务（图片生成、PPT生成等）
- 统一的结果格式

**示例云端工具**：
- `image_generate` - AI 图片生成
- `ppt_generate` - PPT 生成
- `docx_generate` - Word 文档生成
- `chart_generate` - 图表生成

**API 路由**：

```typescript
app.post('/api/tools', async (req, res) => {
  const { action, ...args } = req.body;
  
  switch (action) {
    case 'list':
      return res.json(cloudToolRegistry.list());
    case 'image':
      return res.json(await generateImage(args));
    case 'ppt':
      return res.json(await generatePPT(args));
    // ...
  }
});
```

## 🔄 工具注册流程

### 启动时注册流程

```
应用启动
    ↓
创建 ToolRegistry 实例
    ↓
注册内置工具
    ├── BashTool
    ├── ReadFileTool
    ├── WriteFileTool
    ├── GlobTool
    └── ...
    ↓
注册技能工具
    └── skillMetaTool
    ↓
连接 MCP 服务器
    ↓
注册 MCP 工具
    └── mcpTool (动态)
    ↓
注册云端工具
    └── cloudToolRegistry
    ↓
生成 Claude 工具列表
    └── generateToolList()
    ↓
完成
```

**代码示例** (`src/main/tools/toolRegistry.ts`):

```typescript
// 初始化注册表
const registry = new ToolRegistry();

// 注册内置工具
registry.register(new BashTool());
registry.register(new ReadFileTool());
registry.register(new WriteFileTool());
// ...

// 注册技能工具
registry.register(skillMetaTool);

// 注册 MCP 工具（运行时动态）
// mcpTool 在连接服务器后注册

// 注册云端工具
cloudToolRegistry.initialize().then(() => {
  registry.registerAll(cloudToolRegistry.list());
});
```

## ⚙️ 工具执行流程

### Claude 调用工具的完整流程

```
1. Claude 生成工具调用请求
   {
     "tool": "bash",
     "arguments": {
       "command": "npm test"
     }
   }
         ↓
2. ToolExecutor 接收请求
         ↓
3. 验证工具是否存在
         ↓
4. 根据 JSON Schema 验证参数
         ↓
5. 执行工具实现
   - builtin: 直接调用方法
   - mcp: 转发到 MCP 服务器
   - skill: 执行技能脚本
   - cloud: 调用云端 API
         ↓
6. 捕获错误/超时
         ↓
7. 格式化输出
   {
     "success": true,
     "output": "...",
     "duration": 1234
   }
         ↓
8. 返回给 Claude
         ↓
9. Claude 根据结果继续对话
```

### 并行工具执行

**支持场景**：多个工具调用之间没有依赖关系

**实现机制**：

```typescript
// Claude 可能生成多个工具调用
const toolCalls = [
  { tool: 'bash', arguments: { command: 'npm test' } },
  { tool: 'bash', arguments: { command: 'npm run lint' } },
  { tool: 'readFile', arguments: { path: 'package.json' } }
];

// 并行执行
const results = await Promise.all(
  toolCalls.map(call => executor.executeTool(call))
);
```

## 📁 关键文件清单

### 核心系统

| 文件 | 职责 |
|------|------|
| `src/shared/types/tool.ts` | 工具类型定义 |
| `src/main/tools/toolRegistry.ts` | 工具注册表 |
| `src/main/tools/toolExecutor.ts` | 工具执行器 |
| `src/main/tools/decorators/tool.ts` | 工具装饰器 |

### 内置工具实现

| 文件 | 工具 |
|------|------|
| `src/main/tools/decorated/BashTool.ts` | bash |
| `src/main/tools/decorated/ReadFileTool.ts` | read_file |
| `src/main/tools/decorated/WriteFileTool.ts` | write_file |
| `src/main/tools/decorated/EditFileTool.ts` | edit_file |
| `src/main/tools/decorated/GlobTool.ts` | glob |
| `src/main/tools/decorated/GrepTool.ts` | grep |

### 外部工具集成

| 文件 | 职责 |
|------|------|
| `src/main/tools/mcp/mcpTool.ts` | MCP 工具封装 |
| `src/main/tools/skill/skillMetaTool.ts` | 技能工具 |
| `vercel-api/lib/tools/CloudToolRegistry.ts` | 云端工具注册 |
| `vercel-api/api/tools.ts` | 云端工具 API |

### 测试文件

| 文件 | 测试内容 |
|------|----------|
| `tests/tools/toolExecutor.test.ts` | 执行器测试 |
| `tests/generations/tool-registry.test.ts` | 注册表测试 |

### 文档

| 文件 | 内容 |
|------|------|
| `docs/architecture/tool-system.md` | 工具系统官方文档 |
| `docs/api-reference/tool-enhancements.md` | 工具增强 API |

## 🎯 设计模式

### 1. 装饰器模式
- 使用 `@Tool()` 装饰器声明工具
- 元数据与实现分离
- 类型安全的声明式 API

### 2. 注册表模式
- 集中管理所有工具
- 支持运行时动态注册
- 提供统一的查询接口

### 3. 策略模式
- 不同工具类型有不同的执行策略
- `builtin` - 本地方法调用
- `mcp` - 远程调用
- `cloud` - HTTP API 调用

### 4. 工厂模式
- `ToolRegistry` 作为工具工厂
- 根据名称创建/获取工具实例

## 🔐 安全机制

### 1. 参数验证
- 基于 JSON Schema 严格验证
- 类型检查和必需字段检查
- 自定义验证规则

### 2. 超时保护
```typescript
async executeWithTimeout(
  fn: () => Promise<T>,
  timeout: number
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeout)
    )
  ]);
}
```

### 3. 错误隔离
- 工具执行失败不影响其他工具
- 统一的错误处理格式
- 详细的错误信息

### 4. 权限控制
- 工具命名空间隔离
- 可配置的工具白名单/黑名单
- 敏感工具需要额外授权

## 📊 性能优化

### 1. 工具缓存
**文件**: `src/main/services/infra/toolCache.ts`

```typescript
class ToolCache {
  private cache = new Map<string, any>();
  
  // 缓存工具结果
  set(key: string, value: any, ttl?: number): void;
  
  // 获取缓存结果
  get(key: string): any | undefined;
  
  // 清除缓存
  clear(): void;
}
```

### 2. 并行执行
- 支持多个工具并行调用
- 使用 `Promise.all` 提高吞吐量

### 3. 延迟加载
- 工具按需加载
- MCP 工具动态注册

## 🚀 扩展性

### 添加新工具的方式

#### 方式 1: 内置工具（推荐）

```typescript
// 1. 在 src/main/tools/decorated/ 创建新文件
// 2. 使用 @Tool 装饰器
@Tool({
  name: 'my_tool',
  description: 'My custom tool',
  inputSchema: {
    type: 'object',
    properties: {
      param1: { type: 'string' }
    }
  }
})
export class MyTool {
  async execute(input: ToolInput): Promise<ToolOutput> {
    // 实现
  }
}