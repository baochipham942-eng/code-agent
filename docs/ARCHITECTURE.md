# Code Agent - 架构设计文档

> 版本: 1.0
> 日期: 2026-01-14
> 作者: Lin Chen

---

## 一、系统架构概览

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Code Agent Architecture                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Presentation Layer (Electron)                   │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │ │
│  │  │  Chat View   │ │ Workspace    │ │  Generation  │ │   Settings   │  │ │
│  │  │  Component   │ │ Explorer     │ │  Selector    │ │   Panel      │  │ │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘  │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │ │
│  │  │ Tool Viewer  │ │  Todo List   │ │ Diff Viewer  │ │ Prompt Viewer│  │ │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │ IPC                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Application Layer (Main Process)                │ │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │ │
│  │  │                        Agent Orchestrator                         │  │ │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐    │  │ │
│  │  │  │ Generation │ │   Model    │ │   Tool     │ │  Session   │    │  │ │
│  │  │  │  Manager   │ │  Router    │ │  Registry  │ │  Manager   │    │  │ │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘    │  │ │
│  │  └──────────────────────────────────────────────────────────────────┘  │ │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │ │
│  │  │                        Core Services                              │  │ │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐    │  │ │
│  │  │  │ Permission │ │   File     │ │  Process   │ │   Config   │    │  │ │
│  │  │  │  Service   │ │  Service   │ │  Service   │ │  Service   │    │  │ │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘    │  │ │
│  │  └──────────────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Tool Layer                                      │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│  │  │                    Tool Implementation                           │   │ │
│  │  │                                                                  │   │ │
│  │  │  Gen 1 Tools    Gen 2 Tools    Gen 3 Tools    Gen 4 Tools       │   │ │
│  │  │  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐         │   │ │
│  │  │  │  bash   │   │  glob   │   │  task   │   │  skill  │         │   │ │
│  │  │  │  read   │   │  grep   │   │ todoWrite│  │webFetch │         │   │ │
│  │  │  │  write  │   │ listDir │   │askUser  │   │webSearch│         │   │ │
│  │  │  │  edit   │   │  mcp    │   │planMode │   │ hooks   │         │   │ │
│  │  │  └─────────┘   └─────────┘   └─────────┘   └─────────┘         │   │ │
│  │  └─────────────────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         External Layer                                  │ │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐          │ │
│  │  │  DeepSeek  │ │   Claude   │ │   OpenAI   │ │   Local    │          │ │
│  │  │    API     │ │    API     │ │    API     │ │   Model    │          │ │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘          │ │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐                         │ │
│  │  │   File     │ │  Process   │ │  Network   │                         │ │
│  │  │  System    │ │ (Shell)    │ │  (HTTP)    │                         │ │
│  │  └────────────┘ └────────────┘ └────────────┘                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 技术栈选型

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **桌面框架** | Electron 28+ | 跨平台，生态成熟 |
| **前端框架** | React 18 + TypeScript | 组件化开发 |
| **状态管理** | Zustand | 轻量级状态管理 |
| **UI 组件** | Tailwind CSS + Radix UI | 快速开发 + 无障碍支持 |
| **构建工具** | Vite | 快速开发体验 |
| **IPC 通信** | Electron IPC + Type-safe | 主进程/渲染进程通信 |
| **数据存储** | SQLite (better-sqlite3) | 会话/配置持久化 |
| **AI SDK** | Vercel AI SDK | 统一的 AI 模型接口 |

---

## 二、核心模块设计

### 2.1 Agent 事件循环 (核心)

Agent 的核心是一个事件循环，持续处理用户输入和工具调用：

```typescript
// src/main/agent/AgentLoop.ts

interface AgentLoopConfig {
  generation: Generation;
  model: ModelConfig;
  tools: Tool[];
  systemPrompt: string;
}

class AgentLoop {
  private messages: Message[] = [];
  private isRunning: boolean = false;

  async run(userMessage: string): Promise<void> {
    this.messages.push({ role: 'user', content: userMessage });

    while (true) {
      // 1. 调用模型
      const response = await this.inference();

      // 2. 处理响应
      if (response.type === 'text') {
        this.emit('message', response.content);
        break;
      }

      if (response.type === 'tool_use') {
        // 3. 执行工具
        const results = await this.executeTools(response.toolCalls);

        // 4. 将结果加入上下文
        this.messages.push({
          role: 'assistant',
          content: response.toolCalls
        });
        this.messages.push({
          role: 'user',
          content: results
        });

        // 继续循环
        continue;
      }
    }
  }
}
```

**流程图**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agent Event Loop                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────┐                                                  │
│   │  User    │                                                  │
│   │  Input   │                                                  │
│   └────┬─────┘                                                  │
│        │                                                        │
│        ▼                                                        │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐              │
│   │  Add to  │────▶│  Model   │────▶│ Response │              │
│   │ Messages │     │Inference │     │ Handler  │              │
│   └──────────┘     └──────────┘     └────┬─────┘              │
│        ▲                                  │                     │
│        │                                  ▼                     │
│        │                          ┌──────────────┐             │
│        │                          │  Response    │             │
│        │                          │  Type?       │             │
│        │                          └──────┬───────┘             │
│        │                                 │                      │
│        │              ┌──────────────────┼──────────────────┐  │
│        │              │                  │                  │  │
│        │              ▼                  ▼                  │  │
│        │        ┌──────────┐      ┌──────────┐             │  │
│        │        │  Text    │      │Tool Call │             │  │
│        │        │ Response │      │ Request  │             │  │
│        │        └────┬─────┘      └────┬─────┘             │  │
│        │             │                  │                   │  │
│        │             ▼                  ▼                   │  │
│        │        ┌──────────┐      ┌──────────┐             │  │
│        │        │  Output  │      │ Execute  │             │  │
│        │        │ to User  │      │  Tools   │             │  │
│        │        └──────────┘      └────┬─────┘             │  │
│        │                               │                    │  │
│        │                               ▼                    │  │
│        │                         ┌──────────┐              │  │
│        └─────────────────────────│  Tool    │              │  │
│                                  │ Results  │              │  │
│                                  └──────────┘              │  │
│                                                             │  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 代际管理器 (Generation Manager)

```typescript
// src/main/generation/GenerationManager.ts

interface Generation {
  id: 'gen1' | 'gen2' | 'gen3' | 'gen4';
  name: string;
  version: string;
  description: string;
  tools: string[];
  systemPrompt: string;
  promptMetadata: {
    lineCount: number;
    toolCount: number;
    ruleCount: number;
  };
}

class GenerationManager {
  private generations: Map<string, Generation> = new Map();
  private currentGeneration: Generation;

  constructor() {
    this.loadGenerations();
  }

  private loadGenerations() {
    // 从配置文件加载各代际定义
    this.generations.set('gen1', {
      id: 'gen1',
      name: '基础工具期',
      version: 'v0.2',
      description: '最小可用的编程助手，支持基础文件操作和命令执行',
      tools: ['bash', 'read_file', 'write_file', 'edit_file'],
      systemPrompt: loadPrompt('gen1'),
      promptMetadata: { lineCount: 85, toolCount: 4, ruleCount: 15 }
    });

    this.generations.set('gen2', {
      id: 'gen2',
      name: '生态融合期',
      version: 'v1.0',
      description: '支持外部系统集成和 IDE 协作',
      tools: ['bash', 'read_file', 'write_file', 'edit_file',
              'glob', 'grep', 'list_directory'],
      systemPrompt: loadPrompt('gen2'),
      promptMetadata: { lineCount: 120, toolCount: 7, ruleCount: 25 }
    });

    this.generations.set('gen3', {
      id: 'gen3',
      name: '智能规划期',
      version: 'v1.0.60',
      description: '支持多代理编排和任务规划',
      tools: ['bash', 'read_file', 'write_file', 'edit_file',
              'glob', 'grep', 'list_directory',
              'task', 'todo_write', 'ask_user_question'],
      systemPrompt: loadPrompt('gen3'),
      promptMetadata: { lineCount: 188, toolCount: 12, ruleCount: 45 }
    });

    this.generations.set('gen4', {
      id: 'gen4',
      name: '工业化系统期',
      version: 'v2.0',
      description: '完整的插件生态和高级自动化',
      tools: ['bash', 'read_file', 'write_file', 'edit_file',
              'glob', 'grep', 'list_directory',
              'task', 'todo_write', 'ask_user_question',
              'skill', 'web_fetch', 'web_search', 'notebook_edit'],
      systemPrompt: loadPrompt('gen4'),
      promptMetadata: { lineCount: 169, toolCount: 15, ruleCount: 40 }
    });
  }

  switchGeneration(id: string): Generation {
    const gen = this.generations.get(id);
    if (!gen) throw new Error(`Unknown generation: ${id}`);
    this.currentGeneration = gen;
    return gen;
  }

  getAvailableTools(): Tool[] {
    return this.currentGeneration.tools.map(name =>
      this.toolRegistry.get(name)
    );
  }

  compareGenerations(gen1Id: string, gen2Id: string): GenerationDiff {
    // 返回两个代际的 prompt 差异
    const gen1 = this.generations.get(gen1Id);
    const gen2 = this.generations.get(gen2Id);
    return diffPrompts(gen1.systemPrompt, gen2.systemPrompt);
  }
}
```

### 2.3 工具注册表 (Tool Registry)

```typescript
// src/main/tools/ToolRegistry.ts

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  generation: Generation['id'][];  // 哪些代际支持此工具
  requiresPermission: boolean;
  permissionLevel: 'read' | 'write' | 'execute' | 'network';
}

interface Tool extends ToolDefinition {
  execute: (params: any, context: ToolContext) => Promise<ToolResult>;
}

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getForGeneration(generationId: string): Tool[] {
    return Array.from(this.tools.values())
      .filter(tool => tool.generation.includes(generationId));
  }

  getToolDefinitions(generationId: string): ToolDefinition[] {
    // 返回供 LLM 使用的工具定义格式
    return this.getForGeneration(generationId).map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
  }
}
```

### 2.4 工具实现示例

#### Gen 1: bash 工具

```typescript
// src/main/tools/gen1/bash.ts

const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command',
  generation: ['gen1', 'gen2', 'gen3', 'gen4'],
  requiresPermission: true,
  permissionLevel: 'execute',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)'
      },
      workingDirectory: {
        type: 'string',
        description: 'Working directory for the command'
      }
    },
    required: ['command']
  },

  async execute(params, context): Promise<ToolResult> {
    const { command, timeout = 120000, workingDirectory } = params;

    // 安全检查
    if (isDangerousCommand(command)) {
      const approved = await context.requestPermission({
        type: 'dangerous_command',
        command,
        reason: 'This command may cause irreversible changes'
      });
      if (!approved) {
        return { success: false, error: 'Permission denied' };
      }
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        cwd: workingDirectory || context.workingDirectory,
        maxBuffer: 10 * 1024 * 1024  // 10MB
      });

      return {
        success: true,
        output: stdout,
        stderr: stderr || undefined
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        exitCode: error.code
      };
    }
  }
};
```

#### Gen 3: Task 工具 (子代理)

```typescript
// src/main/tools/gen3/task.ts

interface SubagentType {
  id: string;
  name: string;
  description: string;
  systemPromptOverride?: string;
  availableTools: string[];
}

const SUBAGENT_TYPES: SubagentType[] = [
  {
    id: 'explore',
    name: 'Explore',
    description: 'Fast agent for exploring codebases',
    availableTools: ['glob', 'grep', 'read_file', 'list_directory']
  },
  {
    id: 'bash',
    name: 'Bash',
    description: 'Command execution specialist',
    availableTools: ['bash']
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Software architect for designing implementation plans',
    availableTools: ['glob', 'grep', 'read_file', 'list_directory']
  }
];

const taskTool: Tool = {
  name: 'task',
  description: 'Launch a subagent to handle complex tasks',
  generation: ['gen3', 'gen4'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task for the subagent'
      },
      subagent_type: {
        type: 'string',
        enum: SUBAGENT_TYPES.map(s => s.id),
        description: 'Type of specialized agent to use'
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run agent in background'
      }
    },
    required: ['prompt', 'subagent_type']
  },

  async execute(params, context): Promise<ToolResult> {
    const { prompt, subagent_type, run_in_background } = params;

    const subagentConfig = SUBAGENT_TYPES.find(s => s.id === subagent_type);
    if (!subagentConfig) {
      return { success: false, error: `Unknown subagent type: ${subagent_type}` };
    }

    // 创建子代理实例
    const subagent = new AgentLoop({
      generation: context.currentGeneration,
      model: context.modelConfig,
      tools: subagentConfig.availableTools.map(name =>
        context.toolRegistry.get(name)
      ),
      systemPrompt: subagentConfig.systemPromptOverride ||
                    context.currentGeneration.systemPrompt
    });

    if (run_in_background) {
      // 后台运行
      const taskId = generateId();
      context.backgroundTasks.set(taskId, subagent);
      subagent.run(prompt).then(result => {
        context.emit('background_task_complete', { taskId, result });
      });
      return { success: true, taskId, status: 'running_in_background' };
    }

    // 同步运行
    const result = await subagent.run(prompt);
    return { success: true, result };
  }
};
```

#### Gen 4: Skill 工具

```typescript
// src/main/tools/gen4/skill.ts

interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
}

const skillTool: Tool = {
  name: 'skill',
  description: 'Execute a predefined skill/workflow',
  generation: ['gen4'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill name to execute'
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill'
      }
    },
    required: ['skill']
  },

  async execute(params, context): Promise<ToolResult> {
    const { skill, args } = params;

    // 内置 Skills
    const builtinSkills: Record<string, SkillDefinition> = {
      'commit': {
        name: 'commit',
        description: 'Create a git commit',
        prompt: `Create a git commit following best practices...`,
        tools: ['bash', 'read_file']
      },
      'code-review': {
        name: 'code-review',
        description: 'Review code changes',
        prompt: `Review the code changes for bugs, security issues...`,
        tools: ['bash', 'read_file', 'grep']
      }
    };

    const skillDef = builtinSkills[skill];
    if (!skillDef) {
      return { success: false, error: `Unknown skill: ${skill}` };
    }

    // 执行 Skill (通过创建子代理)
    const result = await context.executeWithPrompt(
      skillDef.prompt + (args ? `\n\nArguments: ${args}` : ''),
      skillDef.tools
    );

    return { success: true, result };
  }
};
```

---

## 三、模型适配层

### 3.1 模型路由器 (Model Router)

```typescript
// src/main/model/ModelRouter.ts

interface ModelConfig {
  provider: 'deepseek' | 'claude' | 'openai' | 'local';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

interface ModelProvider {
  id: string;
  name: string;
  models: string[];
  createClient(config: ModelConfig): AIClient;
}

class ModelRouter {
  private providers: Map<string, ModelProvider> = new Map();
  private currentClient: AIClient;

  constructor() {
    this.registerProviders();
  }

  private registerProviders() {
    // DeepSeek
    this.providers.set('deepseek', {
      id: 'deepseek',
      name: 'DeepSeek',
      models: ['deepseek-chat', 'deepseek-coder'],
      createClient(config) {
        return createOpenAI({
          apiKey: config.apiKey,
          baseURL: 'https://api.deepseek.com/v1'
        });
      }
    });

    // Claude
    this.providers.set('claude', {
      id: 'claude',
      name: 'Anthropic Claude',
      models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
      createClient(config) {
        return createAnthropic({
          apiKey: config.apiKey
        });
      }
    });

    // OpenAI
    this.providers.set('openai', {
      id: 'openai',
      name: 'OpenAI',
      models: ['gpt-4o', 'gpt-4o-mini'],
      createClient(config) {
        return createOpenAI({
          apiKey: config.apiKey
        });
      }
    });
  }

  async inference(
    messages: Message[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): Promise<ModelResponse> {
    const provider = this.providers.get(config.provider);
    const client = provider.createClient(config);

    // 使用 Vercel AI SDK 统一接口
    const { text, toolCalls } = await generateText({
      model: client(config.model),
      messages,
      tools: this.convertToolsToSchema(tools),
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 4096
    });

    if (toolCalls && toolCalls.length > 0) {
      return { type: 'tool_use', toolCalls };
    }

    return { type: 'text', content: text };
  }
}
```

### 3.2 流式输出处理

```typescript
// src/main/model/StreamHandler.ts

class StreamHandler {
  async *streamInference(
    messages: Message[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): AsyncGenerator<StreamChunk> {
    const client = this.modelRouter.getClient(config);

    const stream = await streamText({
      model: client(config.model),
      messages,
      tools: this.convertToolsToSchema(tools)
    });

    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        yield { type: 'text', content: chunk.textDelta };
      } else if (chunk.type === 'tool-call') {
        yield { type: 'tool_call', toolCall: chunk.toolCall };
      } else if (chunk.type === 'tool-result') {
        yield { type: 'tool_result', result: chunk.result };
      }
    }
  }
}
```

---

## 四、前端架构

### 4.1 组件结构

```
src/renderer/
├── components/
│   ├── chat/
│   │   ├── ChatView.tsx           # 主聊天视图
│   │   ├── MessageList.tsx        # 消息列表
│   │   ├── MessageBubble.tsx      # 消息气泡
│   │   ├── InputArea.tsx          # 输入区域
│   │   └── ToolCallDisplay.tsx    # 工具调用展示
│   │
│   ├── workspace/
│   │   ├── WorkspaceExplorer.tsx  # 工作区浏览器
│   │   ├── FileTree.tsx           # 文件树
│   │   └── DiffViewer.tsx         # 差异查看器
│   │
│   ├── generation/
│   │   ├── GenerationSelector.tsx # 代际选择器
│   │   ├── GenerationCard.tsx     # 代际卡片
│   │   ├── PromptViewer.tsx       # Prompt 查看器
│   │   └── PromptDiff.tsx         # Prompt 对比
│   │
│   ├── settings/
│   │   ├── SettingsPanel.tsx      # 设置面板
│   │   ├── ModelConfig.tsx        # 模型配置
│   │   └── APIKeyManager.tsx      # API Key 管理
│   │
│   ├── tools/
│   │   ├── ToolActivityPanel.tsx  # 工具活动面板
│   │   ├── PermissionDialog.tsx   # 权限对话框
│   │   └── ToolResultCard.tsx     # 工具结果卡片
│   │
│   └── common/
│       ├── CodeBlock.tsx          # 代码块
│       ├── MarkdownRenderer.tsx   # Markdown 渲染
│       └── LoadingSpinner.tsx     # 加载动画
│
├── hooks/
│   ├── useAgent.ts                # Agent 交互 Hook
│   ├── useGeneration.ts           # 代际管理 Hook
│   ├── useWorkspace.ts            # 工作区 Hook
│   └── usePermission.ts           # 权限管理 Hook
│
├── stores/
│   ├── chatStore.ts               # 聊天状态
│   ├── generationStore.ts         # 代际状态
│   ├── settingsStore.ts           # 设置状态
│   └── workspaceStore.ts          # 工作区状态
│
└── App.tsx
```

### 4.2 状态管理

```typescript
// src/renderer/stores/chatStore.ts

interface ChatState {
  messages: Message[];
  isLoading: boolean;
  currentToolCalls: ToolCall[];
  pendingPermissions: PermissionRequest[];

  // Actions
  addMessage: (message: Message) => void;
  sendMessage: (content: string) => Promise<void>;
  approvePermission: (id: string) => void;
  denyPermission: (id: string) => void;
}

const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  currentToolCalls: [],
  pendingPermissions: [],

  addMessage: (message) => set(state => ({
    messages: [...state.messages, message]
  })),

  sendMessage: async (content) => {
    set({ isLoading: true });

    // 通过 IPC 发送到主进程
    const response = await window.electronAPI.sendMessage(content);

    // 处理流式响应
    for await (const chunk of response) {
      if (chunk.type === 'text') {
        // 更新消息
      } else if (chunk.type === 'tool_call') {
        // 显示工具调用
      } else if (chunk.type === 'permission_request') {
        // 显示权限请求
        set(state => ({
          pendingPermissions: [...state.pendingPermissions, chunk.request]
        }));
      }
    }

    set({ isLoading: false });
  }
}));
```

### 4.3 IPC 通信定义

```typescript
// src/shared/ipc.ts

// 主进程 -> 渲染进程 事件
interface MainToRendererEvents {
  'agent:message': (message: Message) => void;
  'agent:tool-call': (toolCall: ToolCall) => void;
  'agent:tool-result': (result: ToolResult) => void;
  'agent:permission-request': (request: PermissionRequest) => void;
  'agent:error': (error: AgentError) => void;
}

// 渲染进程 -> 主进程 调用
interface RendererToMainCalls {
  'agent:send-message': (content: string) => Promise<void>;
  'agent:cancel': () => Promise<void>;
  'agent:approve-permission': (requestId: string) => Promise<void>;
  'agent:deny-permission': (requestId: string) => Promise<void>;

  'generation:list': () => Promise<Generation[]>;
  'generation:switch': (id: string) => Promise<Generation>;
  'generation:get-prompt': (id: string) => Promise<string>;
  'generation:compare': (id1: string, id2: string) => Promise<PromptDiff>;

  'workspace:select-directory': () => Promise<string>;
  'workspace:list-files': (path: string) => Promise<FileInfo[]>;
  'workspace:read-file': (path: string) => Promise<string>;

  'settings:get': () => Promise<Settings>;
  'settings:set': (settings: Partial<Settings>) => Promise<void>;
  'settings:test-api-key': (provider: string, key: string) => Promise<boolean>;
}
```

---

## 五、数据存储

### 5.1 数据库 Schema

```sql
-- sessions 表：会话管理
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  generation_id TEXT NOT NULL,
  model_config TEXT NOT NULL,  -- JSON
  working_directory TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- messages 表：消息历史
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  tool_calls TEXT,  -- JSON, 如果是工具调用
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- tool_executions 表：工具执行记录
CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,  -- JSON
  output TEXT,  -- JSON
  status TEXT NOT NULL,  -- 'pending' | 'approved' | 'denied' | 'completed' | 'error'
  duration_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

-- settings 表：用户设置
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 5.2 配置文件结构

```typescript
// ~/.code-agent/config.json

interface AppConfig {
  // 模型配置
  models: {
    default: string;  // 默认模型 ID
    providers: {
      [providerId: string]: {
        apiKey?: string;  // 加密存储
        enabled: boolean;
      };
    };
  };

  // 代际配置
  generation: {
    default: string;  // 默认代际
    customPrompts?: {
      [generationId: string]: string;  // 自定义 prompt 覆盖
    };
  };

  // 工作区配置
  workspace: {
    defaultDirectory?: string;
    recentDirectories: string[];
  };

  // 权限配置
  permissions: {
    autoApprove: {
      read: boolean;
      write: boolean;
      execute: boolean;
      network: boolean;
    };
    blockedCommands: string[];  // 禁止的命令模式
  };

  // UI 配置
  ui: {
    theme: 'light' | 'dark' | 'system';
    fontSize: number;
    showToolCalls: boolean;
  };
}
```

---

## 六、System Prompts 管理

### 6.1 Prompt 文件结构

```
src/main/prompts/
├── gen1/
│   ├── system.md          # 主 system prompt
│   └── tools/
│       ├── bash.md        # bash 工具说明
│       ├── read_file.md
│       ├── write_file.md
│       └── edit_file.md
│
├── gen2/
│   ├── system.md
│   └── tools/
│       ├── ...gen1 tools
│       ├── glob.md
│       ├── grep.md
│       └── list_directory.md
│
├── gen3/
│   ├── system.md
│   └── tools/
│       ├── ...gen1-2 tools
│       ├── task.md
│       ├── todo_write.md
│       └── ask_user_question.md
│
└── gen4/
    ├── system.md
    └── tools/
        ├── ...gen1-3 tools
        ├── skill.md
        ├── web_fetch.md
        └── web_search.md
```

### 6.2 Prompt 模板示例

```markdown
<!-- src/main/prompts/gen3/system.md -->

# Claude Code - Generation 3 (Smart Planning Era)

You are an AI coding assistant with advanced planning and multi-agent capabilities.

## Core Principles

1. **Plan Before Execute**: For complex tasks, use Plan Mode to design your approach
2. **Task Delegation**: Use the Task tool to delegate specialized work to subagents
3. **Progress Tracking**: Use TodoWrite to track multi-step tasks

## Available Tools

You have access to the following tools:

### File Operations
- `bash`: Execute shell commands
- `read_file`: Read file contents
- `write_file`: Create or overwrite files
- `edit_file`: Make precise edits to files
- `glob`: Find files by pattern
- `grep`: Search file contents

### Planning & Management
- `task`: Delegate tasks to specialized subagents
- `todo_write`: Track task progress
- `ask_user_question`: Get clarification from the user

## Tool Usage Guidelines

### When to use Task tool
- Complex tasks requiring multiple steps
- Tasks that need specialized expertise
- Research or exploration tasks

### When to use TodoWrite
- Multi-step implementation tasks
- When user provides multiple requirements
- To show progress on complex work

## Behavioral Guidelines

- Be concise but complete
- Prefer editing existing files over creating new ones
- Always read files before editing them
- Track your progress with TodoWrite for complex tasks

{{TOOL_DEFINITIONS}}
```

---

## 七、项目目录结构

```
code-agent/
├── docs/
│   ├── PRD.md                      # 产品需求文档
│   └── ARCHITECTURE.md             # 架构设计文档 (本文档)
│
├── src/
│   ├── main/                       # Electron 主进程
│   │   ├── index.ts               # 入口
│   │   ├── agent/
│   │   │   ├── AgentLoop.ts       # Agent 事件循环
│   │   │   ├── AgentOrchestrator.ts
│   │   │   └── SubagentManager.ts
│   │   │
│   │   ├── generation/
│   │   │   ├── GenerationManager.ts
│   │   │   └── PromptLoader.ts
│   │   │
│   │   ├── model/
│   │   │   ├── ModelRouter.ts
│   │   │   ├── StreamHandler.ts
│   │   │   └── providers/
│   │   │       ├── DeepSeekProvider.ts
│   │   │       ├── ClaudeProvider.ts
│   │   │       └── OpenAIProvider.ts
│   │   │
│   │   ├── tools/
│   │   │   ├── ToolRegistry.ts
│   │   │   ├── ToolExecutor.ts
│   │   │   ├── gen1/
│   │   │   │   ├── bash.ts
│   │   │   │   ├── readFile.ts
│   │   │   │   ├── writeFile.ts
│   │   │   │   └── editFile.ts
│   │   │   ├── gen2/
│   │   │   │   ├── glob.ts
│   │   │   │   ├── grep.ts
│   │   │   │   └── listDirectory.ts
│   │   │   ├── gen3/
│   │   │   │   ├── task.ts
│   │   │   │   ├── todoWrite.ts
│   │   │   │   └── askUserQuestion.ts
│   │   │   └── gen4/
│   │   │       ├── skill.ts
│   │   │       ├── webFetch.ts
│   │   │       └── webSearch.ts
│   │   │
│   │   ├── services/
│   │   │   ├── FileService.ts
│   │   │   ├── ProcessService.ts
│   │   │   ├── PermissionService.ts
│   │   │   ├── ConfigService.ts
│   │   │   └── DatabaseService.ts
│   │   │
│   │   ├── prompts/
│   │   │   ├── gen1/
│   │   │   ├── gen2/
│   │   │   ├── gen3/
│   │   │   └── gen4/
│   │   │
│   │   └── ipc/
│   │       └── handlers.ts
│   │
│   ├── renderer/                   # React 渲染进程
│   │   ├── index.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── stores/
│   │   └── styles/
│   │
│   ├── shared/                     # 共享类型定义
│   │   ├── types.ts
│   │   └── ipc.ts
│   │
│   └── preload/                    # Electron preload
│       └── index.ts
│
├── resources/                      # 静态资源
│   └── icons/
│
├── package.json
├── tsconfig.json
├── vite.config.ts
├── electron-builder.json
└── README.md
```

---

## 八、开发路线图

### Phase 1: MVP (Week 1-2)

```
┌─────────────────────────────────────────────────────────────┐
│  MVP Scope                                                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ✅ Electron + React 项目搭建                                │
│  ✅ 基础聊天界面                                             │
│  ✅ DeepSeek API 接入                                        │
│  ✅ Gen 1 工具集实现 (bash, read, write, edit)               │
│  ✅ 简单权限确认                                             │
│  ✅ 单一工作目录支持                                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Phase 2: Generation System (Week 3-4)

```
┌─────────────────────────────────────────────────────────────┐
│  Generation System                                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ✅ 代际管理器实现                                           │
│  ✅ 4 套 System Prompt 整理                                  │
│  ✅ 代际切换 UI                                              │
│  ✅ Gen 2 工具集 (glob, grep)                                │
│  ✅ Gen 3 工具集 (task, todoWrite)                           │
│  ✅ Prompt 查看器                                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Phase 3: Full Features (Week 5-6)

```
┌─────────────────────────────────────────────────────────────┐
│  Full Features                                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ✅ Gen 4 工具集 (skill, webFetch)                          │
│  ✅ Claude API 支持                                          │
│  ✅ 代际对比视图                                             │
│  ✅ 工具调用完整可视化                                       │
│  ✅ 会话持久化                                               │
│  ✅ 设置面板完善                                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Phase 4: Polish (Week 7-8)

```
┌─────────────────────────────────────────────────────────────┐
│  Polish & Enhancement                                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ✅ UI/UX 优化                                               │
│  ✅ 性能优化                                                 │
│  ✅ 错误处理完善                                             │
│  ✅ macOS 应用签名                                           │
│  ✅ 文档完善                                                 │
│  ✅ 测试覆盖                                                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 九、关键技术决策记录

### 9.1 为什么选择 Electron

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| Electron | 跨平台、生态成熟、开发效率高 | 内存占用较大 | ✅ 选用 |
| Tauri | 轻量、性能好 | Rust 学习曲线、某些 API 受限 | 备选 |
| Flutter | 跨平台统一 | 桌面端生态不成熟 | 不选 |

**理由**: 作为学习/研究项目，开发效率优先。Electron 生态成熟，参考资料丰富。

### 9.2 为什么使用 Vercel AI SDK

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| Vercel AI SDK | 多模型统一接口、流式支持好 | 依赖较新 | ✅ 选用 |
| 直接调用 API | 灵活 | 每个模型要写适配 | 不选 |
| LangChain | 功能丰富 | 过于复杂 | 不选 |

**理由**: 项目需要支持多模型切换，Vercel AI SDK 提供统一抽象。

### 9.3 为什么不使用 Claude Agent SDK

虽然 Anthropic 提供了官方 Agent SDK，但本项目选择自行实现 Agent Loop：

1. **学习目的**: 通过自己实现理解 Agent 工作原理
2. **代际模拟**: 需要精确控制不同代际的行为差异
3. **模型无关**: 需要支持非 Claude 模型 (DeepSeek)

---

## 十、附录

### 10.1 参考项目

- [OpenCode](https://github.com/opencode-ai/opencode) - Go 实现的终端 AI Agent
- [How to Build a Coding Agent](https://github.com/ghuntley/how-to-build-a-coding-agent) - Agent 构建教程
- [Vercel AI SDK](https://sdk.vercel.ai/) - 多模型 AI SDK

### 10.2 相关文档

- [Electron 官方文档](https://www.electronjs.org/docs)
- [React 官方文档](https://react.dev/)
- [DeepSeek API 文档](https://platform.deepseek.com/docs)
- [Anthropic API 文档](https://docs.anthropic.com/)
