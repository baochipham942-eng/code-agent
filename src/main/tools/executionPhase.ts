// ============================================================================
// Execution Phase Classifier
//
// Classifies tool calls into behavioral phases to track agent behavior patterns.
// Inspired by Claude Code's phase tracking (explore / edit / execute / other).
// The ExecutionPhase type is authoritative in protocol/tools.ts; re-exported
// here for backward-compatible consumers.
// ============================================================================

import type { ExecutionPhase } from '../protocol/tools';
export type { ExecutionPhase };

// ---------------------------------------------------------------------------
// Classification sets (kept as const sets for O(1) lookup)
// ---------------------------------------------------------------------------

const EXPLORE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'web_fetch',
  'ToolSearch',
  'list_directory',
  'read_pdf',
  'read_docx',
  'read_xlsx',
  'ReadDocument',
  'read_clipboard',
  'lsp',
  'diagnostics',
  'code_index',
  'academic_search',
  'image_analyze',
  'youtube_transcript',
  'twitter_fetch',
  'screenshot',
  'screenshot_page',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_get_status',
  'MCPUnified',
  'process_list',
  'process_poll',
  'process_log',
  'Process',
  'plan_read',
  'query_metrics',
  'TaskGet',
  'TaskList',
  'TaskManager',
  'task_output',
]);

const EDIT_TOOLS = new Set([
  'Write',
  'Edit',
  'notebook_edit',
  'findings_write',
  // 'todo_write', // 已移除
  'plan_update',
  'Plan',
  'memory',
]);

const EXECUTE_TOOLS = new Set([
  'Bash',
  'task',
  'code_execute',
  'skill',
  'http_request',
  'WebFetch',
  'computer_use',
  'Computer',
  'browser_navigate',
  'browser_action',
  'Browser',
  'gui_agent',
  'kill_shell',
  'process_write',
  'process_submit',
  'process_kill',
  'ppt_generate',
  'image_generate',
  'video_generate',
  'docx_generate',
  'excel_generate',
  'chart_generate',
  'qrcode_generate',
  'pdf_generate',
  'pdf_compress',
  'image_process',
  'image_annotate',
  'mermaid_export',
  'speech_to_text',
  'local_speech_to_text',
  'text_to_speech',
  'xlwings_execute',
  'jira',
  'github_pr',
  'AgentSpawn',
  'AgentMessage',
  'WorkflowOrchestrate',
  'Teammate',
  'TaskCreate',
  'TaskUpdate',
  'sdkTask',
  'mcp_add_server',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a tool name into an execution phase.
 *
 * MCP tools (prefixed with `mcp_`) that are not in the explicit sets are
 * classified heuristically: read/list/get → explore, write/create/update → execute,
 * otherwise → other.
 */
export function classifyExecutionPhase(toolName: string): ExecutionPhase {
  if (EXPLORE_TOOLS.has(toolName)) return 'explore';
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (EXECUTE_TOOLS.has(toolName)) return 'execute';

  // Heuristic for MCP tools not explicitly listed
  // For mcp__provider__action_name tools, extract the last segment so that
  // word-boundary regex can match verbs like "create" in "create_issue".
  if (toolName.startsWith('mcp_') || toolName.startsWith('mcp__')) {
    const segments = toolName.split('__');
    const lastSegment = segments[segments.length - 1].toLowerCase();
    if (/\b(read|list|get|search|query|fetch|find|show|describe)\b/.test(lastSegment)) return 'explore';
    if (/\b(write|create|update|delete|send|post|put|patch|execute|run)\b/.test(lastSegment)) return 'execute';
  }

  // Evolution tools
  if (['strategy_optimize', 'tool_create', 'self_evaluate', 'learn_pattern'].includes(toolName)) {
    return 'execute';
  }

  // Planning / interaction tools → other
  // confirm_action, enter_plan_mode, exit_plan_mode, AskUserQuestion, fork_session, auto_learn, plan_review
  return 'other';
}
