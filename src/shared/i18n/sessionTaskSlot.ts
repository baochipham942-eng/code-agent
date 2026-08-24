export type SessionTaskSlotLocale = 'zh' | 'en';

function durationText(durationMs: number, locale: SessionTaskSlotLocale): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return locale === 'zh' ? `${seconds} 秒` : `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return locale === 'zh' ? `${minutes} 分钟` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return locale === 'zh' ? `${hours} 小时` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

const messages = {
  zh: {
    detail: (taskLabel: string, laneKey: string, duration: string) => (
      `任务「${taskLabel}」在 lane「${laneKey}」占用 ${duration}后仍未收到终态事件，可能是运行进程异常退出。系统已自动释放占位，并将原任务标记为失败。`
    ),
    screen: '任务长时间没有回报结束状态，系统已释放它占用的任务队列，请重试',
    spoken: '任务长时间没有回报结束状态，系统已经释放任务队列。这件事没有完成，请重试。',
  },
  en: {
    detail: (taskLabel: string, laneKey: string, duration: string) => (
      `Task “${taskLabel}” occupied lane “${laneKey}” for ${duration} without a terminal event, likely because the run process exited unexpectedly. The slot was released automatically and the original task was marked as failed.`
    ),
    screen: 'The task stopped reporting its final state, so its queue slot was released. Please retry',
    spoken: 'The task stopped reporting its final state, so its queue slot was released. It did not finish. Please retry.',
  },
} as const;

export function formatSessionTaskSlotRecoveryDetail(input: {
  taskLabel: string;
  laneKey: string;
  occupiedMs: number;
  locale: SessionTaskSlotLocale;
}): string {
  return messages[input.locale].detail(
    input.taskLabel,
    input.laneKey,
    durationText(input.occupiedMs, input.locale),
  );
}

export function describeSessionTaskSlotRecovery(locale: SessionTaskSlotLocale): {
  screen: string;
  spoken: string;
} {
  return messages[locale];
}
