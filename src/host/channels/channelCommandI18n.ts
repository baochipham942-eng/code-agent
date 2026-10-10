import type { InboundAccessLocale } from './inboundAccessI18n';

const messages = {
  'zh-CN': {
    unauthorized: '无权',
    stopped: '已停止',
    windingDown: '已请求停止，仍在收尾',
    nothingRunning: '没有运行中的任务',
    cannotStop: '此运行无法从 IM 中止。请打开 Neo 桌面端处理。',
    newWhileRunning: '有任务在运行，请先 /stop',
    newConversation: '已开始新的对话。之前的记录还在。',
    noDataYet: '还没有上下文数据',
    stateIdle: 'idle',
    stateRunning: 'running',
    statePaused: 'paused-resumable',
  },
  'en-US': {
    unauthorized: 'Not allowed.',
    stopped: 'stopped',
    windingDown: 'stop requested, still winding down',
    nothingRunning: 'Nothing is running.',
    cannotStop: 'This run cannot be stopped from IM. Open the Neo desktop app.',
    newWhileRunning: 'A task is running. Send /stop first.',
    newConversation: 'Started a new conversation. Previous messages are still saved.',
    noDataYet: 'no data yet',
    stateIdle: 'idle',
    stateRunning: 'running',
    statePaused: 'paused-resumable',
  },
} as const;

type ChannelCommandTextKey = keyof typeof messages['zh-CN'];

export function channelCommandText(
  locale: InboundAccessLocale | undefined,
  key: ChannelCommandTextKey,
): string {
  return messages[locale ?? 'zh-CN'][key];
}

export function formatChannelStatus(
  locale: InboundAccessLocale | undefined,
  state: 'idle' | 'running' | 'paused-resumable',
  health: { currentTokens: number; maxTokens: number; usagePercent: number } | null,
): string {
  const stateKey = state === 'running' ? 'stateRunning' : state === 'paused-resumable' ? 'statePaused' : 'stateIdle';
  const usage = health
    ? `${health.currentTokens}/${health.maxTokens} (${health.usagePercent}%)`
    : channelCommandText(locale, 'noDataYet');
  return `${channelCommandText(locale, stateKey)} ${usage}`;
}
