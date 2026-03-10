// ============================================================================
// Local Tools - 需要本地 Bridge 执行的工具识别与映射
// ============================================================================
//
// 在 Web 模式下，某些工具需要通过本地 Bridge 服务（localhost:9527）
// 在用户机器上执行，而非在云端 webServer 进程中执行。
//
// ============================================================================

/**
 * 需要本地 Bridge 执行的工具名列表
 * 包含 Code Agent 内部工具名和 Bridge 原生工具名
 */
export const LOCAL_TOOL_NAMES = new Set([
  // Code Agent 内部工具名
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'ListDirectory', 'NotebookEdit', 'ReadClipboard',
  // Bridge 原生工具名
  'file_read', 'file_write', 'file_edit', 'file_glob', 'file_grep',
  'directory_list', 'clipboard_read', 'system_info',
  'shell_exec', 'process_manage', 'file_download', 'open_file',
]);

/**
 * 工具名映射：Code Agent 工具名 → Bridge 工具名
 */
export const TOOL_NAME_MAP: Record<string, string> = {
  'Read': 'file_read',
  'Write': 'file_write',
  'Edit': 'file_edit',
  'Bash': 'shell_exec',
  'Glob': 'file_glob',
  'Grep': 'file_grep',
  'ListDirectory': 'directory_list',
  'ReadClipboard': 'clipboard_read',
  'NotebookEdit': 'notebook_edit',
};

/**
 * 判断工具是否需要本地 Bridge 执行
 */
export function isLocalTool(toolName: string): boolean {
  return LOCAL_TOOL_NAMES.has(toolName);
}

/**
 * 将 Code Agent 工具名映射为 Bridge 工具名
 * 如果没有映射关系，返回原始工具名
 */
export function mapToolName(toolName: string): string {
  return TOOL_NAME_MAP[toolName] || toolName;
}
