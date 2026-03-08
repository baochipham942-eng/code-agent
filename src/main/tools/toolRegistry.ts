// ============================================================================
// Tool Registry - Manages available tools for each generation
// ============================================================================

import type {
  ToolDefinition,
  JSONSchema,
} from '../../shared/types';
import { getCloudConfigService } from '../services/cloud';
import { toolSearchTool, CORE_TOOLS, getToolSearchService } from './search';

// Import tool definitions - organized by function

// Shell tools
import {
  bashTool,
  grepTool,
  killShellTool,
  taskOutputTool,
  processListTool,
  processPollTool,
  processLogTool,
  processWriteTool,
  processSubmitTool,
  processKillTool,
} from './shell';

// File tools
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  listDirectoryTool,
  readClipboardTool,
  notebookEditTool,
} from './file';

// Planning tools
import {
  taskTool,
  todoWriteTool,
  askUserQuestionTool,
  confirmActionTool,
  planReadTool,
  planUpdateTool,
  enterPlanModeTool,
  exitPlanModeTool,
  findingsWriteTool,
  taskCreateTool,
  taskGetTool,
  taskListTool,
  taskUpdateTool,
} from './planning';

// Network tools
import {
  webFetchTool,
  webSearchTool,
  readPdfTool,
  pptGenerateTool,
  imageGenerateTool,
  videoGenerateTool,
  imageAnalyzeTool,
  docxGenerateTool,
  excelGenerateTool,
  chartGenerateTool,
  qrcodeGenerateTool,
  readDocxTool,
  readXlsxTool,
  jiraTool,
  githubPrTool,
  youtubeTranscriptTool,
  twitterFetchTool,
  mermaidExportTool,
  pdfGenerateTool,
  pdfCompressTool,
  imageProcessTool,
  screenshotPageTool,
  academicSearchTool,
  httpRequestTool,
  speechToTextTool,
  localSpeechToTextTool,
  textToSpeechTool,
  imageAnnotateTool,
  xlwingsExecuteTool,
} from './network';

// MCP tools
import {
  mcpTool,
  mcpListToolsTool,
  mcpListResourcesTool,
  mcpReadResourceTool,
  mcpGetStatusTool,
} from './mcp';
import { mcpAddServerTool } from './mcp';

// Memory tools
import { memoryTool, codeIndexTool, autoLearnTool, forkSessionTool } from './memory';

// Vision tools
import {
  screenshotTool,
  computerUseTool,
  browserNavigateTool,
  browserActionTool,
  guiAgentTool,
} from './vision';

// Skill tools
import { skillMetaTool } from './skill';

// Multi-agent tools
import {
  sdkTaskTool,
  agentSpawnTool,
  AgentMessageTool,
  WorkflowOrchestrateTool,
  TeammateTool,
  // DEPRECATED: spawnAgentTool, agentMessageTool, workflowOrchestrateTool, teammateTool removed — use PascalCase versions
  planReviewTool,
} from './multiagent';

// Evolution tools
import { strategyOptimizeTool, toolCreateTool, selfEvaluateTool, learnPatternTool, codeExecuteTool, queryMetricsTool } from './evolution';

// LSP tools
import { lspTool, diagnosticsTool } from './lsp';

// Unified tools (Phase 2 - consolidated from multiple tools)
import { ProcessTool } from './shell/ProcessTool';
import { MCPUnifiedTool } from './mcp/MCPUnifiedTool';
import { TaskManagerTool } from './planning/TaskManagerTool';
import { PlanTool } from './planning/PlanTool';
import { PlanModeTool } from './planning/PlanModeTool';
import { WebFetchUnifiedTool } from './network/WebFetchUnifiedTool';
import { ReadDocumentTool } from './network/ReadDocumentTool';
import { BrowserTool } from './vision/BrowserTool';
import { ComputerTool } from './vision/ComputerTool';

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
  generation: { id: string };
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
  // Current message attachments (images, files) for multi-agent workflows
  currentAttachments?: Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }>;
  // 当前工具调用 ID（用于 subagent 追踪）
  currentToolCallId?: string;

  // ============================================================================
  // Phase 0: Subagent 上下文传递支持
  // ============================================================================

  /** 会话 ID（用于上下文追踪） */
  sessionId?: string;
  /** 对话历史（用于 Subagent 上下文注入） */
  messages?: import('../../shared/types').Message[];
  /** 已修改的文件集合（用于 Subagent 上下文注入） */
  modifiedFiles?: Set<string>;
  /** TODO 列表（用于 Subagent 上下文注入） */
  todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>;
  /** 上下文级别覆盖（可选） */
  contextLevel?: 'minimal' | 'relevant' | 'full';

  // ============================================================================
  // Teammate 通信支持
  // ============================================================================

  /** 当前 Agent ID（用于 teammate 工具识别身份） */
  agentId?: string;
  /** 当前 Agent 名称 */
  agentName?: string;
  /** 当前 Agent 角色 */
  agentRole?: string;

  // ============================================================================
  // 模型回调支持（工具内二次调用模型）
  // ============================================================================

  /** 模型推理回调：接收 prompt 文本，返回模型响应文本 */
  modelCallback?: (prompt: string) => Promise<string>;
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
// Tool Aliases - Maps legacy snake_case names to PascalCase
// ----------------------------------------------------------------------------

const TOOL_ALIASES: Record<string, string> = {
  spawn_agent: 'AgentSpawn',
  agent_message: 'AgentMessage',
  workflow_orchestrate: 'WorkflowOrchestrate',
  teammate: 'Teammate',
  Edit: 'edit_file',
  multi_edit_file: 'edit_file',
  memory_store: 'memory',
  memory_search: 'memory',

  // Phase 2: Deferred tool aliases → unified tools
  process_list: 'Process',
  process_poll: 'Process',
  process_log: 'Process',
  process_write: 'Process',
  process_submit: 'Process',
  process_kill: 'Process',
  kill_shell: 'Process',
  task_output: 'Process',

  mcp_list_tools: 'MCPUnified',
  mcp_list_resources: 'MCPUnified',
  mcp_read_resource: 'MCPUnified',
  mcp_get_status: 'MCPUnified',
  mcp_add_server: 'MCPUnified',

  task_create: 'TaskManager',
  TaskCreate: 'TaskManager',
  task_get: 'TaskManager',
  TaskGet: 'TaskManager',
  task_list: 'TaskManager',
  TaskList: 'TaskManager',
  task_update: 'TaskManager',
  TaskUpdate: 'TaskManager',

  plan_read: 'Plan',
  plan_update: 'Plan',
  enter_plan_mode: 'PlanMode',
  exit_plan_mode: 'PlanMode',

  http_request: 'WebFetch',

  read_pdf: 'ReadDocument',
  read_docx: 'ReadDocument',
  read_xlsx: 'ReadDocument',

  browser_navigate: 'Browser',
  browser_action: 'Browser',

  screenshot: 'Computer',
  computer_use: 'Computer',
};

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
 * - 工具别名支持（legacy snake_case → PascalCase）
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
    this.register(editFileTool); // single-edit tool (old_string/new_string)
    this.register(killShellTool);
    this.register(taskOutputTool);
    this.register(notebookEditTool);

    // Process management tools (PTY support)
    this.register(processListTool);
    this.register(processPollTool);
    this.register(processLogTool);
    this.register(processWriteTool);
    this.register(processSubmitTool);
    this.register(processKillTool);

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
    // Task API (Claude Code 2.x compatible)
    this.register(taskCreateTool);
    this.register(taskGetTool);
    this.register(taskListTool);
    this.register(taskUpdateTool);

    // Gen 4 tools - Skill Meta Tool (Agent Skills Standard)
    this.register(skillMetaTool);
    this.register(webFetchTool);
    this.register(webSearchTool);
    this.register(readPdfTool);
    this.register(lspTool);
    this.register(diagnosticsTool);

    // Gen 5 tools - Office Documents & Image & Data
    this.register(pptGenerateTool);
    this.register(imageGenerateTool);
    this.register(videoGenerateTool);
    this.register(imageAnalyzeTool);
    this.register(docxGenerateTool);
    this.register(excelGenerateTool);
    this.register(chartGenerateTool);
    this.register(qrcodeGenerateTool);
    this.register(readDocxTool);
    this.register(readXlsxTool);
    this.register(jiraTool);
    this.register(githubPrTool);
    this.register(youtubeTranscriptTool);
    this.register(twitterFetchTool);
    this.register(mermaidExportTool);
    this.register(pdfGenerateTool);
    this.register(pdfCompressTool);
    this.register(imageProcessTool);
    this.register(screenshotPageTool);
    this.register(academicSearchTool);
    this.register(speechToTextTool);
    this.register(localSpeechToTextTool);
    this.register(textToSpeechTool);
    this.register(imageAnnotateTool);
    this.register(xlwingsExecuteTool);

    // Gen 4 tools - HTTP API
    this.register(httpRequestTool);

    // MCP tools (Gen 4+)
    this.register(mcpTool);
    this.register(mcpListToolsTool);
    this.register(mcpListResourcesTool);
    this.register(mcpReadResourceTool);
    this.register(mcpGetStatusTool);
    this.register(mcpAddServerTool);

    // Gen 5 tools
    this.register(memoryTool); // unified store + search (replaces memory_store & memory_search)
    this.register(codeIndexTool);
    this.register(autoLearnTool);
    this.register(forkSessionTool);

    // Gen 6 tools - Computer Use
    this.register(screenshotTool);
    this.register(computerUseTool);
    this.register(browserNavigateTool);
    this.register(browserActionTool);
    this.register(guiAgentTool);

    // Gen 7 tools - Multi-Agent
    // SDK-compatible Task tool (simplified interface)
    this.register(sdkTaskTool);
    // PascalCase tools (legacy snake_case retired — aliases handle backward compat)
    this.register(agentSpawnTool);
    this.register(AgentMessageTool);
    this.register(WorkflowOrchestrateTool);
    this.register(TeammateTool);
    // Plan review (cross-agent approval)
    this.register(planReviewTool);

    // Gen 8 tools - Self-Evolution
    this.register(strategyOptimizeTool);
    this.register(toolCreateTool);
    this.register(selfEvaluateTool);
    this.register(learnPatternTool);
    this.register(codeExecuteTool);
    this.register(queryMetricsTool);


    // Phase 2: Unified tools (consolidated from multiple tools)
    this.register(ProcessTool);
    this.register(MCPUnifiedTool);
    this.register(TaskManagerTool);
    this.register(PlanTool);
    this.register(PlanModeTool);
    this.register(WebFetchUnifiedTool);
    this.register(ReadDocumentTool);
    this.register(BrowserTool);
    this.register(ComputerTool);

    // Tool Search (核心工具，始终可用)
    this.register(toolSearchTool);
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
   * 获取指定名称的工具（支持别名）
   *
   * @param name - 工具名称（支持 snake_case 别名自动映射到 PascalCase）
   * @returns Tool 实例，如果不存在则返回 undefined
   */
  get(name: string): Tool | undefined {
    // 直接查找
    const tool = this.tools.get(name);
    if (tool) return tool;

    // 别名查找（legacy snake_case → PascalCase）
    const aliasedName = TOOL_ALIASES[name];
    if (aliasedName) return this.tools.get(aliasedName);

    return undefined;
  }

  /**
   * 获取指定代际可用的所有工具
   *
   * @param generationId - 代际 ID（如 'gen1', 'gen4'）
   * @returns 该代际可用的工具数组
   */
  /** @simplified Returns all tools regardless of generationId (locked to gen8) */
  getForGeneration(_generationId?: string): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取指定代际的工具定义（供模型调用）
   *
   * 会自动合并云端工具元数据（如描述）
   *
   * @param generationId - 代际 ID
   * @returns 工具定义数组
   */
  getToolDefinitions(_generationId?: string): ToolDefinition[] {
    const cloudToolMeta = getCloudConfigService().getAllToolMeta();

    return this.getAllTools().map((tool) => {
      // 合并云端元数据（优先级: cloud > dynamic > static）
      const cloudMeta = cloudToolMeta[tool.name];
      const description = cloudMeta?.description || tool.dynamicDescription?.() || tool.description;

      return {
        name: tool.name,
        description,
        inputSchema: tool.inputSchema,
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
      description: cloudMeta?.description || tool.dynamicDescription?.() || tool.description,
      inputSchema: tool.inputSchema,
      requiresPermission: tool.requiresPermission,
      permissionLevel: tool.permissionLevel,
    };
  }

  // ============================================================================
  // ToolSearch 延迟加载支持 (v0.17+)
  // ============================================================================

  /**
   * 获取核心工具定义（始终发送给模型）
   *
   * 核心工具是最常用的基础工具，始终包含在模型请求中。
   * 其他工具需要通过 tool_search 发现和加载。
   *
   * @param generationId - 代际 ID
   * @returns 核心工具定义数组
   */
  getCoreToolDefinitions(_generationId?: string): ToolDefinition[] {
    const cloudToolMeta = getCloudConfigService().getAllToolMeta();

    return this.getAllTools()
      .filter(tool => CORE_TOOLS.includes(tool.name) || tool.isCore === true)
      .map(tool => {
        const cloudMeta = cloudToolMeta[tool.name];
        const description = cloudMeta?.description || tool.dynamicDescription?.() || tool.description;

        return {
          name: tool.name,
          description,
          inputSchema: tool.inputSchema,
          requiresPermission: tool.requiresPermission,
          permissionLevel: tool.permissionLevel,
        };
      });
  }

  /**
   * 获取延迟工具定义
   *
   * 延迟工具不会默认发送给模型，需要通过 tool_search 加载后才可用。
   *
   * @param generationId - 代际 ID
   * @returns 延迟工具定义数组
   */
  getDeferredToolDefinitions(_generationId?: string): ToolDefinition[] {
    const cloudToolMeta = getCloudConfigService().getAllToolMeta();

    return this.getAllTools()
      .filter(tool => !CORE_TOOLS.includes(tool.name) && tool.isCore !== true)
      .map(tool => {
        const cloudMeta = cloudToolMeta[tool.name];
        const description = cloudMeta?.description || tool.description;

        return {
          name: tool.name,
          description,
          inputSchema: tool.inputSchema,
          requiresPermission: tool.requiresPermission,
          permissionLevel: tool.permissionLevel,
        };
      });
  }

  /**
   * 获取已加载的延迟工具定义
   *
   * 只返回已通过 tool_search 加载的延迟工具。
   *
   * @param generationId - 代际 ID
   * @returns 已加载的延迟工具定义数组
   */
  getLoadedDeferredToolDefinitions(_generationId?: string): ToolDefinition[] {
    const toolSearchService = getToolSearchService();
    const loadedNames = toolSearchService.getLoadedDeferredTools();
    const cloudToolMeta = getCloudConfigService().getAllToolMeta();

    return loadedNames
      .map(name => this.get(name))
      .filter((tool): tool is Tool =>
        tool !== undefined // gen8 locked: no generation filtering
      )
      .map(tool => {
        const cloudMeta = cloudToolMeta[tool.name];
        const description = cloudMeta?.description || tool.dynamicDescription?.() || tool.description;

        return {
          name: tool.name,
          description,
          inputSchema: tool.inputSchema,
          requiresPermission: tool.requiresPermission,
          permissionLevel: tool.permissionLevel,
        };
      });
  }

  /**
   * 获取延迟工具摘要（用于 system prompt 提示）
   *
   * 返回延迟工具名称列表，提示模型可通过 tool_search 发现这些工具。
   *
   * @param generationId - 代际 ID
   * @returns 延迟工具名称列表字符串
   */
  getDeferredToolsSummary(_generationId?: string): string {
    const deferred = this.getDeferredToolDefinitions();
    return deferred.map(t => t.name).join('\n');
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
