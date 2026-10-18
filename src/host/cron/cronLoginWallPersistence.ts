import type { CronJobDefinition } from '../../shared/contract/cron';

interface ActiveCronJob {
  definition: CronJobDefinition;
}

/** 持久化运行时发现的登录墙 origin，避免重新执行 action 元数据检测。 */
export async function rememberCronLoginGatedSiteOrigin(
  active: ActiveCronJob | undefined,
  siteOrigin: string,
  persistJob: (definition: CronJobDefinition) => Promise<void>,
  updatedAt?: number,
): Promise<void> {
  if (!active || active.definition.metadata?.loginGatedSiteOrigin === siteOrigin) return;
  const updated: CronJobDefinition = {
    ...active.definition,
    metadata: { ...(active.definition.metadata ?? {}), loginGatedSiteOrigin: siteOrigin },
    updatedAt: updatedAt ?? Date.now(),
  };
  await persistJob(updated);
  active.definition = updated;
}
