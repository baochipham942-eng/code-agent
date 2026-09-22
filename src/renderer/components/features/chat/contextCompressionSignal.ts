import type { ContextCompressionSignalData, Message } from '@shared/contract';
import { generateMessageId } from '@shared/utils/id';

interface ContextCompressionSignalEnvelope {
  __contextCompressionSignal: ContextCompressionSignalData;
}

function encodeContextCompressionSignal(data: ContextCompressionSignalData): string {
  return JSON.stringify({ __contextCompressionSignal: data } satisfies ContextCompressionSignalEnvelope);
}

export function parseContextCompressionSignal(content: string): ContextCompressionSignalData | null {
  try {
    const parsed = JSON.parse(content) as Partial<ContextCompressionSignalEnvelope>;
    const data = parsed?.__contextCompressionSignal;
    if (!data || typeof data !== 'object' || typeof data.signalId !== 'string') return null;
    if (data.surface !== 'conversation' || typeof data.code !== 'string') return null;
    return data as ContextCompressionSignalData;
  } catch {
    return null;
  }
}

export function isContextCompressionSignalContent(content: string): boolean {
  return parseContextCompressionSignal(content) !== null;
}

export function buildContextCompressionSignalMessage(data: ContextCompressionSignalData): Message {
  return {
    id: generateMessageId(),
    role: 'system',
    source: 'system',
    content: encodeContextCompressionSignal(data),
    timestamp: data.timestamp,
  };
}
