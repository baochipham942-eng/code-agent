import type { VoiceWorkFailureMarker, VoiceWorkItem } from '../../../shared/contract/voice';
import { formatSessionTaskSlotRecoveryDetail } from '../../../shared/i18n/sessionTaskSlot';
import type { SessionTaskSlotRecovery } from '../commandCenter/sessionTaskSlotLedger';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceTaskSlotRecovery');
const TERMINAL = new Set(['done', 'unverified', 'failed', 'cancelled']);

export function recoverVoiceTaskSlots(input: {
  recovery: SessionTaskSlotRecovery;
  items: ReadonlyMap<string, VoiceWorkItem>;
  fail: (workItemId: string, detail: string, marker: VoiceWorkFailureMarker) => void;
  start: (workItemId: string) => void;
}): void {
  let locale: 'zh' | 'en' = 'zh';
  try {
    locale = getConfigService().getSettings().ui.language;
  } catch (error) {
    logger.warn('voice task slot recovery could not read UI locale; using Chinese fallback', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    for (const { slot, occupiedMs } of input.recovery.expired) {
      const item = input.items.get(slot.workItemId);
      if (!item || TERMINAL.has(item.status)) continue;
      input.fail(slot.workItemId, formatSessionTaskSlotRecoveryDetail({
        taskLabel: item.shortName ?? item.title,
        laneKey: slot.laneKey,
        occupiedMs,
        locale,
      }), {
        code: 'TASK_SLOT_TIMEOUT',
        laneKey: slot.laneKey,
        occupiedMs,
        locale,
        reason: input.recovery.reason,
      });
    }
  } finally {
    input.recovery.startable.forEach((slot) => input.start(slot.workItemId));
  }
}
