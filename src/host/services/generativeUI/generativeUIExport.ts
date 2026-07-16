import type { Message } from '../../../shared/contract/message';
import type { NeoUIExportSnapshotV1, NeoUIInstanceV1 } from '../../../shared/contract/generativeUI';
import { guardSensitiveText, guardSensitiveValue } from '../../security/sensitiveDataGuard';

const exportGuard = { surface: 'export' as const, mode: 'share' as const };

export function toGenerativeUIExportSnapshot(instance: NeoUIInstanceV1): NeoUIExportSnapshotV1 {
  return {
    schemaVersion: 1,
    sourceMessageId: instance.sourceMessageId,
    sourceOrdinal: instance.sourceOrdinal,
    specHash: instance.specHash,
    spec: guardSensitiveValue(instance.spec, exportGuard),
    state: guardSensitiveValue(instance.state, exportGuard),
    stateRevision: instance.stateRevision,
    status: instance.status,
    updatedAt: instance.updatedAt,
  };
}

function summarizeState(state: Record<string, unknown>): string | null {
  const values = Object.entries(state)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 8)
    .map(([key, value]) => `${key}: ${String(value)}`);
  if (values.length === 0) return null;
  return guardSensitiveText(values.join(' · '), { ...exportGuard, maxLength: 1_000 });
}

export function materializeGenerativeUIFallbacks(
  messages: Message[],
  instances: NeoUIInstanceV1[],
): Message[] {
  const instancesByMessage = new Map<string, Map<number, NeoUIInstanceV1>>();
  for (const instance of instances) {
    const byOrdinal = instancesByMessage.get(instance.sourceMessageId) ?? new Map<number, NeoUIInstanceV1>();
    byOrdinal.set(instance.sourceOrdinal, instance);
    instancesByMessage.set(instance.sourceMessageId, byOrdinal);
  }

  return messages.map((message) => {
    const byOrdinal = instancesByMessage.get(message.id);
    if (!byOrdinal || !message.content.includes('```neo_ui')) return message;
    let ordinal = 0;
    const content = message.content.replace(/```neo_ui\s*\n([\s\S]*?)```/g, (_block, raw: string) => {
      const instance = byOrdinal.get(ordinal++);
      const fallback = instance?.spec.fallback
        ?? (() => {
          try {
            const parsed = JSON.parse(raw) as { fallback?: unknown };
            return typeof parsed.fallback === 'string' ? parsed.fallback : 'Interactive content is unavailable.';
          } catch {
            return 'Interactive content is unavailable.';
          }
        })();
      const summary = instance ? summarizeState(instance.state) : null;
      return summary
        ? `${guardSensitiveText(fallback, exportGuard)}\n\n> 当前交互状态：${summary}`
        : guardSensitiveText(fallback, exportGuard);
    });
    return { ...message, content };
  });
}
