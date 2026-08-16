import type { VoiceWorkNarration } from '../../../shared/contract/voice';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceSession');

export interface NarrationResponseEvidence {
  narrationId: string;
  sourceMessageId?: string;
  terminal: boolean;
}

export type NarrationResponseLedger = Map<string, NarrationResponseEvidence>;

export function recordNarrationResponse(
  ledger: NarrationResponseLedger,
  responseId: string,
  narrationId: string,
  narration: VoiceWorkNarration | undefined,
): void {
  if (narration?.workItemId !== narrationId) return;
  ledger.set(responseId, {
    narrationId,
    ...(narration.sourceMessageId ? { sourceMessageId: narration.sourceMessageId } : {}),
    terminal: narration.status === 'done'
      || narration.status === 'unverified'
      || narration.status === 'failed',
  });
}

export function shouldPersistNarrationTranscript(
  evidence: NarrationResponseEvidence | undefined,
  identity: {
    responseId: string | undefined;
    voiceSessionId: string;
    neoSessionId: string;
    phase?: 'teardown-drain';
  },
): boolean {
  if (!evidence?.terminal) return true;
  if (!evidence.sourceMessageId) {
    logger.warn('terminal narration missing source message identity', {
      responseId: identity.responseId,
      narrationId: evidence.narrationId,
      voiceSessionId: identity.voiceSessionId,
      neoSessionId: identity.neoSessionId,
    });
    return true;
  }
  logger.info('terminal narration transcript suppressed from main message stream', {
    responseId: identity.responseId,
    narrationId: evidence.narrationId,
    messageId: evidence.sourceMessageId,
    voiceSessionId: identity.voiceSessionId,
    neoSessionId: identity.neoSessionId,
    ...(identity.phase ? { phase: identity.phase } : {}),
  });
  return false;
}
