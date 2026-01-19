// ============================================================================
// Task Tool - Delegate tasks to specialized subagents
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import type { ModelConfig } from '../../../shared/types';
import { getSubagentExecutor } from '../../agent/subagentExecutor';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('TaskTool');

// Subagent configurations
const SUBAGENT_TYPES = {
  explore: {
    id: 'explore',
    name: 'Explore',
    description: 'Fast agent for exploring codebases',
    systemPrompt: `You are a codebase exploration assistant. Your job is to quickly find and understand code.

When exploring:
1. Use glob to find files by pattern
2. Use grep to search for specific content
3. Use read_file to examine file contents
4. Use list_directory to understand structure

Be efficient - find the most relevant information quickly and summarize your findings clearly.`,
    availableTools: ['glob', 'grep', 'read_file', 'list_directory'],
    maxIterations: 10,
  },
  bash: {
    id: 'bash',
    name: 'Bash',
    description: 'Command execution specialist',
    systemPrompt: `You are a command-line execution assistant. Execute shell commands safely and report results.

Guidelines:
1. Be careful with destructive commands
2. Check command output for errors
3. Provide clear summaries of what happened
4. If a command fails, explain why and suggest fixes`,
    availableTools: ['bash'],
    maxIterations: 5,
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    description: 'Software architect for designing implementation plans',
    systemPrompt: `You are a software architect. Your job is to design implementation plans.

When planning:
1. First explore the codebase to understand existing patterns
2. Identify the files that need to be created or modified
3. Break down the task into clear, actionable steps
4. Consider edge cases and error handling
5. Note any dependencies or prerequisites

Provide a structured plan with:
- Overview of the approach
- Step-by-step implementation guide
- Files to create/modify
- Potential risks or considerations`,
    availableTools: ['glob', 'grep', 'read_file', 'list_directory'],
    maxIterations: 10,
  },
  'code-review': {
    id: 'code-review',
    name: 'Code Reviewer',
    description: 'Reviews code for bugs, security issues, and best practices',
    systemPrompt: `You are a code review assistant. Review code thoroughly for:

1. Bugs and logic errors
2. Security vulnerabilities
3. Performance issues
4. Code style and readability
5. Best practices violations

Provide specific feedback with file and line references when possible.`,
    availableTools: ['glob', 'grep', 'read_file'],
    maxIterations: 10,
  },
};

export const taskTool: Tool = {
  name: 'task',
  description: 'Launch a specialized subagent to handle complex tasks. Types: explore, bash, plan, code-review',
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task description for the subagent',
      },
      subagent_type: {
        type: 'string',
        description: 'Type of subagent: explore, bash, plan, code-review',
        enum: ['explore', 'bash', 'plan', 'code-review'],
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run the agent in background (default: false)',
      },
    },
    required: ['prompt', 'subagent_type'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const prompt = params.prompt as string;
    const subagentType = params.subagent_type as keyof typeof SUBAGENT_TYPES;
    const runInBackground = (params.run_in_background as boolean) || false;

    const subagentConfig = SUBAGENT_TYPES[subagentType];
    if (!subagentConfig) {
      return {
        success: false,
        error: `Unknown subagent type: ${subagentType}. Available: ${Object.keys(SUBAGENT_TYPES).join(', ')}`,
      };
    }

    // Background execution not yet supported
    if (runInBackground) {
      const taskId = `task-${Date.now()}`;
      return {
        success: true,
        output:
          `Task delegated to ${subagentConfig.name} agent (background).\n` +
          `Task ID: ${taskId}\n` +
          `Prompt: ${prompt}\n` +
          `Status: Background execution not yet implemented - task queued`,
      };
    }

    // Check if we have the required context for subagent execution
    if (!context.toolRegistry || !context.modelConfig) {
      return {
        success: true,
        output:
          `Task: ${subagentConfig.name}\n` +
          `Description: ${subagentConfig.description}\n` +
          `Available tools: ${subagentConfig.availableTools.join(', ')}\n\n` +
          `Prompt: ${prompt}\n\n` +
          `(Subagent context not available - execute manually)`,
      };
    }

    logger.info('Starting subagent execution', { subagentType });

    try {
      const executor = getSubagentExecutor();
      const result = await executor.execute(
        prompt,
        {
          name: subagentConfig.name,
          systemPrompt: subagentConfig.systemPrompt,
          availableTools: subagentConfig.availableTools,
          maxIterations: subagentConfig.maxIterations,
        },
        {
          modelConfig: context.modelConfig as ModelConfig,
          toolRegistry: new Map(
            context.toolRegistry.getAllTools().map((t) => [t.name, t])
          ),
          toolContext: context,
        }
      );

      if (result.success) {
        return {
          success: true,
          output:
            `✅ ${subagentConfig.name} agent completed\n` +
            `Iterations: ${result.iterations}\n` +
            `Tools used: ${result.toolsUsed.join(', ') || 'none'}\n\n` +
            `Result:\n${result.output}`,
        };
      } else {
        return {
          success: false,
          error: `${subagentConfig.name} agent failed: ${result.error}`,
          output: result.output,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Subagent execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};
