import type { AgentPointerEvent } from '../contract/desktop';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isAgentPointerEventLike(value: unknown): value is AgentPointerEvent {
  if (!isRecord(value)) return false;
  const point = isRecord(value.point) ? value.point : null;
  return typeof value.id === 'string'
    && (value.surface === 'browser' || value.surface === 'computer')
    && typeof value.tone === 'string'
    && typeof value.phase === 'string'
    && typeof value.coordSpace === 'string'
    && (
      value.point == null
      || (
        point !== null
        && typeof point.x === 'number'
        && typeof point.y === 'number'
        && (point.unit === 'px' || point.unit === 'percent')
      )
    );
}

export function extractAgentPointerEvent(value: unknown): AgentPointerEvent | null {
  if (isAgentPointerEventLike(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }

  const direct = isAgentPointerEventLike(value.agentPointerEvent)
    ? value.agentPointerEvent
    : null;
  if (direct) return direct;

  const timelineEvent = Array.isArray(value.agentPointerTimeline)
    ? value.agentPointerTimeline.find(isAgentPointerEventLike) || null
    : null;
  if (timelineEvent) return timelineEvent;

  const proof = isRecord(value.browserComputerProof) && isAgentPointerEventLike(value.browserComputerProof.agentPointerEvent)
    ? value.browserComputerProof.agentPointerEvent
    : null;
  if (proof) return proof;

  const trace = isRecord(value.workbenchTrace) && isAgentPointerEventLike(value.workbenchTrace.agentPointerEvent)
    ? value.workbenchTrace.agentPointerEvent
    : null;
  if (trace) return trace;

  const metadata = isRecord(value.metadata)
    ? extractAgentPointerEvent(value.metadata)
    : null;
  if (metadata) return metadata;

  const result = isRecord(value.result)
    ? extractAgentPointerEvent(value.result)
    : null;
  if (result) return result;

  const output = isRecord(value.output)
    ? extractAgentPointerEvent(value.output)
    : null;
  if (output) return output;

  const toolExecution = isRecord(value.toolExecution)
    ? extractAgentPointerEvent(value.toolExecution)
    : null;
  return toolExecution;
}

export function buildAgentPointerTimeline(value: unknown): AgentPointerEvent[] {
  if (!isRecord(value)) {
    const event = extractAgentPointerEvent(value);
    return event ? [event] : [];
  }

  const timeline = Array.isArray(value.agentPointerTimeline)
    ? value.agentPointerTimeline.filter(isAgentPointerEventLike)
    : [];
  const nested = [
    ...buildAgentPointerTimeline(value.metadata),
    ...buildAgentPointerTimeline(value.result),
    ...buildAgentPointerTimeline(value.output),
    ...buildAgentPointerTimeline(value.toolExecution),
  ];
  const event = extractAgentPointerEvent(value);
  const events = [...timeline, ...nested];
  if (event) {
    events.push(event);
  }
  const seen = new Set<string>();
  return events.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
