import type { VoiceCallFailureCode, VoiceCallFailurePhase, VoiceEvent } from '../../../shared/contract/voice';
import type { SystemEventMessageMetadata } from '../../../shared/contract/systemEventRegistry';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { recordVoiceCallFailure } from './voiceUsageLedger';

const logger = createLogger('VoiceFailure');
const failedVoiceSessionIds = new Set<string>();

export interface PersistVoiceCallFailureInput {
  neoSessionId: string;
  code: VoiceCallFailureCode;
  phase: VoiceCallFailurePhase;
  voiceSessionId?: string;
  timestamp?: number;
}

function failureContent(phase: VoiceCallFailurePhase): string {
  return phase === 'upstream'
    ? '我没能继续这次语音通话'
    : '我没能接通这次语音通话';
}

/**
 * host 侧唯一失败出口：消息流与失败分母互不依赖，任一写入失败都不阻断错误呈现。
 * 只保存 code/阶段/身份/时间，不保存音频、字幕或上游 detail。
 */
export async function persistVoiceCallFailure(input: PersistVoiceCallFailureInput): Promise<void> {
  if (input.voiceSessionId && input.phase === 'upstream') {
    if (failedVoiceSessionIds.has(input.voiceSessionId)) return;
    failedVoiceSessionIds.add(input.voiceSessionId);
  }
  const timestamp = input.timestamp ?? Date.now();
  recordVoiceCallFailure(timestamp);
  try {
    await getSessionManager().addMessageToSession(input.neoSessionId, {
      id: `voice-call-failed-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      content: failureContent(input.phase),
      timestamp,
      metadata: {
        source: 'voice',
        voiceCallFailure: {
          code: input.code,
          phase: input.phase,
          timestamp,
          neoSessionId: input.neoSessionId,
          ...(input.voiceSessionId ? { voiceSessionId: input.voiceSessionId } : {}),
        },
      } satisfies SystemEventMessageMetadata,
    });
  } catch (err) {
    logger.warn('failed to persist call failure', {
      code: input.code,
      message: err instanceof Error ? err.message : 'unknown',
    });
  }
}

export function observeVoiceEventFailure(
  event: VoiceEvent,
  neoSessionId: string,
  voiceSessionId: string,
): void {
  if (event.type !== 'error' || (event.code !== 'UPSTREAM_SOCKET' && event.code !== 'UPSTREAM_ERROR')) return;
  void persistVoiceCallFailure({ neoSessionId, voiceSessionId, code: event.code, phase: 'upstream' });
}

/** teardown 原子消费失败标记，避免同一尝试同时进入 calls 与 failedAttempts。 */
export function consumeVoiceCallFailure(voiceSessionId: string): boolean {
  return failedVoiceSessionIds.delete(voiceSessionId);
}
