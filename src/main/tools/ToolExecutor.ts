// ============================================================================
// Tool Executor - Executes tools with permission handling
// ============================================================================

import type { Generation } from '../../shared/types';
import type {
  ToolRegistry,
  Tool,
  ToolContext,
  ToolExecutionResult,
  PermissionRequestData,
} from './ToolRegistry';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface ToolExecutorConfig {
  toolRegistry: ToolRegistry;
  requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  workingDirectory: string;
}

interface ExecuteOptions {
  generation: Generation;
  planningService?: unknown; // PlanningService instance for persistent planning
  modelConfig?: unknown; // ModelConfig for subagent execution
}

// ----------------------------------------------------------------------------
// Tool Executor
// ----------------------------------------------------------------------------

export class ToolExecutor {
  private toolRegistry: ToolRegistry;
  private requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  private workingDirectory: string;

  constructor(config: ToolExecutorConfig) {
    this.toolRegistry = config.toolRegistry;
    this.requestPermission = config.requestPermission;
    this.workingDirectory = config.workingDirectory;
  }

  setWorkingDirectory(path: string): void {
    this.workingDirectory = path;
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    options: ExecuteOptions
  ): Promise<ToolExecutionResult> {
    console.log(`[ToolExecutor] Executing tool: ${toolName}`, JSON.stringify(params).substring(0, 200));

    const tool = this.toolRegistry.get(toolName);

    if (!tool) {
      console.log(`[ToolExecutor] Tool not found: ${toolName}`);
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
      };
    }

    console.log(`[ToolExecutor] Tool found, generations: ${tool.generations.join(',')}, current: ${options.generation.id}`);

    // Check if tool is available for current generation
    if (!tool.generations.includes(options.generation.id)) {
      return {
        success: false,
        error: `Tool ${toolName} is not available in ${options.generation.name}`,
      };
    }

    // Create tool context
    const context: ToolContext = {
      workingDirectory: this.workingDirectory,
      generation: options.generation,
      requestPermission: this.requestPermission,
      planningService: options.planningService,
      // For subagent execution (task, skill tools)
      toolRegistry: this.toolRegistry,
      modelConfig: options.modelConfig,
    };

    // Check permission if required
    if (tool.requiresPermission) {
      const permissionRequest = this.buildPermissionRequest(tool, params);
      const approved = await this.requestPermission(permissionRequest);

      if (!approved) {
        return {
          success: false,
          error: 'Permission denied by user',
        };
      }
    }

    try {
      // Execute the tool
      console.log(`[ToolExecutor] Calling tool.execute for ${toolName}`);
      const result = await tool.execute(params, context);
      console.log(`[ToolExecutor] Tool ${toolName} result:`, result.success ? 'success' : result.error);
      return result;
    } catch (error) {
      console.error(`[ToolExecutor] Tool ${toolName} threw error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private buildPermissionRequest(
    tool: Tool,
    params: Record<string, unknown>
  ): PermissionRequestData {
    const details: Record<string, unknown> = {};

    switch (tool.name) {
      case 'bash':
        return {
          type: this.isDangerousCommand(params.command as string)
            ? 'dangerous_command'
            : 'command',
          tool: tool.name,
          details: { command: params.command },
          reason: 'Execute shell command',
        };

      case 'read_file':
        return {
          type: 'file_read',
          tool: tool.name,
          details: { path: params.file_path },
        };

      case 'write_file':
        return {
          type: 'file_write',
          tool: tool.name,
          details: {
            path: params.file_path,
            contentLength: (params.content as string)?.length || 0,
          },
        };

      case 'edit_file':
        return {
          type: 'file_edit',
          tool: tool.name,
          details: {
            path: params.file_path,
            oldString: params.old_string,
            newString: params.new_string,
          },
        };

      case 'web_fetch':
      case 'web_search':
        return {
          type: 'network',
          tool: tool.name,
          details: { url: params.url, query: params.query },
        };

      default:
        // Map permission level to permission request type
        const typeMap: Record<string, PermissionRequestData['type']> = {
          read: 'file_read',
          write: 'file_write',
          execute: 'command',
          network: 'network',
        };
        return {
          type: typeMap[tool.permissionLevel] || 'file_read',
          tool: tool.name,
          details: params,
        };
    }
  }

  private isDangerousCommand(command: string): boolean {
    const dangerousPatterns = [
      /rm\s+(-r|-rf|-f)?\s*[\/~]/,
      /rm\s+-rf?\s+\*/,
      />\s*\/dev\/sd/,
      /mkfs/,
      /dd\s+if=/,
      /:\(\)\{.*\}/,
      /git\s+push\s+.*--force/,
      /git\s+reset\s+--hard/,
      /chmod\s+-R\s+777/,
      /sudo\s+rm/,
    ];

    return dangerousPatterns.some((pattern) => pattern.test(command));
  }
}
