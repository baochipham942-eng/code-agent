/** Export only the mobile projection, never raw tool arguments or diagnostics. */
export function projectCompanionEvent(kind: string, value: unknown): Record<string, unknown> | null {
  if (kind === 'run_started' || kind === 'agent_complete' || kind === 'agent_cancelled') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  switch (kind) {
    case 'message':
      if (!['user', 'assistant'].includes(String(event.role)) || typeof event.id !== 'string' || typeof event.content !== 'string' || event.isMeta === true) return null;
      return { id: event.id, role: event.role, content: event.content };
    case 'message_delta':
      if (event.path !== 'content' || event.role !== 'assistant' || typeof event.text !== 'string' || !['append', 'replace'].includes(String(event.op))) return null;
      return { role: 'assistant', path: 'content', op: event.op, text: event.text,
        ...(typeof event.messageId === 'string' ? { messageId: event.messageId } : {}),
        ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
      };
    case 'message_snapshot':
      if (typeof event.content !== 'string') return null;
      return { role: 'assistant', content: event.content,
        ...(typeof event.messageId === 'string' ? { messageId: event.messageId } : {}),
        ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
      };
    case 'tool_call_start':
      return typeof event.id === 'string' && typeof event.name === 'string' ? { id: event.id, name: event.name } : null;
    case 'tool_call_end':
      return typeof event.toolCallId === 'string' && typeof event.success === 'boolean' ? { toolCallId: event.toolCallId, success: event.success } : null;
    case 'error': return { code: 'RUN_FAILED' };
    default: return null;
  }
}
