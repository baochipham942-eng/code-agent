import type { CronJobDefinition } from '../../shared/contract/cron';
import { siteOriginFromUrl } from '../../shared/utils/browserLoginWall';

const URL_PATTERN = /https?:\/\/[^\s<>'"`)]+/gi;
const LOGIN_GATED_HINT = /登录后|请先登录|请登录|需要登录|sign in|log in|login required|authentication required|login|已登录|账号|cookie/i;

function actionText(definition: Pick<CronJobDefinition, 'action'>): string {
  try {
    return JSON.stringify(definition.action);
  } catch {
    return '';
  }
}

/** Conservative create/edit warning: require a URL and an explicit auth hint. */
function detectCronLoginGatedSite(
  definition: Pick<CronJobDefinition, 'action'>,
): string | undefined {
  const text = actionText(definition);
  if (!LOGIN_GATED_HINT.test(text)) return undefined;
  const url = text.match(URL_PATTERN)?.[0];
  return url ? siteOriginFromUrl(url) : undefined;
}

export function cronLoginWallMetadata(
  definition: Pick<CronJobDefinition, 'action'>,
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const siteOrigin = detectCronLoginGatedSite(definition);
  const next = { ...(metadata ?? {}) };
  if (siteOrigin) next.loginGatedSiteOrigin = siteOrigin;
  else delete next.loginGatedSiteOrigin;
  return Object.keys(next).length > 0 ? next : undefined;
}
