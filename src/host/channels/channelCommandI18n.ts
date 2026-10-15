import type { InboundAccessLocale } from './inboundAccessI18n';

const messages = {
  'zh-CN': {
    unauthorized: '无权',
    stopped: '已停止',
    windingDown: '已请求停止，仍在收尾',
    nothingRunning: '没有运行中的任务',
    cannotStop: '此运行无法从 IM 中止。请打开 Neo 桌面端处理。',
    newWhileRunning: '有任务在运行，请先发「停」',
    newConversation: '已开始新的对话。之前的记录还在。',
    busyHint: '正在处理上一条，发「停」可以中止',
    noDataYet: '还没有上下文数据',
    contextUsed: '上下文已用 {percent}%',
    stateIdle: '空闲',
    stateRunning: '正在运行',
    statePaused: '已暂停，可继续',
  },
  'en-US': {
    unauthorized: 'Not allowed.',
    stopped: 'stopped',
    windingDown: 'stop requested, still winding down',
    nothingRunning: 'Nothing is running.',
    cannotStop: 'This run cannot be stopped from IM. Open the Neo desktop app.',
    newWhileRunning: 'A task is running. Send "stop" first.',
    newConversation: 'Started a new conversation. Previous messages are still saved.',
    busyHint: 'Still working on your previous message. Send "stop" to cancel it.',
    noDataYet: 'no context data yet',
    contextUsed: 'context {percent}% used',
    stateIdle: 'Idle',
    stateRunning: 'Running',
    statePaused: 'Paused, can resume',
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
  // 只给百分比：原始 token 数对 IM 里的普通用户没有意义。
  const usage = health
    ? channelCommandText(locale, 'contextUsed').replace('{percent}', String(Math.round(health.usagePercent)))
    : channelCommandText(locale, 'noDataYet');
  return `${channelCommandText(locale, stateKey)} · ${usage}`;
}
