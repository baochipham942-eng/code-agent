// ============================================================================
// Durable Resume 系统通知文案（zh/en）
// locale 由调用方从 configService 的 ui.language 读入（与 sessionTaskSlot 同一机制）。
// ============================================================================
export type DurableResumeNotificationLocale = 'zh' | 'en';

export interface DurableResumeNotificationText {
  untitledSession: string;
  waitingBody: string;
  resumingTitle: (sessionTitle: string) => string;
  resumingBody: (autoResumeCount: number) => string;
}

const messages: Record<DurableResumeNotificationLocale, DurableResumeNotificationText> = {
  zh: {
    untitledSession: '未命名会话',
    waitingBody: '任务暂停，等待确认后继续。',
    resumingTitle: (sessionTitle: string) => `任务正在继续 - ${sessionTitle}`,
    resumingBody: (autoResumeCount: number) =>
      `从中断处继续；本轮成本未知/估算，继续运行会消耗额度。自动续跑第 ${autoResumeCount} 次。`,
  },
  en: {
    untitledSession: 'Untitled session',
    waitingBody: 'Task paused, waiting for confirmation to continue.',
    resumingTitle: (sessionTitle: string) => `Task resuming - ${sessionTitle}`,
    resumingBody: (autoResumeCount: number) =>
      `Resuming from the interruption; this turn cost is unknown/estimated, and continuing will use quota. Automatic resume attempt ${autoResumeCount}.`,
  },
};

export function getDurableResumeNotificationText(
  locale: DurableResumeNotificationLocale,
): DurableResumeNotificationText {
  return messages[locale];
}
