// ============================================================================
// Tool Registry - Manages available tools
// ============================================================================

import type {
  ToolDefinition,
  JSONSchema,
} from '../../shared/types';
import type { Tool, ToolContext, ToolExecutionResult, PermissionRequestData } from './types';
export type { Tool, ToolContext, ToolExecutionResult, PermissionRequestData } from './types';
import { getCloudConfigService } from '../services/cloud';
import { toolSearchTool, CORE_TOOLS, getToolSearchService } from './search';

// Import tool definitions - organized by function

// Shell tools
import {
  bashTool,
  grepTool,
  killShellTool,
  taskOutputTool,
  gitCommitTool,
  gitDiffTool,
  gitWorktreeTool,
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
  // todoWriteTool, // 已移除：改为 agentLoop 自动解析任务列表
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
  speechToTextTool,
  localSpeechToTextTool,
  textToSpeechTool,
  imageAnnotateTool,
  xlwingsExecuteTool,
} from './network';


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
// Tool Interface (re-exported from ./types to avoid circular deps)
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Tool Aliases - Maps legacy snake_case names to PascalCase
// ----------------------------------------------------------------------------

/**
 * Default action params for aliases that map to unified tools requiring an `action` field.
 * Without these, calling legacy names like `plan_read` would hit "Unknown action" errors.
 */
const ALIAS_DEFAULT_PARAMS: Record<string, Record<string, unknown>> = {
  // Process unified tool
  process_list:   { action: 'list' },
  process_poll:   { action: 'poll' },
  process_log:    { action: 'log' },
  process_write:  { action: 'write' },
  process_submit: { action: 'submit' },
  process_kill:   { action: 'kill' },
  kill_shell:     { action: 'kill' },
  task_output:    { action: 'poll' },

  // MCPUnified tool
  mcp_list_tools:     { action: 'list_tools' },
  mcp_list_resources: { action: 'list_resources' },
  mcp_read_resource:  { action: 'read_resource' },
  mcp_get_status:     { action: 'get_status' },
  mcp_add_server:     { action: 'add_server' },

  // TaskManager unified tool
  task_create: { action: 'create' },
  TaskCreate:  { action: 'create' },
  task_get:    { action: 'get' },
  TaskGet:     { action: 'get' },
  task_list:   { action: 'list' },
  TaskList:    { action: 'list' },
  task_update: { action: 'update' },
  TaskUpdate:  { action: 'update' },

  // Plan tool
  plan_read:   { action: 'read' },
  plan_update: { action: 'update' },

  // PlanMode tool
  enter_plan_mode: { action: 'enter' },
  exit_plan_mode:  { action: 'exit' },

  // Browser unified tool
  browser_navigate: { action: 'navigate' },
  browser_action:   { action: 'action' },

  // Computer unified tool
  screenshot:   { action: 'screenshot' },
  computer_use: { action: 'use' },

  // ReadDocument unified tool
  read_pdf:  { action: 'read', format: 'pdf' },
  read_docx: { action: 'read', format: 'docx' },
  read_xlsx: { action: 'read', format: 'xlsx' },
};

const TOOL_ALIASES: Record<string, string> = {
  // Phase 1: Core tool aliases (snake_case → PascalCase)
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit_file: 'Edit',
  bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  ask_user_question: 'AskUserQuestion',

  // Phase 1 continued: remaining snake_case → PascalCase
  list_directory: 'ListDirectory',
  // todo_write: 'TodoWrite', // 已移除
  tool_search: 'ToolSearch',
  skill: 'Skill',

  // Multi-agent aliases
  spawn_agent: 'AgentSpawn',
  agent_message: 'AgentMessage',
  workflow_orchestrate: 'WorkflowOrchestrate',
  teammate: 'Teammate',

  // Memory aliases
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
 * const tools = registry.getAll();
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

    // Git tools (CodePilot parity)
    this.register(gitCommitTool);
    this.register(gitDiffTool);
    this.register(gitWorktreeTool);

    // Gen 2 tools
    this.register(globTool);
    this.register(grepTool);
    this.register(listDirectoryTool);

    // Gen 3 tools
    this.register(taskTool);
    // this.register(todoWriteTool); // 已移除：改为 agentLoop 自动解析任务列表
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
   * Get default params that should be injected when a legacy alias is used.
   * This ensures unified tools receive the required `action` parameter
   * even when called via their old snake_case names.
   */
  getDefaultParamsForAlias(name: string): Record<string, unknown> | undefined {
    return ALIAS_DEFAULT_PARAMS[name];
  }

  /**
   * 获取指定代际可用的所有工具
   *
   * @returns 该代际可用的工具数组
   */
  
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取指定代际的工具定义（供模型调用）
   *
   * 会自动合并云端工具元数据（如描述）
   *
   * @returns 工具定义数组
   */
  getToolDefinitions(): ToolDefinition[] {
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
   * @returns 核心工具定义数组
   */
  getCoreToolDefinitions(): ToolDefinition[] {
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
   * @returns 延迟工具定义数组
   */
  getDeferredToolDefinitions(): ToolDefinition[] {
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
   * @returns 已加载的延迟工具定义数组
   */
  getLoadedDeferredToolDefinitions(): ToolDefinition[] {
    const toolSearchService = getToolSearchService();
    const loadedNames = toolSearchService.getLoadedDeferredTools();
    const cloudToolMeta = getCloudConfigService().getAllToolMeta();

    return loadedNames
      .map(name => this.get(name))
      .filter((tool): tool is Tool => tool !== undefined)
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
   * @returns 延迟工具名称列表字符串
   */
  getDeferredToolsSummary(): string {
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
