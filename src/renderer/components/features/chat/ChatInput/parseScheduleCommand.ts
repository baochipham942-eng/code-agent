// ============================================================================
// /schedule 斜杠命令解析
//   /schedule <自然语言描述>
//
// 解析很薄：只剥掉命令前缀，取出整段自然语言描述。真正的「自然语言 → cron 配置」
// 由后端 cron:generateFromPrompt（LLM）完成。空描述交由 submit 层提示用法。
// ============================================================================

export interface ParsedScheduleCommand {
  /** 自然语言任务描述，原样送给 cron:generateFromPrompt。 */
  description: string;
}

/** 是否是 /schedule 命令（用于 handleSubmit 提前拦截判断）。 */
export function isScheduleCommand(raw: string): boolean {
  return /^\/schedule\b/.test(raw.trim());
}

/** 解析 /schedule 命令；非 /schedule 返回 null。 */
export function parseScheduleCommand(raw: string): ParsedScheduleCommand | null {
  const trimmed = raw.trim();
  const head = trimmed.match(/^\/schedule\b\s*([\s\S]*)$/);
  if (!head) return null;
  return { description: head[1].trim() };
}
