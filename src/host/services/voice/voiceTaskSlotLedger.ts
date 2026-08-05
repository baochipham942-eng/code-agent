export {
  SessionTaskConcurrencyPool as VoiceTaskConcurrencyPool,
  SessionTaskSlotLedger as VoiceTaskSlotLedger,
  getSessionTaskConcurrencyPool as getVoiceTaskConcurrencyPool,
  resetSessionTaskConcurrencyPoolForTest as resetVoiceTaskConcurrencyPoolForTest,
} from '../commandCenter/sessionTaskSlotLedger';

export type {
  SessionTaskAdmission as VoiceTaskAdmission,
  SessionTaskSlot as VoiceTaskSlot,
  SessionTaskSlotInput as VoiceTaskSlotInput,
} from '../commandCenter/sessionTaskSlotLedger';

export type VoiceTaskSlotStatus = SessionTaskSlot['status'];
import type { SessionTaskSlot } from '../commandCenter/sessionTaskSlotLedger';
