import type { VoiceEvent, VoiceWorkItem } from '../../../shared/contract/voice';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { describeWorkFailure } from './workFailureDescription';

const logger = createLogger('VoiceWorkFailureReporter');

export async function reportVoiceWorkFailure(input: {
  neoSessionId: string;
  voiceSessionId: string;
  item: VoiceWorkItem;
  stillOnThisCall: boolean;
  emitNotice: (event: Extract<VoiceEvent, { type: 'notice' }>) => void;
}): Promise<void> {
  const failure = describeWorkFailure(input.item.detail, input.item.failure);
  logger.warn('voice work item failed', {
    voiceSessionId: input.voiceSessionId,
    title: input.item.title,
    detail: failure.detail,
    stillOnThisCall: input.stillOnThisCall,
  });

  if (input.stillOnThisCall) {
    input.emitNotice({
      type: 'notice',
      code: 'VOICE_WORK_FAILED',
      message: failure.screen,
      ...(failure.detail ? { detail: failure.detail } : {}),
    });
  }

  try {
    await getSessionManager().addMessageToSession(input.neoSessionId, {
      id: `voice-work-failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      content: `语音派出的任务「${input.item.title}」${failure.screen}`,
      timestamp: Date.now(),
      metadata: {
        source: 'voice',
        voiceWorkFailure: {
          workItemId: input.item.id,
          title: input.item.title,
          ...(failure.detail ? { detail: failure.detail } : {}),
        },
      },
    });
  } catch (error) {
    logger.warn('failed to persist work failure', {
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}
