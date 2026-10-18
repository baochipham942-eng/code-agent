import type { CronJobDefinition } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import type { NotificationShowEvent } from '@shared/ipc';
import { CRON_LOGIN_WALL_STOP } from '@shared/utils/browserLoginWall';
import { parseCronLoginWallStop } from '@shared/utils/browserLoginWall';
import { toast, type ToastAction } from '../../../hooks/useToast';
import ipcService from '../../../services/ipcService';

function openSite(siteOrigin: string): void {
  // 登录墙只把站点 origin 交给 Neo 的个人持久 profile；不再打开系统浏览器，
  // 否则用户刚写入的登录态不会进入后续 cron 的受限 profile。
  void ipcService.invokeDomain(
    IPC_DOMAINS.DESKTOP,
    'openManagedBrowserUrl',
    { url: siteOrigin, mode: 'visible', profileMode: 'persistent' },
  ).catch(() => undefined);
}

function loginGatedSiteOrigin(job: CronJobDefinition | null | undefined): string | undefined {
  const value = job?.metadata?.loginGatedSiteOrigin;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function showCronLoginWallWarning(
  job: CronJobDefinition | null | undefined,
  copy: { warning: string; openSite: string },
): void {
  const siteOrigin = loginGatedSiteOrigin(job);
  if (!siteOrigin) return;
  const action: ToastAction = { label: copy.openSite, onClick: () => openSite(siteOrigin) };
  toast.warning(copy.warning.replace('{site}', siteOrigin), action);
}

export function cronLoginWallCopy(
  error: string | undefined,
  copy: { error: string },
): { siteOrigin: string; message: string } | undefined {
  const loginWall = parseCronLoginWallStop(error);
  return loginWall
    ? { siteOrigin: loginWall.siteOrigin, message: copy.error.replace('{site}', loginWall.siteOrigin) }
    : undefined;
}

export function openCronLoginWallSite(siteOrigin: string): void {
  openSite(siteOrigin);
}

export function cronLoginWallSiteOriginFromNotification(
  event: Pick<NotificationShowEvent, 'code' | 'siteOrigin'>,
): string | undefined {
  return event.code === CRON_LOGIN_WALL_STOP && typeof event.siteOrigin === 'string' && event.siteOrigin.trim()
    ? event.siteOrigin
    : undefined;
}
