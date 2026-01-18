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
import { enterPlanModeTool } from './gen3/enterPlanMode';
import { exitPlanModeTool } from './gen3/exitPlanMode';
import { skillTool } from './gen4/skill';
import { webFetchTool } from './gen4/webFetch';
import { webSearchTool } from './gen4/webSearch';
import { memoryStoreTool } from './gen5/memoryStore';
import { memorySearchTool } from './gen5/memorySearch';
import { codeIndexTool } from './gen5/codeIndex';
import { autoLearnTool } from './gen5/autoLearn';

// Gen 6 tools - Computer Use
import { screenshotTool } from './gen6/screenshot.js';
import { computerUseTool } from './gen6/computerUse.js';
import { browserNavigateTool } from './gen6/browserNavigate.js';
import { browserActionTool } from './gen6/browserAction.js';

// Gen 7 tools - Multi-Agent
import { spawnAgentTool } from './gen7/spawnAgent';
import { agentMessageTool } from './gen7/agentMessage';
import { workflowOrchestrateTool } from './gen7/workflowOrchestrate';

// Gen 8 tools - Self-Evolution
import { strategyOptimizeTool } from './gen8/strategyOptimize';
import { toolCreateTool } from './gen8/toolCreate';
import { selfEvaluateTool } from './gen8/selfEvaluate';
import { learnPatternTool } from './gen8/learnPattern';

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
  emitEvent?: (event: string, data: unknown) => void; // Alias for emit
  planningService?: unknown; // PlanningService instance for persistent planning
  // For subagent execution
  toolRegistry?: ToolRegistry;
  modelConfig?: unknown;
  // Plan Mode support (borrowed from Claude Code v2.0)
  setPlanMode?: (active: boolean) => void;
  isPlanMode?: () => boolean;
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
  result?: unknown; // For caching purposes
  fromCache?: boolean; // Indicates if result was from cache
  metadata?: Record<string, unknown>; // Additional metadata for UI/workflow
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
    this.register(enterPlanModeTool);
    this.register(exitPlanModeTool);

    // Gen 4 tools
    this.register(skillTool);
    this.register(webFetchTool);
    this.register(webSearchTool);

    // Gen 5 tools
    this.register(memoryStoreTool);
    this.register(memorySearchTool);
    this.register(codeIndexTool);
    this.register(autoLearnTool);

    // Gen 6 tools - Computer Use
    this.register(screenshotTool);
    this.register(computerUseTool);
    this.register(browserNavigateTool);
    this.register(browserActionTool);

    // Gen 7 tools - Multi-Agent
    this.register(spawnAgentTool);
    this.register(agentMessageTool);
    this.register(workflowOrchestrateTool);

    // Gen 8 tools - Self-Evolution
    this.register(strategyOptimizeTool);
    this.register(toolCreateTool);
    this.register(selfEvaluateTool);
    this.register(learnPatternTool);
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
