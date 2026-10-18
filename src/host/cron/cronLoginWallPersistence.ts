import type { CronJobDefinition } from '../../shared/contract/cron';
import { siteOriginFromUrl } from '../../shared/utils/browserLoginWall';

interface ActiveCronJob {
  definition: CronJobDefinition;
}

/**
 * Persist a login pass-through origin after an explicit user consent action.
 * Runtime login-wall detection must never call this helper: the caller is the
 * renderer's "在 Neo 浏览器中登录" action and therefore has a concrete job id.
 */
export async function rememberCronLoginPassThroughOrigin(
  active: ActiveCronJob | undefined,
  siteOrigin: string,
  persistJob: (definition: CronJobDefinition) => Promise<void>,
  updatedAt?: number,
): Promise<void> {
  if (!active) return;
  const normalizedOrigin = normalizeHttpOrigin(siteOrigin);
  if (!normalizedOrigin) throw new Error('CRON_LOGIN_WALL_ORIGIN_INVALID');
  if (active.definition.metadata?.loginPassThroughOrigin === normalizedOrigin) return;
  const updated: CronJobDefinition = {
    ...active.definition,
    metadata: {
      ...(active.definition.metadata ?? {}),
      loginPassThroughOrigin: normalizedOrigin,
    },
    updatedAt: updatedAt ?? Date.now(),
  };
  await persistJob(updated);
  active.definition = updated;
}

function normalizeHttpOrigin(value: string): string | undefined {
  const normalized = siteOriginFromUrl(value.trim());
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}
