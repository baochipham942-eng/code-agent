const TOOL_TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'agentId'] as const;
const COMMAND_PREVIEW_LENGTH = 80;

export function extractToolStepTarget(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  for (const key of TOOL_TARGET_KEYS) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized) continue;
    return key === 'command'
      ? Array.from(normalized).slice(0, COMMAND_PREVIEW_LENGTH).join('')
      : normalized;
  }
  return undefined;
}
