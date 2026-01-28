# 配置级 Agent 路由

## 问题描述

当前 Code Agent 只支持单一 Agent，没有路由机制。Clawdbot 支持：

1. **多 Agent 定义**：在配置中定义多个 Agent（不同人格/能力）
2. **灵活路由**：根据渠道、用户、群组等自动选择 Agent
3. **Binding 机制**：将特定对话绑定到特定 Agent

## Clawdbot 实现分析

### 核心文件
- `src/routing/resolve-route.ts` - 路由解析
- `src/routing/bindings.ts` - 绑定配置
- `src/routing/session-key.ts` - 会话 Key 构建

### 路由优先级

```
binding.peer > binding.guild > binding.team > binding.account > binding.channel > default
```

### 路由输入

```typescript
type ResolveAgentRouteInput = {
  cfg: MoltbotConfig;       // 配置
  channel: string;          // 渠道 (whatsapp, discord, slack...)
  accountId?: string;       // 账号 ID
  peer?: RoutePeer;         // 对话方 {kind: 'dm'|'group'|'channel', id: string}
  guildId?: string;         // Discord Guild ID
  teamId?: string;          // Slack Team ID
};
```

### 路由输出

```typescript
type ResolvedAgentRoute = {
  agentId: string;          // 选中的 Agent ID
  channel: string;          // 渠道
  accountId: string;        // 账号 ID
  sessionKey: string;       // 会话持久化 Key
  mainSessionKey: string;   // 主会话 Key
  matchedBy: string;        // 匹配方式（用于调试）
};
```

### 配置示例

```yaml
# config.yaml
agents:
  list:
    - id: assistant
      name: 通用助手
      system_prompt: "你是一个友好的助手..."
    - id: coder
      name: 编程专家
      system_prompt: "你是一个资深程序员..."
    - id: writer
      name: 写作助手
      system_prompt: "你是一个专业写作者..."
  default: assistant

routing:
  bindings:
    # 特定用户绑定到特定 Agent
    - match:
        channel: whatsapp
        peer:
          kind: dm
          id: "8613800138000"
      agentId: coder

    # 特定群组绑定
    - match:
        channel: discord
        guildId: "123456789"
      agentId: writer

    # 特定渠道默认 Agent
    - match:
        channel: slack
        accountId: "*"  # 任意账号
      agentId: coder
```

## Code Agent 现状

当前实现：
- 单 Agent 架构
- 无路由概念
- System Prompt 全局共享

## 借鉴方案

### Step 1: 定义 Agent 配置结构

```typescript
// src/shared/types/agent.ts
export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;           // 可覆盖默认模型
  temperature?: number;
  tools?: string[];         // 可用工具白名单
  maxTokens?: number;
}

export interface AgentRoutingConfig {
  defaultAgentId: string;
  agents: AgentConfig[];
  bindings: AgentBinding[];
}

export interface AgentBinding {
  match: BindingMatch;
  agentId: string;
}

export interface BindingMatch {
  // 基础匹配
  source?: string;          // 来源: desktop, api, webhook
  userId?: string;          // 用户 ID（未来多用户）
  projectPath?: string;     // 项目路径（glob 模式）

  // 上下文匹配
  filePattern?: string;     // 当前文件模式 *.ts, *.md
  taskType?: string;        // 任务类型: coding, writing, debugging
}
```

### Step 2: 路由服务

```typescript
// src/main/routing/routingService.ts
import { AgentConfig, AgentRoutingConfig, BindingMatch } from '@shared/types/agent';

export class RoutingService {
  private config: AgentRoutingConfig;
  private agents = new Map<string, AgentConfig>();

  constructor() {
    this.config = this.loadConfig();
    this.indexAgents();
  }

  private loadConfig(): AgentRoutingConfig {
    // 从 .claude/agents.json 或 settings 加载
    const userConfig = this.loadUserConfig();
    return {
      defaultAgentId: userConfig.defaultAgentId || 'default',
      agents: userConfig.agents || [this.getDefaultAgent()],
      bindings: userConfig.bindings || [],
    };
  }

  private getDefaultAgent(): AgentConfig {
    return {
      id: 'default',
      name: 'Code Agent',
      description: '通用编程助手',
    };
  }

  private indexAgents(): void {
    this.agents.clear();
    for (const agent of this.config.agents) {
      this.agents.set(agent.id, agent);
    }
  }

  resolve(context: RoutingContext): ResolvedRoute {
    // 按优先级匹配 bindings
    for (const binding of this.config.bindings) {
      if (this.matchesBinding(binding.match, context)) {
        const agent = this.agents.get(binding.agentId);
        if (agent) {
          return {
            agentId: agent.id,
            agent,
            matchedBy: this.describeMatch(binding.match),
          };
        }
      }
    }

    // 回退到默认 Agent
    const defaultAgent = this.agents.get(this.config.defaultAgentId)
      || this.getDefaultAgent();

    return {
      agentId: defaultAgent.id,
      agent: defaultAgent,
      matchedBy: 'default',
    };
  }

  private matchesBinding(match: BindingMatch, ctx: RoutingContext): boolean {
    if (match.source && match.source !== ctx.source) return false;
    if (match.userId && match.userId !== ctx.userId) return false;

    if (match.projectPath) {
      const pattern = new RegExp(
        match.projectPath.replace(/\*/g, '.*').replace(/\?/g, '.')
      );
      if (!pattern.test(ctx.projectPath || '')) return false;
    }

    if (match.filePattern && ctx.currentFile) {
      const pattern = new RegExp(
        match.filePattern.replace(/\*/g, '.*').replace(/\?/g, '.')
      );
      if (!pattern.test(ctx.currentFile)) return false;
    }

    if (match.taskType && match.taskType !== ctx.taskType) return false;

    return true;
  }

  private describeMatch(match: BindingMatch): string {
    const parts: string[] = [];
    if (match.source) parts.push(`source:${match.source}`);
    if (match.projectPath) parts.push(`project:${match.projectPath}`);
    if (match.filePattern) parts.push(`file:${match.filePattern}`);
    if (match.taskType) parts.push(`task:${match.taskType}`);
    return parts.join('+') || 'binding';
  }

  // Agent CRUD
  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  addAgent(agent: AgentConfig): void {
    this.config.agents.push(agent);
    this.agents.set(agent.id, agent);
    this.saveConfig();
  }

  updateAgent(id: string, updates: Partial<AgentConfig>): void {
    const agent = this.agents.get(id);
    if (agent) {
      Object.assign(agent, updates);
      this.saveConfig();
    }
  }

  removeAgent(id: string): boolean {
    if (id === this.config.defaultAgentId) return false;
    const idx = this.config.agents.findIndex(a => a.id === id);
    if (idx >= 0) {
      this.config.agents.splice(idx, 1);
      this.agents.delete(id);
      this.saveConfig();
      return true;
    }
    return false;
  }

  private saveConfig(): void {
    // 保存到 .claude/agents.json
  }
}

export interface RoutingContext {
  source: 'desktop' | 'api' | 'webhook';
  userId?: string;
  projectPath?: string;
  currentFile?: string;
  taskType?: string;
}

export interface ResolvedRoute {
  agentId: string;
  agent: AgentConfig;
  matchedBy: string;
}
```

### Step 3: 集成到 AgentOrchestrator

```typescript
// 修改 src/main/agent/agentOrchestrator.ts
export class AgentOrchestrator {
  private routingService: RoutingService;

  constructor() {
    this.routingService = new RoutingService();
  }

  async processMessage(message: string, context: MessageContext): Promise<void> {
    // 1. 解析路由
    const route = this.routingService.resolve({
      source: context.source || 'desktop',
      userId: context.userId,
      projectPath: context.projectPath,
      currentFile: context.currentFile,
      taskType: this.inferTaskType(message),
    });

    // 2. 获取 Agent 配置
    const agentConfig = route.agent;

    // 3. 构建 System Prompt
    const systemPrompt = this.buildSystemPrompt(agentConfig);

    // 4. 选择模型
    const model = agentConfig.model || this.defaultModel;

    // 5. 过滤可用工具
    const tools = agentConfig.tools
      ? this.filterTools(agentConfig.tools)
      : this.allTools;

    // 6. 执行 Agent Loop
    await this.agentLoop.run({
      message,
      systemPrompt,
      model,
      tools,
      temperature: agentConfig.temperature,
      maxTokens: agentConfig.maxTokens,
    });
  }

  private inferTaskType(message: string): string | undefined {
    // 简单关键词推断
    const lower = message.toLowerCase();
    if (lower.includes('debug') || lower.includes('错误') || lower.includes('bug')) {
      return 'debugging';
    }
    if (lower.includes('write') || lower.includes('写') || lower.includes('文档')) {
      return 'writing';
    }
    if (lower.includes('review') || lower.includes('审查')) {
      return 'reviewing';
    }
    return 'coding';
  }

  private buildSystemPrompt(config: AgentConfig): string {
    if (config.systemPrompt) {
      return config.systemPrompt;
    }
    // 使用默认 prompt 模板
    return this.defaultSystemPromptTemplate;
  }
}
```

### Step 4: UI 支持

```typescript
// src/renderer/components/features/settings/AgentsTab.tsx
export function AgentsTab() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3>Agent 配置</h3>
        <Button onClick={handleAddAgent}>添加 Agent</Button>
      </div>

      <div className="space-y-2">
        {agents.map(agent => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onEdit={() => handleEdit(agent)}
            onDelete={() => handleDelete(agent.id)}
          />
        ))}
      </div>

      <div className="mt-6">
        <h4>路由规则</h4>
        <BindingsEditor />
      </div>
    </div>
  );
}
```

### Step 5: 配置文件格式

```json
// .claude/agents.json
{
  "defaultAgentId": "assistant",
  "agents": [
    {
      "id": "assistant",
      "name": "通用助手",
      "description": "友好的通用编程助手",
      "systemPrompt": null,
      "model": null,
      "tools": null
    },
    {
      "id": "coder",
      "name": "编程专家",
      "description": "专注于代码质量和最佳实践",
      "systemPrompt": "你是一个资深程序员，专注于代码质量、性能优化和最佳实践...",
      "model": "deepseek-coder",
      "tools": ["bash", "read_file", "write_file", "edit_file", "glob", "grep"]
    },
    {
      "id": "reviewer",
      "name": "代码审查员",
      "description": "专注于代码审查和安全检查",
      "systemPrompt": "你是一个代码审查专家，专注于发现潜在问题、安全漏洞和改进建议...",
      "tools": ["read_file", "glob", "grep"]
    }
  ],
  "bindings": [
    {
      "match": {
        "taskType": "reviewing"
      },
      "agentId": "reviewer"
    },
    {
      "match": {
        "projectPath": "*/backend/*"
      },
      "agentId": "coder"
    }
  ]
}
```

## 验收标准

1. **多 Agent 定义**：可以定义多个不同配置的 Agent
2. **路由生效**：根据上下文自动选择正确的 Agent
3. **配置持久化**：Agent 配置可保存和加载
4. **UI 管理**：可通过设置界面管理 Agent
5. **回退机制**：无匹配时使用默认 Agent

## 风险与注意事项

1. **配置复杂度**：路由规则过多会难以维护
2. **性能开销**：每次消息都需要路由计算
3. **向后兼容**：确保无配置时使用默认行为

## 参考资料

- [Clawdbot resolve-route.ts](https://github.com/clawdbot/clawdbot/blob/main/src/routing/resolve-route.ts)
- [Clawdbot bindings.ts](https://github.com/clawdbot/clawdbot/blob/main/src/routing/bindings.ts)
