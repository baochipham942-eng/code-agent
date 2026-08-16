import type { WebSocket as WsSocket } from 'ws';
import { VOICE_FALSE_INTERRUPTION_TIMEOUT_MS } from '../../../shared/constants/voice';
import type { VoiceEvent } from '../../../shared/contract/voice';
import { createLogger } from '../infra/logger';
import type { VoiceInterruptCandidate } from './voiceInterruptCandidates';
import {
  handleNarrationPlaybackInterrupted,
  type NarrationSession,
} from './voiceNarrationQueue';

const logger = createLogger('VoiceSession');

interface FalseInterruptionSession extends NarrationSession {
  clientRef: { current: WsSocket };
}

function send(session: FalseInterruptionSession, event: VoiceEvent): void {
  const client = session.clientRef.current;
  if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
}

export function confirmHeldInterrupt(
  session: FalseInterruptionSession,
  candidateId: string,
  candidate: VoiceInterruptCandidate,
  reason: 'final_transcript' | 'continued_speech',
): void {
  if (candidate.falseInterruptionState !== 'held') return;
  if (candidate.falseInterruptionTimer) clearTimeout(candidate.falseInterruptionTimer);
  candidate.falseInterruptionTimer = undefined;
  candidate.falseInterruptionState = 'confirmed';
  if (candidate.cancelledResponseId) {
    send(session, {
      type: 'response.cancelled',
      responseId: candidate.cancelledResponseId,
      reason: 'interrupt',
    });
  }
  send(session, { type: 'interrupt.confirm', candidateId });
  handleNarrationPlaybackInterrupted(session);
  logger.info('voice interrupt delayed discard confirmed', {
    voiceSessionId: session.id,
    candidateId,
    layer: 'false_interruption',
    reason,
  });
}

export function beginFalseInterruptionWindow(
  session: FalseInterruptionSession,
  candidateId: string,
  candidate: VoiceInterruptCandidate,
  isActive: () => boolean,
): void {
  candidate.falseInterruptionState = 'held';
  candidate.falseInterruptionTimer = setTimeout(() => {
    if (!isActive() || candidate.falseInterruptionState !== 'held') return;
    candidate.falseInterruptionTimer = undefined;
    candidate.falseInterruptionState = 'revoked';
    send(session, { type: 'interrupt.revoke', candidateId });
    logger.info('voice interrupt delayed discard revoked', {
      voiceSessionId: session.id,
      candidateId,
      layer: 'false_interruption',
      reason: 'silence_timeout',
      timeoutMs: VOICE_FALSE_INTERRUPTION_TIMEOUT_MS,
    });
  }, VOICE_FALSE_INTERRUPTION_TIMEOUT_MS);
}

export function clearFalseInterruptionWindow(candidate: VoiceInterruptCandidate): void {
  if (candidate.falseInterruptionTimer) clearTimeout(candidate.falseInterruptionTimer);
}
