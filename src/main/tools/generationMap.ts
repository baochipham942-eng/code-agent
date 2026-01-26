// ============================================================================
// Generation Map - 代际 → 工具映射配置
// ============================================================================

import type { GenerationId } from '../../shared/types';

/**
 * 各代际可用的工具列表
 * - 每一代包含前一代的所有工具
 * - 工具名称使用下划线命名法（与 Claude API 保持一致）
 *
 * @remarks
 * 此文件需要与 toolRegistry.ts 保持同步。
 * 添加新工具时，需要同时更新两个文件。
 */
export const GENERATION_TOOLS: Record<GenerationId, string[]> = {
  // Gen 1: 基础文件和 Shell 操作
  gen1: [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'kill_shell',
    'task_output',
    'notebook_edit',
  ],

  // Gen 2: 增强搜索能力
  gen2: [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'kill_shell',
    'task_output',
    'notebook_edit',
    'glob',
    'grep',
    'list_directory',
  ],

  // Gen 3: 规划和任务管理
  gen3: [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'kill_shell',
    'task_output',
    'notebook_edit',
    'glob',
    'grep',
    'list_directory',
    'task',
    'todo_write',
    'ask_user_question',
    'confirm_action',
    'read_clipboard',
    'plan_read',
    'plan_update',
    'enter_plan_mode',
    'exit_plan_mode',
    'findings_write',
  ],

  // Gen 4: 网络和 MCP 能力
  gen4: [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'kill_shell',
    'task_output',
    'notebook_edit',
    'glob',
    'grep',
    'list_directory',
    'task',
    'todo_write',
    'ask_user_question',
    'confirm_action',
    'read_clipboard',
    'plan_read',
    'plan_update',
    'enter_plan_mode',
    'exit_plan_mode',
    'findings_write',
    'skill',
    'web_fetch',
    'web_search',
    'read_pdf',
    'http_request',
    'lsp',
    'mcp',
    'mcp_list_tools',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_get_status',
    'mcp_add_server',
  ],

  // Gen 5: 记忆、学习和内容生成
  gen5: [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'kill_shell',
    'task_output',
    'notebook_edit',
    'glob',
    'grep',
    'list_directory',
    'task',
    'todo_write',
    'ask_user_question',
    'confirm_action',
    'read_clipboard',
    'plan_read',
    'plan_update',
    'enter_plan_mode',
    'exit_plan_mode',
    'findings_write',
    'skill',
    'web_fetch',
    'web_search',
    'read_pdf',
    'http_request',
    'lsp',
    'mcp',
    'mcp_list_tools',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_get_status',
    'mcp_add_server',
    // Memory & Learning
    'memory_store',
    'memory_search',
    'code_index',
    'auto_learn',
    'fork_session',
    // Image & Media
    'image_generate',
    'image_analyze',
    'image_annotate',
    'image_process',
    'video_generate',
    'screenshot_page',
    // Document Generation
    'ppt_generate',
    'pdf_generate',
    'docx_generate',
    'excel_generate',
    'chart_generate',
    'mermaid_export',
    'qrcode_generate',
    // Document Reading
    'read_docx',
    'read_xlsx',
    // External Services
    'jira',
    'youtube_transcript',
    'twitter_fetch',
    'academic_search',
    // Speech
    'speech_to_text',
    'text_to_speech',
  ],

  // Gen 6: 视觉和 Computer Use
  gen6: [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'kill_shell',
    'task_output',
    'notebook_edit',
    'glob',
    'grep',
    'list_directory',
    'task',
    'todo_write',
    'ask_user_question',
    'confirm_action',
    'read_clipboard',
    'plan_read',
    'plan_update',
    'enter_plan_mode',
    'exit_plan_mode',
    'findings_write',
    'skill',
    'web_fetch',
    'web_search',
    'read_pdf',
    'http_request',
    'lsp',
    'mcp',
    'mcp_list_tools',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_get_status',
    'mcp_add_server',
    // Memory & Learning
    'memory_store',
    'memory_search',
    'code_index',
    'auto_learn',
    'fork_session',
    // Image & Media
    'image_generate',
    'image_analyze',
    'image_annotate',
    'image_process',
    'video_generate',
    'screenshot_page',
    // Document Generation
    'ppt_generate',
    'pdf_generate',
    'docx_generate',
    'excel_generate',
    'chart_generate',
    'mermaid_export',
    'qrcode_generate',
    // Document Reading
    'read_docx',
    'read_xlsx',
    // External Services
    'jira',
    'youtube_transcript',
    'twitter_fetch',
    'academic_search',
    // Speech
    'speech_to_text',
    'text_to_speech',
    // Computer Use
    'screenshot',
    'computer_use',
    'browser_navigate',
    'browser_action',
  ],

  // Gen 7: 多代理协作
  gen7: [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'kill_shell',
    'task_output',
    'notebook_edit',
    'glob',
    'grep',
    'list_directory',
    'task',
    'todo_write',
    'ask_user_question',
    'confirm_action',
    'read_clipboard',
    'plan_read',
    'plan_update',
    'enter_plan_mode',
    'exit_plan_mode',
    'findings_write',
    'skill',
    'web_fetch',
    'web_search',
    'read_pdf',
    'http_request',
    'lsp',
    'mcp',
    'mcp_list_tools',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_get_status',
    'mcp_add_server',
    // Memory & Learning
    'memory_store',
    'memory_search',
    'code_index',
    'auto_learn',
    'fork_session',
    // Image & Media
    'image_generate',
    'image_analyze',
    'image_annotate',
    'image_process',
    'video_generate',
    'screenshot_page',
    // Document Generation
    'ppt_generate',
    'pdf_generate',
    'docx_generate',
    'excel_generate',
    'chart_generate',
    'mermaid_export',
    'qrcode_generate',
    // Document Reading
    'read_docx',
    'read_xlsx',
    // External Services
    'jira',
    'youtube_transcript',
    'twitter_fetch',
    'academic_search',
    // Speech
    'speech_to_text',
    'text_to_speech',
    // Computer Use
    'screenshot',
    'computer_use',
    'browser_navigate',
    'browser_action',
    // Multi-Agent
    'spawn_agent',
    'agent_message',
    'workflow_orchestrate',
  ],

  // Gen 8: 自我进化
  gen8: [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'kill_shell',
    'task_output',
    'notebook_edit',
    'glob',
    'grep',
    'list_directory',
    'task',
    'todo_write',
    'ask_user_question',
    'confirm_action',
    'read_clipboard',
    'plan_read',
    'plan_update',
    'enter_plan_mode',
    'exit_plan_mode',
    'findings_write',
    'skill',
    'web_fetch',
    'web_search',
    'read_pdf',
    'http_request',
    'lsp',
    'mcp',
    'mcp_list_tools',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_get_status',
    'mcp_add_server',
    // Memory & Learning
    'memory_store',
    'memory_search',
    'code_index',
    'auto_learn',
    'fork_session',
    // Image & Media
    'image_generate',
    'image_analyze',
    'image_annotate',
    'image_process',
    'video_generate',
    'screenshot_page',
    // Document Generation
    'ppt_generate',
    'pdf_generate',
    'docx_generate',
    'excel_generate',
    'chart_generate',
    'mermaid_export',
    'qrcode_generate',
    // Document Reading
    'read_docx',
    'read_xlsx',
    // External Services
    'jira',
    'youtube_transcript',
    'twitter_fetch',
    'academic_search',
    // Speech
    'speech_to_text',
    'text_to_speech',
    // Computer Use
    'screenshot',
    'computer_use',
    'browser_navigate',
    'browser_action',
    // Multi-Agent
    'spawn_agent',
    'agent_message',
    'workflow_orchestrate',
    // Self-Evolution
    'strategy_optimize',
    'tool_create',
    'self_evaluate',
    'learn_pattern',
  ],
};

/**
 * 获取指定代际的工具列表
 */
export function getToolsForGeneration(generationId: GenerationId): string[] {
  return GENERATION_TOOLS[generationId] || [];
}

/**
 * 检查工具是否属于指定代际
 */
export function isToolAvailableForGeneration(
  toolName: string,
  generationId: GenerationId
): boolean {
  const tools = GENERATION_TOOLS[generationId];
  return tools ? tools.includes(toolName) : false;
}
