import type { Message, StreamInterruptionReason, ToolCall } from '@shared/contract';
import type { Translations } from '../i18n';
import { resolveStreamInterruptionOutcomeKey } from '../i18n/outcomeWords';
import {
  getToolFilePath,
  humanizeToolStep,
} from './humanizeToolStep';

const USER_CANCELLED_MARKER = /\[cancelled\]/i;
const SESSION_SWITCH_MARKER = /\[未完成\s*[—-]\s*切换会话中断\]/;
const WRITE_TOOLS = new Set(['Write', 'write_file']);

function isRecoveryMessage(message: Message, turnId?: string): boolean {
  const marker = message.metadata?.streamRecovery;
  return Boolean(marker && (turnId === undefined || marker.turnId === turnId));
}

export function streamInterruptionReasonFromContent(
  content: string | null | undefined,
): StreamInterruptionReason | null {
  if (!content) return null;
  if (USER_CANCELLED_MARKER.test(content)) return 'user';
  if (SESSION_SWITCH_MARKER.test(content)) return 'session-switch';
  return null;
}

export function isPersistedStreamInterruptionMessage(message: Message): boolean {
  return message.role === 'assistant'
    && streamInterruptionReasonFromContent(message.content) !== null;
}

export function deriveStreamInterruptionReason(
  messages: Message[],
  snapshotTurnId?: string,
): StreamInterruptionReason {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecoveryMessage(message, snapshotTurnId)) {
      if (message.metadata?.streamInterruptionReason) {
        return message.metadata.streamInterruptionReason;
      }
      continue;
    }
    if (message.role === 'user') break;
    const reason = streamInterruptionReasonFromContent(message.content);
    if (reason) return reason;
  }
  return 'app-restart';
}

export function getStreamInterruptionReasonLabel(
  reason: StreamInterruptionReason,
  t: Translations,
): string {
  return t.outcomeWords[resolveStreamInterruptionOutcomeKey(reason)].timeline.reason;
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export function humanizeInterruptedToolAction(
  toolCall: Pick<ToolCall, 'name' | 'arguments' | 'shortDescription' | 'stepLabel'>,
  t: Translations,
): string {
  const args = toolCall.arguments as Record<string, unknown> | undefined;
  if (WRITE_TOOLS.has(toolCall.name)) {
    const filePath = getToolFilePath(toolCall.name, args);
    const fileName = filePath ? basename(filePath) : '';
    return fileName
      ? t.chat.streamInterruptedWrite.replace('{file}', fileName)
      : t.chat.streamInterruptedWriteFallback;
  }
  return humanizeToolStep(
    toolCall.name,
    args,
    t,
    toolCall.shortDescription,
    'failed',
    toolCall.stepLabel,
  );
}
