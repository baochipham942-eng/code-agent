export interface AgentEventSessionEnvelope {
  sessionId?: string;
  data?: unknown;
}

function getStringField(data: unknown, field: string): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function getAgentEventSessionId(event: AgentEventSessionEnvelope): string | null {
  return event.sessionId || getStringField(event.data, 'sessionId');
}

export function isAgentEventForCurrentSession(
  event: AgentEventSessionEnvelope,
  currentSessionId: string | null,
): boolean {
  const eventSessionId = getAgentEventSessionId(event);
  return Boolean(eventSessionId && currentSessionId && eventSessionId === currentSessionId);
}
