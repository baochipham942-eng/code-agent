import type { CronJobDefinition, CronMissedEvent, Message } from '../../shared/contract';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getConfigService } from '../services/core/configService';
import { getDatabase } from '../services/core/databaseService';
import { getSessionManager } from '../services/infra/sessionManager';
import { getSessionAutomationService } from '../services/sessionAutomation';
import { broadcastToRenderer } from '../platform';
import {
  buildCronAutomationConfig,
  formatCronScheduleLabel,
  getCronAutomationType,
  readCronSourceSessionId,
} from './cronAutomationBridge';

function readUiLanguage(): 'zh' | 'en' {
  try {
    return getConfigService().getSettings().ui.language === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function formatCronMissedMessage(
  definition: Pick<CronJobDefinition, 'name'>,
  scheduledAt: number,
  disabled: boolean,
  language: 'zh' | 'en' = readUiLanguage(),
): string {
  const locale = language === 'en' ? 'en-US' : 'zh-CN';
  const time = new Date(scheduledAt).toLocaleString(locale);
  if (language === 'en') {
    return disabled
      ? `The scheduled task “${definition.name}”, due at ${time}, was missed while the app was offline and has been disabled. Re-enable it if needed.`
      : `The scheduled task “${definition.name}”, due at ${time}, was missed while the app was offline. Its next run remains scheduled.`;
  }
  return disabled
    ? `原定 ${time} 的定时任务「${definition.name}」在应用离线期间被错过，已停用；需要可重新启用。`
    : `原定 ${time} 的定时任务「${definition.name}」在应用离线期间被错过；后续仍按原计划运行。`;
}

export async function persistCronMissedTrace(
  definition: CronJobDefinition,
  event: CronMissedEvent,
  nextRunAt?: number,
): Promise<'session' | 'inbox'> {
  const sourceSessionId = readCronSourceSessionId(definition) ?? null;
  const automationType = getCronAutomationType(definition);
  const automationService = getSessionAutomationService();
  const isOneTime = definition.schedule.type === 'at';
  const baseConfig = buildCronAutomationConfig(definition);
  const targetExists = sourceSessionId
    ? getDatabase().getSession(sourceSessionId) !== null
    : false;

  automationService.upsert({
    id: `${automationType}:${definition.id}`,
    sourceSessionId,
    type: automationType,
    status: targetExists ? (isOneTime ? 'paused' : 'active') : (isOneTime ? 'pending_review' : 'active'),
    title: definition.name,
    cadenceLabel: formatCronScheduleLabel(definition.schedule),
    nextRunAt,
    sourceRefId: definition.id,
    config: {
      ...baseConfig,
      ...(!targetExists
        ? {
          pendingReview: { at: event.scheduledAt },
          missedNotice: { scheduledAt: event.scheduledAt, reason: event.reason },
        }
        : {}),
    },
  });

  if (!targetExists || !sourceSessionId) return 'inbox';

  const message: Message = {
    id: `cron-missed:${definition.id}:${event.scheduledAt}`,
    role: 'system',
    source: 'automation',
    content: formatCronMissedMessage(definition, event.scheduledAt, isOneTime),
    timestamp: Date.now(),
    metadata: {
      automation: {
        automationId: `${automationType}:${definition.id}`,
        automationType,
        event: 'missed',
        sourceSessionId,
        sourceRefId: definition.id,
        status: isOneTime ? 'paused' : 'active',
        title: definition.name,
        cadenceLabel: formatCronScheduleLabel(definition.schedule),
        nextRunAt,
      },
    },
  };
  try {
    await getSessionManager().addMessageToSession(sourceSessionId, message);
  } catch (error) {
    automationService.upsert({
      id: `${automationType}:${definition.id}`,
      sourceSessionId,
      type: automationType,
      status: isOneTime ? 'pending_review' : 'active',
      title: definition.name,
      cadenceLabel: formatCronScheduleLabel(definition.schedule),
      nextRunAt,
      sourceRefId: definition.id,
      config: {
        ...baseConfig,
        pendingReview: { at: event.scheduledAt },
        missedNotice: { scheduledAt: event.scheduledAt, reason: event.reason },
      },
    });
    console.error('[CronService] Failed to write missed trace to its target session; routed to automation inbox:', error);
    return 'inbox';
  }
  try {
    broadcastToRenderer(IPC_CHANNELS.SESSION_AUTOMATION_MESSAGE, { sessionId: sourceSessionId, message });
  } catch {
    // Persistence is authoritative; an inactive renderer will load the message from the session DB.
  }
  return 'session';
}
