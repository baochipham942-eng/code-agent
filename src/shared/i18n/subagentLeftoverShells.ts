import {
  getSystemPromptHint,
  type SessionTaskSlotLocale,
} from './sessionTaskSlot';

export interface SubagentLeftoverShellReportItem {
  commandSummary: string;
  taskId: string;
  elapsedMs: number;
  mayAwaitSystemPrompt: boolean;
}

function durationText(durationMs: number, locale: SessionTaskSlotLocale): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return locale === 'zh' ? `${seconds} 秒` : `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return locale === 'zh' ? `${minutes} 分钟` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return locale === 'zh' ? `${hours} 小时` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

export function formatSubagentLeftoverShellReport(
  items: readonly SubagentLeftoverShellReportItem[],
  locale: SessionTaskSlotLocale,
): string {
  if (items.length === 0) return '';
  const heading = locale === 'zh'
    ? '此子代理结束后，以下命令仍在运行：'
    : 'Left running after this agent ended:';
  const lines = items.map((item) => locale === 'zh'
    ? `- \`${item.commandSummary}\`（任务 ${item.taskId}，已运行 ${durationText(item.elapsedMs, locale)}）。仍在运行，可手动停止。`
    : `- \`${item.commandSummary}\` (task ${item.taskId}, running ${durationText(item.elapsedMs, locale)}). Still running — can be stopped manually.`);
  if (items.some((item) => item.mayAwaitSystemPrompt)) {
    lines.push(getSystemPromptHint(locale));
  }
  return [heading, ...lines].join('\n');
}
