// ============================================================================
// Tool Registry - Manages available tools
// ============================================================================

import type {
  ToolDefinition,
  JSONSchema,
} from '../../shared/contract';
import type { Tool, ToolContext, ToolExecutionResult, PermissionRequestData } from './types';
export type { Tool, ToolContext, ToolExecutionResult, PermissionRequestData } from './types';
import { getCloudConfigService } from '../services/cloud';
import { toolSearchTool, CORE_TOOLS, DEFERRED_TOOLS_META, getToolSearchService } from './search';

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
import {
  calendarTool,
  calendarCreateEventTool,
  calendarDeleteEventTool,
  calendarUpdateEventTool,
  mailTool,
  mailDraftTool,
  mailSendTool,
  remindersTool,
  remindersCreateTool,
  remindersDeleteTool,
  remindersUpdateTool,
} from './connectors';


// Light Memory tools (File-as-Memory)
import { memoryWriteTool, memoryReadTool } from '../lightMemory';

// Legacy memory tools removed (src/main/tools/memory/ deleted)

// Vision tools
import {
  screenshotTool,
  computerUseTool,
  browserNavigateTool,
  browserActionTool,
  guiAgentTool,
} from './vision';

// Skill tools
import { skillMetaTool, skillCreateTool } from './skill';

// Multi-agent tools
import {
  sdkTaskTool,
  agentSpawnTool,
  AgentMessageTool,
  WorkflowOrchestrateTool,
  TeammateTool,
  // DEPRECATED: spawnAgentTool, agentMessageTool, workflowOrchestrateTool, teammateTool removed — use PascalCase versions
  planReviewTool,
  // Phase 2: Agent lifecycle tools
  WaitAgentTool,
  CloseAgentTool,
  // Phase 3: Agent communication
  SendInputTool,
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
import { ExcelAutomateTool } from './excel';
import { DocEditTool } from './document/docEditTool';
import { PdfAutomateTool } from './network';

// ----------------------------------------------------------------------------
// Tool Interface (re-exported from ./types to avoid circular deps)
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Tool Registry
// ----------------------------------------------------------------------------

/**
 * Tool Registry - 工具注册表
 *
 * 管理所有可用工具的注册、查询和加载。
 *
 * 核心功能：
 * - 工具注册和注销
 * - 云端工具元数据合并
 * - 工具定义导出（供模型调用）
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
    // ── Shell & 文件 ──────────────────────────────
    this.register(bashTool);
    this.register(readFileTool);
    this.register(writeFileTool);
    this.register(editFileTool);
    this.register(killShellTool);
    this.register(taskOutputTool);
    this.register(notebookEditTool);
    this.register(globTool);
    this.register(grepTool);
    this.register(listDirectoryTool);
    this.register(readClipboardTool);

    // ── Git ──────────────────────────────────────
    this.register(gitCommitTool);
    this.register(gitDiffTool);
    this.register(gitWorktreeTool);

    // ── 规划 & 任务 ─────────────────────────────
    this.register(taskTool);
    this.register(askUserQuestionTool);
    this.register(confirmActionTool);
    this.register(planReadTool);
    this.register(planUpdateTool);
    this.register(findingsWriteTool);
    this.register(enterPlanModeTool);
    this.register(exitPlanModeTool);
    this.register(taskCreateTool);
    this.register(taskGetTool);
    this.register(taskListTool);
    this.register(taskUpdateTool);

    // ── Skills ───────────────────────────────────
    this.register(skillMetaTool);
    this.register(skillCreateTool);

    // ── Web & 搜索 ──────────────────────────────
    this.register(webFetchTool);
    this.register(webSearchTool);
    this.register(readPdfTool);
    this.register(lspTool);
    this.register(diagnosticsTool);

    // ── 文档 & 媒体生成 ─────────────────────────
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

    // ── 外部服务连接器 ──────────────────────────
    this.register(jiraTool);
    this.register(githubPrTool);
    this.register(calendarTool);
    this.register(calendarCreateEventTool);
    this.register(calendarDeleteEventTool);
    this.register(calendarUpdateEventTool);
    this.register(mailTool);
    this.register(mailDraftTool);
    this.register(mailSendTool);
    this.register(remindersTool);
    this.register(remindersCreateTool);
    this.register(remindersDeleteTool);
    this.register(remindersUpdateTool);

    // ── 记忆 ────────────────────────────────────
    this.register(memoryWriteTool);
    this.register(memoryReadTool);

    // ── 视觉 & 浏览器 ──────────────────────────
    this.register(screenshotTool);
    this.register(computerUseTool);
    this.register(browserNavigateTool);
    this.register(browserActionTool);
    this.register(guiAgentTool);

    // ── 多 Agent ────────────────────────────────
    this.register(sdkTaskTool);
    this.register(agentSpawnTool);
    this.register(AgentMessageTool);
    this.register(WorkflowOrchestrateTool);
    this.register(TeammateTool);
    this.register(planReviewTool);
    this.register(WaitAgentTool);
    this.register(CloseAgentTool);
    this.register(SendInputTool);


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
    this.register(ExcelAutomateTool);
    this.register(DocEditTool);
    this.register(PdfAutomateTool);

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
   * 获取指定名称的工具
   *
   * @param name - 工具名称（PascalCase）
   * @returns Tool 实例，如果不存在则返回 undefined
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * @deprecated TOOL_ALIASES removed — returns undefined for all inputs
   */
  getDefaultParamsForAlias(_name: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * 获取所有已注册工具
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取工具定义（供模型调用），自动合并云端工具元数据
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
    const allMeta = [
      ...DEFERRED_TOOLS_META,
    ];

    // 按 tags 分组，便于模型快速定位
    const grouped = new Map<string, string[]>();
    for (const meta of allMeta) {
      const category = meta.tags[0] || 'other';
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category)!.push(`${meta.name}: ${meta.shortDescription}`);
    }

    const lines: string[] = [];
    for (const [category, tools] of grouped) {
      lines.push(`[${category}] ${tools.join(' | ')}`);
    }

    return lines.join('\n');
  }
}

// ============================================================================
// Tool Deny Rules — 工具过滤
// ============================================================================

export interface DenyRule {
  /** Tool name pattern (exact or prefix with *) */
  pattern: string;
  /** Reason for denial */
  reason?: string;
}

/** Global deny rules (populated from config or policy) */
const denyRules: DenyRule[] = [];

/**
 * Add a deny rule. Tools matching the pattern will be excluded.
 * Pattern supports exact match or prefix glob: "mcp__slack__*"
 */
export function addDenyRule(rule: DenyRule): void {
  denyRules.push(rule);
}

/**
 * Clear all deny rules.
 */
export function clearDenyRules(): void {
  denyRules.length = 0;
}

/**
 * Check if a tool name is denied by any rule.
 */
export function isToolDenied(toolName: string): boolean {
  return denyRules.some(rule => matchesDenyPattern(rule.pattern, toolName));
}

/**
 * Filter tool definitions by deny rules.
 * Removes tools matching any deny pattern before sending to the model.
 */
export function filterToolsByDenyRules(tools: ToolDefinition[]): ToolDefinition[] {
  if (denyRules.length === 0) return tools;
  return tools.filter(t => !isToolDenied(t.name));
}

function matchesDenyPattern(pattern: string, toolName: string): boolean {
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return pattern === toolName;
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
