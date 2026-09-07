import type { Message, MessageMetadata } from '../../shared/contract';
import { getActiveRunTraceContext } from '../telemetry/runTraceContext';

function resolvedTurnId(explicit?: string | null): string | undefined {
  const fromExplicit = explicit?.trim();
  if (fromExplicit) return fromExplicit;
  const fromActive = getActiveRunTraceContext()?.turnId?.trim();
  return fromActive || undefined;
}

function resolvedTraceId(explicit?: string): string | undefined {
  const fromExplicit = explicit?.trim();
  if (fromExplicit) return fromExplicit;
  const fromActive = getActiveRunTraceContext()?.traceId?.trim();
  return fromActive || undefined;
}

/**
 * Fill MessageMetadata.correlation.turnId from an explicit turn id or the
 * active run-trace ALS. Does not invent a key when neither is present.
 */
export function attachAssistantCorrelation(
  metadata: MessageMetadata | undefined,
  extras?: { turnId?: string | null; traceId?: string },
): MessageMetadata | undefined {
  if (metadata?.correlation?.turnId) return metadata;
  const turnId = resolvedTurnId(extras?.turnId);
  if (!turnId) return metadata;
  const traceId = resolvedTraceId(extras?.traceId);
  return {
    ...metadata,
    correlation: {
      ...metadata?.correlation,
      turnId,
      ...(traceId ? { traceId } : {}),
    },
  };
}

export function withTurnCorrelation(
  metadata: MessageMetadata | undefined,
  turnId: string,
): MessageMetadata {
  return attachAssistantCorrelation(metadata, { turnId }) ?? { correlation: { turnId } };
}

export function stampAssistantMessageCorrelation(
  message: Message,
  extras?: { turnId?: string | null; traceId?: string },
): Message {
  if (message.role !== 'assistant') return message;
  const metadata = attachAssistantCorrelation(message.metadata, extras);
  if (metadata !== message.metadata) {
    message.metadata = metadata;
  }
  return message;
}
