// ============================================================================
// External history tool-use one-liner (N-EXTHISTORY-IMPORT-CHATS-HOST)
// ============================================================================
//
// 批量导入外部会话时，工具调用在信封里降级为一条纯文本行：工具名 + 一行参数。
// 参数按 command / file_path / path / pattern / query / url 的优先级取第一个非空
// 字符串值（Codex 的 arguments 是 JSON 字符串，先解再取），空白折叠、截断到
// TOOL_LINE_ARGUMENT_MAX_LENGTH。取不到参数就只留工具名。工具结果一律不保留，
// 也不产生 tool_call content part——信封消息仍是纯 text。

const TOOL_ARGUMENT_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url'] as const;
const TOOL_LINE_ARGUMENT_MAX_LENGTH = 120;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function readArgumentRecord(args: unknown): Record<string, unknown> | null {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function formatToolUseLine(name: string | undefined, args: unknown): string {
  const toolName = collapseWhitespace(name ?? '');
  if (!toolName) return '';
  const record = readArgumentRecord(args);
  if (record) {
    for (const key of TOOL_ARGUMENT_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        const argument = collapseWhitespace(value).slice(0, TOOL_LINE_ARGUMENT_MAX_LENGTH);
        return argument ? `${toolName} ${argument}` : toolName;
      }
    }
  }
  return toolName;
}
