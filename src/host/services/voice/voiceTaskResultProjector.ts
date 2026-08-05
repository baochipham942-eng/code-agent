import type { VoiceWorkFailureMarker, VoiceWorkItem } from '../../../shared/contract/voice';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { describeWorkFailure } from './workFailureDescription';
import { toSpokenSummary } from './voiceNarration';
import { VOICE_CONCLUSION_LOOKBACK_MESSAGES } from '../../../shared/constants/voice';

const logger = createLogger('VoiceTaskResultProjector');

export type VoiceTaskTerminalStatus = 'done' | 'unverified' | 'failed' | 'cancelled';

function projectedStatus(status: VoiceTaskTerminalStatus) {
  switch (status) {
    case 'done': return 'completed' as const;
    case 'unverified': return 'unverified' as const;
    case 'failed': return 'failed' as const;
    case 'cancelled': return 'cancelled' as const;
  }
}

async function readRunConclusion(neoSessionId: string): Promise<string> {
  const session = await getSessionManager().getSession(neoSessionId, VOICE_CONCLUSION_LOOKBACK_MESSAGES);
  const messages = session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.content?.trim()) return message.content;
  }
  return '';
}

async function resolveSummary(
  neoSessionId: string,
  item: VoiceWorkItem,
  status: VoiceTaskTerminalStatus,
  failure?: VoiceWorkFailureMarker,
  conclusion?: string,
): Promise<string> {
  if (status === 'failed') return describeWorkFailure(item.detail, failure).screen;
  if (status === 'cancelled') return toSpokenSummary(item.detail ?? '') || '任务已取消。';
  const projectedConclusion = toSpokenSummary(conclusion ?? await readRunConclusion(neoSessionId));
  if (projectedConclusion) return projectedConclusion;
  return status === 'done' ? '任务已完成。' : '任务已结束，但结果尚未核验。';
}

/**
 * 把任务终态投影成一条自包含的会话记录。系统消息正文供模型读，结构化 metadata
 * 供 UI / 指代消解稳定消费；两者都只写一次，不靠后续 turn 从人话反解任务身份。
 */
export async function projectVoiceTaskTerminalResult(
  neoSessionId: string,
  item: VoiceWorkItem,
  status: VoiceTaskTerminalStatus,
  failure?: VoiceWorkFailureMarker,
  conclusion?: string,
): Promise<void> {
  try {
    const summary = await resolveSummary(neoSessionId, item, status, failure, conclusion);
    const resultStatus = projectedStatus(status);
    await getSessionManager().addMessageToSession(neoSessionId, {
      id: `voice-task-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      content: `[任务结果] ${item.title}｜${resultStatus}｜${summary}`,
      timestamp: Date.now(),
      metadata: {
        source: 'voice',
        backgroundTaskResult: {
          source: 'agent-result',
          taskId: item.id,
          shortName: item.shortName ?? item.title,
          status: resultStatus,
          summary,
        },
        ...(status === 'done' || status === 'unverified'
          ? { voiceWorkSettled: { workItemId: item.id, title: item.title, outcome: status } }
          : {}),
      },
    });
  } catch (error) {
    logger.warn('failed to project voice task terminal result', {
      taskId: item.id,
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}
