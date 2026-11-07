export type NotificationDigestLocale = 'zh' | 'en';

export interface NotificationDigestText {
  title: (count: number) => string;
  body: (titles: readonly string[], count: number) => string;
}

const messages: Record<NotificationDigestLocale, NotificationDigestText> = {
  zh: {
    title: (count) => `另有 ${count} 条通知`,
    body: (titles, count) => `共 ${count} 条通知：\n${titles.slice(0, 3).join('\n')}\n…`,
  },
  en: {
    title: (count) => `${count} more notifications`,
    body: (titles, count) => `${count} notifications:\n${titles.slice(0, 3).join('\n')}\n…`,
  },
};

export function getNotificationDigestText(locale: NotificationDigestLocale): NotificationDigestText {
  return messages[locale];
}
