// ============================================================================
// Spawn Agent Tool - Create specialized sub-agents
// Gen 7: Multi-Agent capability
// Enhanced with parallel execution support (Enhancement 3)
// T4: Dual mode support (declarative + dynamic)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import type { ModelConfig } from '../../../shared/types';
import { getSubagentExecutor } from '../../agent/subagentExecutor';
import {
  getParallelAgentCoordinator,
  type AgentTask,
} from '../../agent/parallelAgentCoordinator';
import {
  getPredefinedAgent,
  listPredefinedAgents,
  type AgentDefinition,
} from '../../agent/agentDefinition';

// Legacy agent roles (kept for backward compatibility)
// New code should use PREDEFINED_AGENTS from agentDefinition.ts
const AGENT_ROLES: Record<string, AgentRole> = {
  coder: {
    name: 'Coder',
    description: 'Writes clean, efficient code following best practices',
    systemPrompt: `You are a senior software engineer. Your job is to:
- Write clean, maintainable, well-documented code
- Follow project conventions and patterns
- Consider edge cases and error handling
- Write code that is testable

Always explain your design decisions briefly.`,
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
  },
  reviewer: {
    name: 'Code Reviewer',
    description: 'Reviews code for bugs, security issues, and best practices',
    systemPrompt: `You are a code review expert. Your job is to:
- Find bugs and logic errors
- Identify security vulnerabilities
- Check for performance issues
- Ensure code follows project conventions
- Suggest improvements

Be constructive and specific in your feedback.`,
    tools: ['read_file', 'glob', 'grep'],
  },
  tester: {
    name: 'Test Engineer',
    description: 'Writes and runs comprehensive tests',
    systemPrompt: `You are a QA engineer specialized in testing. Your job is to:
- Write comprehensive unit tests
- Write integration tests
- Identify edge cases
- Run tests and analyze results
- Ensure high code coverage

Focus on testing behavior, not implementation details.`,
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob'],
  },
  architect: {
    name: 'Software Architect',
    description: 'Designs system architecture and makes technical decisions',
    systemPrompt: `You are a software architect. Your job is to:
- Design scalable system architectures
- Make technology choices
- Define interfaces and contracts
- Consider non-functional requirements
- Document architectural decisions

Think about maintainability, scalability, and simplicity.`,
    tools: ['read_file', 'glob', 'grep', 'write_file'],
  },
  debugger: {
    name: 'Debugger',
    description: 'Investigates and fixes bugs',
    systemPrompt: `You are a debugging specialist. Your job is to:
- Analyze error messages and stack traces
- Reproduce issues systematically
- Identify root causes
- Propose and implement fixes
- Verify the fix doesn't introduce regressions

Be methodical and document your investigation process.`,
    tools: ['bash', 'read_file', 'edit_file', 'glob', 'grep'],
  },
  documenter: {
    name: 'Technical Writer',
    description: 'Writes documentation and comments',
    systemPrompt: `You are a technical writer. Your job is to:
- Write clear README files
- Document APIs and interfaces
- Add helpful code comments
- Create usage examples
- Keep documentation up to date

Write for your audience - be clear and concise.`,
    tools: ['read_file', 'write_file', 'edit_file', 'glob'],
  },
};

interface AgentRole {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
}

/**
 * Get agent configuration from either predefined agents or legacy roles
 */
function resolveAgentConfig(roleOrId: string): AgentRole | AgentDefinition | undefined {
  // First, check predefined agents (new system)
  const predefined = getPredefinedAgent(roleOrId);
  if (predefined) {
    return predefined;
  }

  // Fall back to legacy roles
  return AGENT_ROLES[roleOrId];
}

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
  description: `Create a specialized sub-agent to handle a specific task.

DUAL MODE SUPPORT:
1. Declarative Mode - Use predefined agent IDs (recommended):
   ${listPredefinedAgents().map(a => `   - ${a.id}: ${a.description}`).join('\n')}

2. Dynamic Mode - Create custom agents at runtime with customPrompt and tools

Legacy roles (backward compatible):
- coder, reviewer, tester, architect, debugger, documenter

Use this tool to:
- Delegate tasks to specialized agents
- Run multiple agents in TRUE parallel (using parallel=true with agents array)
- Create custom agents for specific needs

All subagents go through unified permission/budget/audit pipeline.

Parameters:
- role: Agent role/ID (from predefined agents or legacy roles)
- task: Description of what the agent should do
- customPrompt: (optional) Custom system prompt override
- customTools: (optional) Custom tool list for dynamic agents
- maxBudget: (optional) Maximum budget in USD for this agent
- waitForCompletion: (optional) Whether to wait for agent to complete (default: true)
- parallel: (optional) Set to true to enable parallel execution mode
- agents: (optional) Array of {role, task, dependsOn?} for parallel execution`,
  generations: ['gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        description: 'The role/ID of the agent (predefined or legacy)',
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
    let agentConfig: AgentRole | AgentDefinition | undefined;
    let agentName: string;
    let systemPrompt: string;
    let tools: string[];

    if (isDynamicMode) {
      // Dynamic mode: use customPrompt and customTools
      agentName = 'Dynamic Agent';
      systemPrompt = customPrompt!;
      tools = customTools || ['read_file', 'glob', 'grep']; // Default read-only tools for safety
    } else {
      // Declarative mode: resolve from predefined or legacy
      if (!role) {
        return {
          success: false,
          error: 'Either provide role (for predefined agent) or customPrompt (for dynamic agent)',
        };
      }

      agentConfig = resolveAgentConfig(role);
      if (!agentConfig) {
        const predefinedIds = listPredefinedAgents().map(a => a.id);
        const legacyRoles = Object.keys(AGENT_ROLES);
        return {
          success: false,
          error: `Unknown agent: ${role}. Available predefined: ${predefinedIds.join(', ')}. Legacy roles: ${legacyRoles.join(', ')}`,
        };
      }

      agentName = agentConfig.name;
      systemPrompt = customPrompt || agentConfig.systemPrompt;
      tools = customTools || agentConfig.tools;
    }

    // Generate agent ID
    const agentId = `agent_${role || 'dynamic'}_${Date.now()}`;

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
      const permissionPreset = agentConfig && 'permissionPreset' in agentConfig
        ? (agentConfig as AgentDefinition).permissionPreset
        : 'development';

      // Determine max budget (use agent-specific or inherited)
      const effectiveMaxBudget = maxBudget
        || (agentConfig && 'maxBudget' in agentConfig ? (agentConfig as AgentDefinition).maxBudget : undefined);

      if (waitForCompletion) {
        // Execute and wait for result
        const result = await executor.execute(
          task,
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
          task,
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

// Export available roles
export function getAvailableRoles(): Record<string, AgentRole> {
  return { ...AGENT_ROLES };
}

// Execute multiple agents in parallel using the ParallelAgentCoordinator
async function executeParallelAgents(
  agents: Array<{ role: string; task: string; maxBudget?: number; dependsOn?: string[] }>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const coordinator = getParallelAgentCoordinator();

  // Initialize coordinator with context
  coordinator.initialize({
    modelConfig: context.modelConfig as ModelConfig,
    toolRegistry: new Map(
      context.toolRegistry!.getAllTools().map((t) => [t.name, t])
    ),
    toolContext: context,
  });

  // Convert to AgentTask format (supports both predefined and legacy roles)
  const tasks: AgentTask[] = agents.map((agent, index) => {
    // Try predefined agent first, then legacy
    const agentConfig = resolveAgentConfig(agent.role);
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agent.role}. Use predefined agents or legacy roles.`);
    }

    return {
      id: `agent_${agent.role}_${index}_${Date.now()}`,
      role: agent.role,
      task: agent.task,
      systemPrompt: agentConfig.systemPrompt,
      tools: agentConfig.tools,
      maxIterations: 'maxIterations' in agentConfig ? agentConfig.maxIterations || 20 : 20,
      dependsOn: agent.dependsOn,
    };
  });

  try {
    const result = await coordinator.executeParallel(tasks);

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
    return {
      success: false,
      error: `Parallel execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
