// ============================================================================
// Spawn Agent Tool - Create specialized sub-agents
// Gen 7: Multi-Agent capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import type { ModelConfig } from '../../../shared/types';
import { getSubagentExecutor } from '../../agent/SubagentExecutor';

// Predefined agent roles with specialized prompts
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

Available agent roles:
- coder: Writes clean, efficient code
- reviewer: Reviews code for bugs and issues
- tester: Writes and runs tests
- architect: Designs system architecture
- debugger: Investigates and fixes bugs
- documenter: Writes documentation

Use this tool to:
- Delegate tasks to specialized agents
- Run multiple agents in parallel
- Create custom agents for specific needs

Parameters:
- role: Agent role (coder, reviewer, tester, architect, debugger, documenter)
- task: Description of what the agent should do
- customPrompt: (optional) Custom system prompt override
- waitForCompletion: (optional) Whether to wait for agent to complete (default: true)`,
  generations: ['gen7'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: Object.keys(AGENT_ROLES),
        description: 'The role of the agent to spawn',
      },
      task: {
        type: 'string',
        description: 'The task for the agent to complete',
      },
      customPrompt: {
        type: 'string',
        description: 'Custom system prompt (overrides role default)',
      },
      waitForCompletion: {
        type: 'boolean',
        description: 'Wait for agent to complete before returning',
      },
      maxIterations: {
        type: 'number',
        description: 'Maximum iterations for the agent (default: 20)',
      },
    },
    required: ['role', 'task'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const role = params.role as string;
    const task = params.task as string;
    const customPrompt = params.customPrompt as string | undefined;
    const waitForCompletion = params.waitForCompletion !== false;
    const maxIterations = (params.maxIterations as number) || 20;

    // Validate role
    const agentRole = AGENT_ROLES[role];
    if (!agentRole) {
      return {
        success: false,
        error: `Unknown agent role: ${role}. Available: ${Object.keys(AGENT_ROLES).join(', ')}`,
      };
    }

    // Check for required context
    if (!context.toolRegistry || !context.modelConfig) {
      return {
        success: false,
        error: 'spawn_agent requires toolRegistry and modelConfig in context',
      };
    }

    // Generate agent ID
    const agentId = `agent_${role}_${Date.now()}`;

    // Create agent record
    const agent: SpawnedAgent = {
      id: agentId,
      role,
      status: 'running',
      task,
    };
    spawnedAgents.set(agentId, agent);

    const systemPrompt = customPrompt || agentRole.systemPrompt;

    try {
      const executor = getSubagentExecutor();

      if (waitForCompletion) {
        // Execute and wait for result
        const result = await executor.execute(
          task,
          {
            name: `${agentRole.name}`,
            systemPrompt,
            availableTools: agentRole.tools,
            maxIterations,
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
            output: `Agent [${agentRole.name}] completed task:

Task: ${task}

Result:
${result.output}

Stats:
- Iterations: ${result.iterations}
- Tools used: ${result.toolsUsed.join(', ') || 'none'}
- Agent ID: ${agentId}`,
          };
        } else {
          return {
            success: false,
            error: `Agent [${agentRole.name}] failed: ${result.error}`,
            output: result.output,
          };
        }
      } else {
        // Start agent in background (fire and forget)
        executor.execute(
          task,
          {
            name: `${agentRole.name}`,
            systemPrompt,
            availableTools: agentRole.tools,
            maxIterations,
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
          output: `Agent [${agentRole.name}] spawned in background:
- Agent ID: ${agentId}
- Task: ${task}
- Status: running

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
