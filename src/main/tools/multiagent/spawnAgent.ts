// ============================================================================
// Spawn Agent Tool - Create specialized sub-agents
// Gen 7: Multi-Agent capability
// Enhanced with parallel execution support
// Refactored: Uses unified 4-layer agent types
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import type { ModelConfig } from '../../../shared/types';
import type { FullAgentConfig } from '../../../shared/types/agentTypes';
import { getSubagentExecutor } from '../../agent/subagentExecutor';
import {
  getParallelAgentCoordinator,
  type AgentTask,
} from '../../agent/parallelAgentCoordinator';
import {
  getPredefinedAgent,
  listPredefinedAgents,
  getAgentPrompt,
  getAgentTools,
  getAgentMaxIterations,
  getAgentPermissionPreset,
  getAgentMaxBudget,
} from '../../agent/agentDefinition';
import {
  SubagentContextBuilder,
  getAgentContextLevel,
} from '../../agent/subagentContextBuilder';
import { getSwarmEventEmitter } from '../../ipc/swarm.ipc';

interface SpawnedAgent {
  id: string;
  role: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  task?: string;
  result?: string;
  error?: string;
}

// Global registry of spawned agents
const spawnedAgents: Map<string, SpawnedAgent> = new Map();

export const spawnAgentTool: Tool = {
  name: 'spawn_agent',
  description: `Spawns a sub-agent to handle complex, multi-step tasks autonomously. Use for parallelizing independent work, deep research, or tasks that benefit from isolated context. Each agent runs independently and returns results when complete.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        description: 'The role/ID of the agent (built-in or predefined)',
      },
      task: {
        type: 'string',
        description: 'The task for the agent to complete',
      },
      customPrompt: {
        type: 'string',
        description: 'Custom system prompt (overrides role default, enables dynamic mode)',
      },
      customTools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Custom tool list for dynamic agents',
      },
      maxBudget: {
        type: 'number',
        description: 'Maximum budget in USD for this agent',
      },
      waitForCompletion: {
        type: 'boolean',
        description: 'Wait for agent to complete before returning',
      },
      maxIterations: {
        type: 'number',
        description: 'Maximum iterations for the agent (default: 20)',
      },
      parallel: {
        type: 'boolean',
        description: 'Enable parallel execution mode',
      },
      agents: {
        type: 'array',
        description: 'Array of agents for parallel execution',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string' },
            task: { type: 'string' },
            maxBudget: { type: 'number' },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of agents this one depends on',
            },
          },
          required: ['role', 'task'],
        },
      },
    },
    required: [],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const parallel = params.parallel as boolean | undefined;
    const agents = params.agents as Array<{ role: string; task: string; maxBudget?: number; dependsOn?: string[] }> | undefined;

    // Check for required context
    if (!context.toolRegistry || !context.modelConfig) {
      return {
        success: false,
        error: 'spawn_agent requires toolRegistry and modelConfig in context',
      };
    }

    // Handle parallel execution mode
    if (parallel && agents && agents.length > 0) {
      return executeParallelAgents(agents, context);
    }

    // Single agent mode
    const role = params.role as string;
    const task = params.task as string;
    const customPrompt = params.customPrompt as string | undefined;
    const customTools = params.customTools as string[] | undefined;
    const maxBudget = params.maxBudget as number | undefined;
    const waitForCompletion = params.waitForCompletion !== false;
    const maxIterations = (params.maxIterations as number) || 20;

    // Validate required params for single agent
    if (!task) {
      return {
        success: false,
        error: 'Task is required. Provide role+task for predefined agent or customPrompt+task for dynamic agent.',
      };
    }

    // Determine agent mode: declarative (predefined) or dynamic
    const isDynamicMode = customPrompt && !role;
    let agentConfig: FullAgentConfig | undefined;
    let agentName: string;
    let systemPrompt: string;
    let tools: string[];

    if (isDynamicMode) {
      // Dynamic mode: use customPrompt and customTools
      agentName = 'Dynamic Agent';
      systemPrompt = customPrompt!;
      tools = customTools || ['read_file', 'glob', 'grep']; // Default read-only tools for safety
    } else {
      // Declarative mode: resolve from predefined agents
      if (!role) {
        return {
          success: false,
          error: 'Either provide role (for predefined agent) or customPrompt (for dynamic agent)',
        };
      }

      agentConfig = getPredefinedAgent(role);
      if (!agentConfig) {
        const availableIds = listPredefinedAgents().map(a => a.id);
        return {
          success: false,
          error: `Unknown agent: ${role}. Available agents: ${availableIds.join(', ')}`,
        };
      }

      agentName = agentConfig.name;
      systemPrompt = customPrompt || getAgentPrompt(agentConfig);
      tools = customTools || getAgentTools(agentConfig);
    }

    // 根据 task 内容过滤文档工具 — 代码任务不需要 read_pdf/read_docx/read_xlsx
    {
      const DOCUMENT_TOOLS = ['read_pdf', 'read_docx', 'read_xlsx'];
      const taskLower = task.toLowerCase();
      const needsDocTools = DOCUMENT_TOOLS.some(t => taskLower.includes(t))
        || /\.(pdf|docx|xlsx|doc|xls)\b/.test(taskLower);
      if (!needsDocTools) {
        tools = tools.filter(t => !DOCUMENT_TOOLS.includes(t));
      }
    }

    // ========================================================================
    // Phase 0: Subagent 上下文注入
    // ========================================================================
    // 借鉴 Claude Code: "Agents with access to current context can see the
    // full conversation history before the tool call"
    try {
      // 确定上下文级别
      const contextLevel = context.contextLevel || (role ? getAgentContextLevel(role) : 'relevant');

      // 只有在有足够上下文信息时才注入
      if (context.messages && context.messages.length > 0) {
        const contextBuilder = new SubagentContextBuilder({
          sessionId: context.sessionId || 'unknown',
          messages: context.messages,
          contextLevel,
          todos: context.todos,
          modifiedFiles: context.modifiedFiles,
        });

        const subagentContext = await contextBuilder.build(task);
        const contextPrompt = contextBuilder.formatForSystemPrompt(subagentContext);

        if (contextPrompt) {
          systemPrompt = systemPrompt + contextPrompt;
        }
      }
    } catch (err) {
      // 上下文注入失败不应阻止任务执行
      console.warn('[SpawnAgent] Failed to inject subagent context:', err);
    }

    // Generate agent ID
    const agentId = `agent_${role || 'dynamic'}_${Date.now()}`;

    // Defensive check: ensure sessionId is available for task tool sharing
    if (!context.sessionId) {
      console.warn('[SpawnAgent] No sessionId in context — subagent task tools will use isolated session');
    }

    // Create agent record
    const agent: SpawnedAgent = {
      id: agentId,
      role: role || 'dynamic',
      status: 'running',
      task,
    };
    spawnedAgents.set(agentId, agent);

    try {
      const executor = getSubagentExecutor();
      // Pipeline is integrated in executor, we just use it for configuration

      // Determine permission preset based on agent config
      const permissionPreset = agentConfig
        ? getAgentPermissionPreset(agentConfig)
        : 'development';

      // Determine max budget (use agent-specific or inherited)
      const effectiveMaxBudget = maxBudget || (agentConfig ? getAgentMaxBudget(agentConfig) : undefined);

      // 注入工作目录到 task，避免子 Agent 使用相对路径
    const cwd = context.workingDirectory || process.cwd();
    const enrichedTask = `[工作目录: ${cwd}] 所有文件路径基于此目录。\n\n${task}`;

    if (waitForCompletion) {
        // Execute and wait for result
        const result = await executor.execute(
          enrichedTask,
          {
            name: agentName,
            systemPrompt,
            availableTools: tools,
            maxIterations,
            permissionPreset,
            maxBudget: effectiveMaxBudget,
          },
          {
            modelConfig: context.modelConfig as ModelConfig,
            toolRegistry: new Map(
              context.toolRegistry.getAllTools().map((t) => [t.name, t])
            ),
            toolContext: context,
            // 传递父工具调用 ID，用于 subagent 消息追踪
            parentToolUseId: context.currentToolCallId,
          }
        );

        agent.status = result.success ? 'completed' : 'failed';
        agent.result = result.output;
        agent.error = result.error;

        if (result.success) {
          return {
            success: true,
            output: `Agent [${agentName}] completed task:

Task: ${task}

Result:
${result.output}

Stats:
- Iterations: ${result.iterations}
- Tools used: ${result.toolsUsed.join(', ') || 'none'}
- Agent ID: ${agentId}
- Pipeline ID: ${result.agentId || 'N/A'}${result.cost !== undefined ? `\n- Cost: $${result.cost.toFixed(4)}` : ''}`,
          };
        } else {
          return {
            success: false,
            error: `Agent [${agentName}] failed: ${result.error}`,
            output: result.output,
          };
        }
      } else {
        // Start agent in background (fire and forget)
        executor.execute(
          enrichedTask,
          {
            name: agentName,
            systemPrompt,
            availableTools: tools,
            maxIterations,
            permissionPreset,
            maxBudget: effectiveMaxBudget,
          },
          {
            modelConfig: context.modelConfig as ModelConfig,
            toolRegistry: new Map(
              context.toolRegistry.getAllTools().map((t) => [t.name, t])
            ),
            toolContext: context,
            // 传递父工具调用 ID，用于 subagent 消息追踪
            parentToolUseId: context.currentToolCallId,
          }
        ).then((result) => {
          agent.status = result.success ? 'completed' : 'failed';
          agent.result = result.output;
          agent.error = result.error;
        }).catch((error) => {
          agent.status = 'failed';
          agent.error = error instanceof Error ? error.message : 'Unknown error';
        });

        return {
          success: true,
          output: `Agent [${agentName}] spawned in background:
- Agent ID: ${agentId}
- Task: ${task}
- Status: running
- Mode: ${isDynamicMode ? 'dynamic' : 'declarative'}

Use agent_message tool with agentId to check status or get results.`,
        };
      }
    } catch (error) {
      agent.status = 'failed';
      agent.error = error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        error: `Failed to spawn agent: ${agent.error}`,
      };
    }
  },
};

// Export function to get agent status (used by agent_message tool)
export function getSpawnedAgent(agentId: string): SpawnedAgent | undefined {
  return spawnedAgents.get(agentId);
}

// Export function to list all agents
export function listSpawnedAgents(): SpawnedAgent[] {
  return Array.from(spawnedAgents.values());
}

// Export available agents
export function getAvailableAgents(): Array<{ id: string; name: string; description: string }> {
  return listPredefinedAgents();
}

// PascalCase alias for SDK compatibility
export const agentSpawnTool: Tool = {
  ...spawnAgentTool,
  name: 'AgentSpawn',
  description: `Advanced agent creation with full control over execution.

Use this tool when you need:
- Parallel execution (multiple agents at once)
- Background mode (fire and forget)
- Custom prompts or tools
- Budget control

For simple synchronous task delegation, use Task instead.

${spawnAgentTool.description}`,
};

// Execute multiple agents in parallel using the ParallelAgentCoordinator
async function executeParallelAgents(
  agents: Array<{ role: string; task: string; maxBudget?: number; dependsOn?: string[] }>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const coordinator = getParallelAgentCoordinator();
  const emitter = getSwarmEventEmitter();

  // Initialize coordinator with context
  coordinator.initialize({
    modelConfig: context.modelConfig as ModelConfig,
    toolRegistry: new Map(
      context.toolRegistry!.getAllTools().map((t) => [t.name, t])
    ),
    toolContext: context,
  });

  // Convert to AgentTask format
  // Phase 1: 生成稳定的 ID 并建立 role→id 映射（用于解析 dependsOn）
  const roleToId = new Map<string, string>();
  const cwd = context.workingDirectory || process.cwd();

  const tasks: AgentTask[] = agents.map((agent, index) => {
    const agentConfig = getPredefinedAgent(agent.role);
    if (!agentConfig) {
      const availableIds = listPredefinedAgents().map(a => a.id);
      throw new Error(
        `Unknown agent: ${agent.role}. Available agents: ${availableIds.join(', ')}`
      );
    }

    // 使用 role_index 作为稳定 ID，避免 Date.now() 导致 dependsOn 无法匹配
    const taskId = `agent_${agent.role}_${index}`;
    roleToId.set(agent.role, taskId);
    // 也支持 "role-index" 格式引用
    roleToId.set(`${agent.role}-${index}`, taskId);

    // 根据 task 内容过滤文档工具 — 代码任务不需要 read_pdf/read_docx/read_xlsx
    const DOCUMENT_TOOLS = ['read_pdf', 'read_docx', 'read_xlsx'];
    const taskLower = agent.task.toLowerCase();
    const needsDocTools = DOCUMENT_TOOLS.some(t => taskLower.includes(t))
      || /\.(pdf|docx|xlsx|doc|xls)\b/.test(taskLower);
    let tools = getAgentTools(agentConfig);
    if (!needsDocTools) {
      tools = tools.filter(t => !DOCUMENT_TOOLS.includes(t));
    }

    return {
      id: taskId,
      role: agent.role,
      task: `[工作目录: ${cwd}] 所有文件路径基于此目录。\n\n${agent.task}`,
      systemPrompt: getAgentPrompt(agentConfig),
      tools,
      maxIterations: getAgentMaxIterations(agentConfig),
      dependsOn: agent.dependsOn,
    };
  });

  // Phase 2: 解析 dependsOn — 将 role 名称映射到实际 task ID
  for (const task of tasks) {
    if (task.dependsOn) {
      task.dependsOn = task.dependsOn.map(dep => {
        // 优先精确匹配 task ID
        if (tasks.some(t => t.id === dep)) return dep;
        // 再尝试 role→id 映射
        return roleToId.get(dep) || dep;
      });
    }
  }

  // Emit swarm:started
  emitter.started(tasks.length);
  for (const task of tasks) {
    emitter.agentAdded({ id: task.id, name: task.role, role: task.role });
  }

  // Bridge coordinator events to swarm events
  const onTaskStart = (evt: { taskId: string; role: string }) => {
    emitter.agentUpdated(evt.taskId, { status: 'running', startTime: Date.now() });
  };
  const onTaskComplete = (evt: { taskId: string; result: { success: boolean; duration: number; output?: string; error?: string } }) => {
    if (evt.result.success) {
      emitter.agentCompleted(evt.taskId, evt.result.output);
    } else {
      emitter.agentFailed(evt.taskId, evt.result.error || 'Unknown error');
    }
  };
  const onTaskError = (evt: { taskId: string; error: string }) => {
    emitter.agentFailed(evt.taskId, evt.error);
  };

  coordinator.on('task:start', onTaskStart);
  coordinator.on('task:complete', onTaskComplete);
  coordinator.on('task:error', onTaskError);

  try {
    const result = await coordinator.executeParallel(tasks);

    // Emit swarm:completed
    emitter.completed({
      total: tasks.length,
      completed: result.results.filter(r => r.success).length,
      failed: result.errors.length,
      parallelPeak: result.parallelism,
      totalTime: result.totalDuration,
    });

    if (result.success) {
      const summaries = result.results.map((r) =>
        `[${r.role}] ${r.success ? 'Completed' : 'Failed'} in ${r.duration}ms\n${r.output || r.error || ''}`
      ).join('\n\n---\n\n');

      return {
        success: true,
        output: `Parallel execution completed:
- Total duration: ${result.totalDuration}ms
- Max parallelism: ${result.parallelism}
- Tasks completed: ${result.results.length}
- Errors: ${result.errors.length}

Results:
${summaries}`,
      };
    } else {
      return {
        success: false,
        error: `Parallel execution failed with ${result.errors.length} errors: ${result.errors.map(e => e.error).join(', ')}`,
        output: result.results.map(r => r.output).join('\n\n'),
      };
    }
  } catch (error) {
    emitter.cancelled();
    return {
      success: false,
      error: `Parallel execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  } finally {
    // Cleanup event listeners
    coordinator.off('task:start', onTaskStart);
    coordinator.off('task:complete', onTaskComplete);
    coordinator.off('task:error', onTaskError);
  }
}
