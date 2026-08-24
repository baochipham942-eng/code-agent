import type { CronJobDefinition } from '../../shared/contract/cron';

export interface CronResultDeliveryOutcome {
  delivered: boolean;
  /** 没有配置推送目标时为 undefined——那不是失败，是用户没选。 */
  reason?: string;
}

/**
 * 推送目标的字符串形态：`<账号 type 或 name>:<会话 id>`。
 *
 * 为什么需要后半段：`ChannelAccount` 上**没有**任何「默认发到哪个会话」的字段，而通道的
 * sendMessage 第二个参数是平台侧的收件人 id（飞书 receive_id，`oc_` 群 / `ou_` 单聊）。
 * 只知道「用哪个账号」是发不出去的——原实现把账号 id 当 chatId 传，飞书实测回
 * `230001 invalid receive_id`（2026-08-24 实测），且返回值被丢掉 ⇒ 无人值守下静默失败。
 */
function parseTarget(raw: string): { account: string; chatId?: string } {
  const separator = raw.indexOf(':');
  if (separator < 0) return { account: raw.trim() };
  return {
    account: raw.slice(0, separator).trim(),
    chatId: raw.slice(separator + 1).trim() || undefined,
  };
}

export async function pushCronResult(
  definition: CronJobDefinition,
  result: unknown,
): Promise<CronResultDeliveryOutcome> {
  const actionContext = definition.action.type === 'agent'
    ? definition.action.context as Record<string, unknown> | undefined
    : undefined;
  const heartbeatChannel = actionContext?.heartbeatTask && typeof actionContext.channel === 'string'
    ? actionContext.channel
    : undefined;
  const targetChannel = definition.resultChannel?.trim() || heartbeatChannel;
  if (!targetChannel || !result) return { delivered: false };

  const { account: accountRef, chatId } = parseTarget(targetChannel);
  try {
    const { getChannelManager } = await import('../channels/channelManager');
    const channelManager = getChannelManager();
    const accounts = channelManager.getAllAccounts();
    const targetAccount = accounts.find(
      (account) => account.type === accountRef || account.name === accountRef,
    );
    if (!targetAccount) return fail(`channel account "${accountRef}" is not configured`);
    if (!chatId) {
      // 🚫 不许猜一个会话 id 顶上：猜错就是把任务结果发给了错误的人。
      return fail(`push target "${targetChannel}" has no conversation id (expected "<channel>:<chatId>")`);
    }

    const sent = await channelManager.sendMessage(targetAccount.id, chatId, String(result));
    // 🔴 返回值必须看：原实现忽略它，发送被平台拒绝（无效 receive_id / 不在出站白名单）时
    // 表现为「任务成功、结果没到」，而无人值守场景没有人会发现。
    if (!sent.success) return fail(`channel rejected the message: ${sent.error ?? 'unknown error'}`);

    console.error(`[CronService] Job result pushed to channel: ${targetChannel}`);
    return { delivered: true };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  function fail(reason: string): CronResultDeliveryOutcome {
    console.error(`[CronService] Failed to push job result to ${targetChannel}: ${reason}`);
    return { delivered: false, reason };
  }
}
