import type { VoiceWorkItem } from '../../../shared/contract/voice';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceWorkItemState');

export function upsertVoiceWorkItem(
  state: { items: Map<string, VoiceWorkItem>; emit: ((item: VoiceWorkItem) => void) | null },
  item: VoiceWorkItem,
): void {
  state.items.set(item.id, item);
  try {
    state.emit?.(item);
  } catch (error) {
    logger.warn('voice work item emit failed', {
      workItemId: item.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
