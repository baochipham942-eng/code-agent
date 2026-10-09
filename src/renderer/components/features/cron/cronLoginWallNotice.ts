import type { CronJobDefinition } from '@shared/contract';
import { parseCronLoginWallStop } from '@shared/utils/browserLoginWall';
import { toast, type ToastAction } from '../../../hooks/useToast';
import { openExternalLink } from '../../../utils/platform';

function openSite(siteOrigin: string): void {
  if (!openExternalLink(siteOrigin)) {
    window.open(siteOrigin, '_blank', 'noopener,noreferrer');
  }
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
