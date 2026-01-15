// ============================================================================
// Tool Registry - Manages available tools for each generation
// ============================================================================

import type {
  ToolDefinition,
  GenerationId,
  JSONSchema,
} from '../../shared/types';

// Import tool definitions
import { bashTool } from './gen1/bash';
import { readFileTool } from './gen1/readFile';
import { writeFileTool } from './gen1/writeFile';
import { editFileTool } from './gen1/editFile';
import { globTool } from './gen2/glob';
import { grepTool } from './gen2/grep';
import { listDirectoryTool } from './gen2/listDirectory';
import { taskTool } from './gen3/task';
import { todoWriteTool } from './gen3/todoWrite';
import { askUserQuestionTool } from './gen3/askUserQuestion';
import { planReadTool } from './gen3/planRead';
import { planUpdateTool } from './gen3/planUpdate';
import { findingsWriteTool } from './gen3/findingsWrite';
import { skillTool } from './gen4/skill';
import { webFetchTool } from './gen4/webFetch';
import { memoryStoreTool } from './gen5/memoryStore';
import { memorySearchTool } from './gen5/memorySearch';
import { codeIndexTool } from './gen5/codeIndex';
import { autoLearnTool } from './gen5/autoLearn';

// ----------------------------------------------------------------------------
// Tool Interface
// ----------------------------------------------------------------------------

export interface Tool extends ToolDefinition {
  execute: (
    params: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolExecutionResult>;
}

export interface ToolContext {
  workingDirectory: string;
  generation: { id: GenerationId };
  requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  emit?: (event: string, data: unknown) => void;
  planningService?: unknown; // PlanningService instance for persistent planning
  // For subagent execution
  toolRegistry?: ToolRegistry;
  modelConfig?: unknown;
}

export interface PermissionRequestData {
  type: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command';
  tool: string;
  details: Record<string, unknown>;
  reason?: string;
}

export interface ToolExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
}

// ----------------------------------------------------------------------------
// Tool Registry
// ----------------------------------------------------------------------------

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    this.registerAllTools();
  }

  private registerAllTools(): void {
    // Gen 1 tools
    this.register(bashTool);
    this.register(readFileTool);
    this.register(writeFileTool);
    this.register(editFileTool);

    // Gen 2 tools
    this.register(globTool);
    this.register(grepTool);
    this.register(listDirectoryTool);

    // Gen 3 tools
    this.register(taskTool);
    this.register(todoWriteTool);
    this.register(askUserQuestionTool);
    this.register(planReadTool);
    this.register(planUpdateTool);
    this.register(findingsWriteTool);

    // Gen 4 tools
    this.register(skillTool);
    this.register(webFetchTool);

    // Gen 5 tools
    this.register(memoryStoreTool);
    this.register(memorySearchTool);
    this.register(codeIndexTool);
    this.register(autoLearnTool);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getForGeneration(generationId: GenerationId): Tool[] {
    return Array.from(this.tools.values()).filter((tool) =>
      tool.generations.includes(generationId)
    );
  }

  getToolDefinitions(generationId: GenerationId): ToolDefinition[] {
    return this.getForGeneration(generationId).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      generations: tool.generations,
      requiresPermission: tool.requiresPermission,
      permissionLevel: tool.permissionLevel,
    }));
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }
}
