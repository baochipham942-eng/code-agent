// ============================================================================
// 排队 follow-up 条：Grok 式「#1 正文 … [Send now][edit][cancel]」。
// 纯函数，供渲染与鼠标命中共用。
// ============================================================================

export const QUEUE_ACTIONS = [
  { id: 'send', label: 'Send now' },
  { id: 'edit', label: 'edit' },
  { id: 'cancel', label: 'cancel' },
] as const;

export type QueueActionId = (typeof QUEUE_ACTIONS)[number]['id'];

export function queueActionsSuffix(): string {
  return QUEUE_ACTIONS.map((action) => `[${action.label}]`).join('');
}

/** 1-based 列 → 动作；点在正文区返回 body（点击即编辑） */
export function queueActionAt(clickCol1: number, columns: number): QueueActionId | 'body' {
  const suffix = queueActionsSuffix();
  const start = Math.max(0, columns - suffix.length);
  const offset = clickCol1 - 1 - start;
  if (offset < 0) return 'body';
  let cursor = 0;
  for (const action of QUEUE_ACTIONS) {
    const width = action.label.length + 2;
    if (offset >= cursor && offset < cursor + width) return action.id;
    cursor += width;
  }
  return 'body';
}

export function truncateQueueText(text: string, columns: number): string {
  const suffix = queueActionsSuffix();
  const budget = Math.max(8, columns - suffix.length - 4);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= budget) return oneLine;
  return `${oneLine.slice(0, Math.max(1, budget - 1))}…`;
}
