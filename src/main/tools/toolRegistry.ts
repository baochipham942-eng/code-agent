// ============================================================================
// Tool Registry - Manages available tools for each generation
// ============================================================================

import type {
  ToolDefinition,
  GenerationId,
  JSONSchema,
} from '../../shared/types';
import { getCloudConfigService } from '../services/cloud';

// Import tool definitions - organized by function
import { bashTool, grepTool, killShellTool, taskOutputTool } from './shell';
import { readFileTool, writeFileTool, editFileTool, globTool, listDirectoryTool, readClipboardTool, notebookEditTool } from './file';
import {
  taskTool,
  todoWriteTool,
  askUserQuestionTool,
  confirmActionTool,
  planReadTool,
  planUpdateTool,
  findingsWriteTool,
  enterPlanModeTool,
  exitPlanModeTool,
} from './planning';
import { skillTool, webFetchTool, webSearchTool, readPdfTool, pptGenerateTool, imageGenerateTool } from './network';
import {
  mcpTool,
  mcpListToolsTool,
  mcpListResourcesTool,
  mcpReadResourceTool,
  mcpGetStatusTool,
} from './mcp';
import { memoryStoreTool, memorySearchTool, codeIndexTool, autoLearnTool } from './memory';
import { screenshotTool, computerUseTool, browserNavigateTool, browserActionTool } from './vision';
import { spawnAgentTool, agentMessageTool, workflowOrchestrateTool } from './multiagent';
import { strategyOptimizeTool, toolCreateTool, selfEvaluateTool, learnPatternTool } from './evolution';
import { lspTool } from './lsp';

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

/**
 * Tool Registry - 工具注册表
 *
 * 管理所有可用工具的注册、查询和代际过滤。
 * 支持 8 代工具的渐进式注册。
 *
 * 核心功能：
 * - 工具注册和注销
 * - 按代际过滤工具
 * - 云端工具元数据合并
 * - 工具定义导出（供模型调用）
 *
 * @example
 * ```typescript
 * const registry = new ToolRegistry();
 *
 * // 获取 Gen4 可用的所有工具
 * const tools = registry.getForGeneration('gen4');
 *
 * // 获取特定工具
 * const bash = registry.get('bash');
 *
 * // 注册自定义工具
 * registry.register(myCustomTool);
 * ```
 *
 * @see ToolExecutor - 工具执行器
 * @see Tool - 工具接口定义
 */
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
    this.register(killShellTool);
    this.register(taskOutputTool);
    this.register(notebookEditTool);

    // Gen 2 tools
    this.register(globTool);
    this.register(grepTool);
    this.register(listDirectoryTool);

    // Gen 3 tools
    this.register(taskTool);
    this.register(todoWriteTool);
    this.register(askUserQuestionTool);
    this.register(confirmActionTool);
    this.register(readClipboardTool);
    this.register(planReadTool);
    this.register(planUpdateTool);
    this.register(findingsWriteTool);
    this.register(enterPlanModeTool);
    this.register(exitPlanModeTool);

    // Gen 4 tools
    this.register(skillTool);
    this.register(webFetchTool);
    this.register(webSearchTool);
    this.register(readPdfTool);
    this.register(lspTool);

    // Gen 5 tools - PPT & Image Generation
    this.register(pptGenerateTool);
    this.register(imageGenerateTool);

    // MCP tools (Gen 4+)
    this.register(mcpTool);
    this.register(mcpListToolsTool);
    this.register(mcpListResourcesTool);
    this.register(mcpReadResourceTool);
    this.register(mcpGetStatusTool);

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

  /**
   * 注册一个工具
   *
   * @param tool - 要注册的工具实例
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * 注销一个工具
   *
   * @param name - 工具名称
   * @returns true 表示成功注销，false 表示工具不存在
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 获取指定名称的工具
   *
   * @param name - 工具名称
   * @returns Tool 实例，如果不存在则返回 undefined
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取指定代际可用的所有工具
   *
   * @param generationId - 代际 ID（如 'gen1', 'gen4'）
   * @returns 该代际可用的工具数组
   */
  getForGeneration(generationId: GenerationId): Tool[] {
    return Array.from(this.tools.values()).filter((tool) =>
      tool.generations.includes(generationId)
    );
  }

  /**
   * 获取指定代际的工具定义（供模型调用）
   *
   * 会自动合并云端工具元数据（如描述）
   *
   * @param generationId - 代际 ID
   * @returns 工具定义数组
   */
  getToolDefinitions(generationId: GenerationId): ToolDefinition[] {
    const cloudToolMeta = getCloudConfigService().getAllToolMeta();

    return this.getForGeneration(generationId).map((tool) => {
      // 合并云端元数据（云端优先）
      const cloudMeta = cloudToolMeta[tool.name];
      const description = cloudMeta?.description || tool.description;

      return {
        name: tool.name,
        description,
        inputSchema: tool.inputSchema,
        generations: tool.generations,
        requiresPermission: tool.requiresPermission,
        permissionLevel: tool.permissionLevel,
      };
    });
  }

  /**
   * 获取所有已注册的工具
   *
   * @returns 所有工具的数组
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取工具定义（带云端元数据）
   */
  getToolDefinitionWithCloudMeta(name: string): ToolDefinition | undefined {
    const tool = this.get(name);
    if (!tool) return undefined;

    const cloudMeta = getCloudConfigService().getToolMeta(name);
    return {
      name: tool.name,
      description: cloudMeta?.description || tool.description,
      inputSchema: tool.inputSchema,
      generations: tool.generations,
      requiresPermission: tool.requiresPermission,
      permissionLevel: tool.permissionLevel,
    };
  }
}

// ----------------------------------------------------------------------------
// Global Singleton & Helper Functions
// ----------------------------------------------------------------------------

let globalRegistry: ToolRegistry | null = null;

/**
 * Get the global tool registry instance
 */
export function getToolRegistry(): ToolRegistry {
  if (!globalRegistry) {
    globalRegistry = new ToolRegistry();
  }
  return globalRegistry;
}

/**
 * Register a tool globally
 * Used by plugins to register their tools
 */
export function registerTool(tool: Tool): void {
  getToolRegistry().register(tool);
}

/**
 * Unregister a tool globally
 * Used by plugins to unregister their tools
 */
export function unregisterTool(name: string): boolean {
  return getToolRegistry().unregister(name);
}
