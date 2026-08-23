import type { CronJobDefinition } from '../../shared/contract/cron';

export async function pushCronResult(
  definition: CronJobDefinition,
  result: unknown,
): Promise<void> {
  const actionContext = definition.action.type === 'agent'
    ? definition.action.context as Record<string, unknown> | undefined
    : undefined;
  const heartbeatChannel = actionContext?.heartbeatTask && typeof actionContext.channel === 'string'
    ? actionContext.channel
    : undefined;
  const targetChannel = definition.resultChannel?.trim() || heartbeatChannel;
  if (!targetChannel || !result) return;

  try {
    const { getChannelManager } = await import('../channels/channelManager');
    const channelManager = getChannelManager();
    const accounts = channelManager.getAllAccounts();
    const targetAccount = accounts.find(
      (account) => account.type === targetChannel || account.name === targetChannel,
    );
    if (!targetAccount) return;
    await channelManager.sendMessage(targetAccount.id, targetAccount.id, String(result));
    console.error(`[CronService] Job result pushed to channel: ${targetChannel}`);
  } catch (error) {
    console.warn(`[CronService] Failed to push job result to channel: ${targetChannel}`, error);
  }
}
