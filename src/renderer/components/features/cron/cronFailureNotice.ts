// 定时失败的系统通知译文。登录墙和 CRON_FAILURE 都在这里按界面语言出标题正文，
// App 只负责把结果交给系统通知，避免 App.tsx 再涨行。

import { CRON_LOGIN_WALL_STOP } from '@shared/utils/browserLoginWall';
import {
  CRON_FAILURE_CODE,
  type CronFailurePresentationKind,
} from '@shared/utils/cronFailureClassification';
import type { NotificationShowEvent } from '@shared/ipc';

interface CronFailureCopy {
  loginWallNotificationTitle: string;
  loginWallNotificationBody: string;
  failureNotificationTitle: string;
  failureToastView: string;
  failureQuotaWithReset: string;
  failureQuotaWithResetAndLimit: string;
  failureQuotaUnknown: string;
  failureQuotaUnknownWithLimit: string;
  failureRateLimit: string;
  failureTimeout: string;
  failureAuth: string;
  failureNetwork: string;
  failureCloudUnavailable: string;
  failureOther: string;
}

interface CronOsNotice {
  title: string;
  body: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时间。同一天只留时刻，跨天才带日期。非法时间返回 undefined。 */
function formatCronResetAt(
  iso: string,
  language: 'zh' | 'en',
  now = new Date(),
): string | undefined {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return undefined;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return time;
  if (language === 'zh') return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function cronFailureSentence(
  kind: CronFailurePresentationKind,
  extra: { limitText?: string; resetAt?: string },
  copy: CronFailureCopy,
  language: 'zh' | 'en',
  now = new Date(),
): string {
  if (kind === 'quota') {
    const when = extra.resetAt ? formatCronResetAt(extra.resetAt, language, now) : undefined;
    if (when && extra.limitText) {
      return copy.failureQuotaWithResetAndLimit.replace('{when}', when).replace('{limit}', extra.limitText);
    }
    if (when) return copy.failureQuotaWithReset.replace('{when}', when);
    if (extra.limitText) return copy.failureQuotaUnknownWithLimit.replace('{limit}', extra.limitText);
    return copy.failureQuotaUnknown;
  }
  if (kind === 'rate_limit') return copy.failureRateLimit;
  if (kind === 'timeout') return copy.failureTimeout;
  if (kind === 'auth') return copy.failureAuth;
  if (kind === 'network') return copy.failureNetwork;
  if (kind === 'cloud_unavailable') return copy.failureCloudUnavailable;
  return copy.failureOther;
}

function jobNameFromHostTitle(title: string): string | undefined {
  const matched = title.match(/\[定时\]\s*(.+)$/);
  const name = matched?.[1]?.trim();
  return name || undefined;
}

/**
 * 云端调度器不可用的失败通知没有本地会话可跳（云端 run 的 session 活在服务端）：
 * 命中时给出点击应选中的任务 id，由调用方打开 Cron Center 落到该任务的失败详情；
 * 其余通知（含没带 jobId 的）返回 undefined，既有点击行为一字不变。
 */
export function cronFailureCloudDownJobId(
  event: Pick<NotificationShowEvent, 'code' | 'failureKind' | 'jobId'> | null | undefined,
): string | undefined {
  if (event?.code !== CRON_FAILURE_CODE || event.failureKind !== 'cloud_unavailable') return undefined;
  return event.jobId;
}

export function translateCronOsNotification(
  event: Pick<NotificationShowEvent, 'code' | 'title' | 'body' | 'siteOrigin' | 'failureKind' | 'resetAt'>,
  copy: CronFailureCopy,
  language: 'zh' | 'en',
  now = new Date(),
): CronOsNotice {
  if (event.code === CRON_LOGIN_WALL_STOP && event.siteOrigin) {
    return {
      title: copy.loginWallNotificationTitle,
      body: copy.loginWallNotificationBody.replace('{site}', event.siteOrigin),
    };
  }
  if (event.code === CRON_FAILURE_CODE && event.failureKind) {
    const name = jobNameFromHostTitle(event.title);
    return {
      title: name ? copy.failureNotificationTitle.replace('{name}', name) : event.title,
      body: cronFailureSentence(
        event.failureKind,
        { resetAt: event.resetAt },
        copy,
        language,
        now,
      ),
    };
  }
  return { title: event.title, body: event.body };
}
