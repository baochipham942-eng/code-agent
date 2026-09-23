import type { CronJobAction, CronJobDefinition, CronJobExecution } from '../../shared/contract/cron';
import { CRON_AGENT_SNAPSHOT, CRON_RESULT_PUSH, EXTERNAL_WATCH } from '../../shared/constants';
import { saveCronExecution, upsertCronExecutionInMemory } from './cronPersistence';
import { truncateUtf8Snapshot } from './cronAgentPrompt';

interface CronResultDeliveryOutcome {
  delivered: boolean;
  /** 没有配置推送目标或与上次真推正文一字不差时为 undefined——那不是失败，是没东西要发。 */
  reason?: string;
  /** 真推成功时回传用于写回 lastPushed 的去重键（按 CRON_AGENT_SNAPSHOT.MAX_BYTES 截断；≤8KB 时与发出正文一字不差）。 */
  pushedBody?: string;
}

export interface CronResultDeliveryPersistence {
  /** 以 jobs 里的最新定义为底合并，避免并发编辑被覆盖（与快照写回同一套路）。 */
  getLatestDefinition: (jobId: string) => CronJobDefinition | undefined;
  /** 真推成功后把合并好的 action（含 lastPushed）落库，即 CronService.updateJob。 */
  persistAction: (jobId: string, action: CronJobAction) => Promise<unknown>;
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

/**
 * 推送正文清洗（PR#2060 ai-review Important 第二轮）：内置飞书监听模板让模型把对比状态
 * 包进 <cron_snapshot>、新发现包进 <cron_alert>，原文照推会把内部状态和标签壳怼到群里。
 * 规则：任何推送先剥全部 <cron_snapshot> 块；出现 <cron_alert> 时只推标签内正文
 * （多块拼接）；剥完为空 = 没东西要发，按安静处理不推（不写失败留痕）。
 * 正则复用 shared/constants 里的既有 pattern source，只加 global 旗标，不新造表达式。
 */
function sanitizePushBody(raw: string): string {
  const snapshotBlocks = new RegExp(CRON_AGENT_SNAPSHOT.TAG_PATTERN.source, 'gi');
  const withoutSnapshots = raw.replace(snapshotBlocks, '');
  const alertBlocks = new RegExp(EXTERNAL_WATCH.ALERT_TAG_PATTERN.source, 'gi');
  const alerts = [...withoutSnapshots.matchAll(alertBlocks)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  return (alerts.length > 0 ? alerts.join('\n') : withoutSnapshots).trim();
}

async function pushCronResult(
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

  const body = sanitizePushBody(String(result));
  if (!body) return { delivered: false };
  // 字面去重（免费路径，不受任何开关限制；借鉴 OWB scheduler.js:293「跟上次真推出去的比」）：
  // 正文与上次真推成功的一字不差就不推。判错最坏是少推一条重复内容，不是永远不知道。
  // lastPushed 只在真推成功后由下方 rememberPushedBody 写回，这里只读；
  // 比较与写回共用同一截断口径（≤8KB 时截断是恒等，「一字不差不推」严格成立）。
  const dedupBody = truncateUtf8Snapshot(body).value;
  if (definition.action.type === 'agent') {
    const lastPushed = definition.action.context?.[CRON_RESULT_PUSH.LAST_PUSHED_CONTEXT_KEY];
    if (typeof lastPushed === 'string' && dedupBody === lastPushed) {
      console.warn(`[CronService] Job result identical to the last pushed body, push skipped: ${targetChannel}`);
      return { delivered: false };
    }
  }

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

    const sent = await channelManager.sendMessage(targetAccount.id, chatId, body);
    // 🔴 返回值必须看：原实现忽略它，发送被平台拒绝（无效 receive_id / 不在出站白名单）时
    // 表现为「任务成功、结果没到」，而无人值守场景没有人会发现。
    if (!sent.success) return fail(`channel rejected the message: ${sent.error ?? 'unknown error'}`);

    console.error(`[CronService] Job result pushed to channel: ${targetChannel}`);
    return { delivered: true, pushedBody: dedupBody };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  function fail(reason: string): CronResultDeliveryOutcome {
    console.error(`[CronService] Failed to push job result to ${targetChannel}: ${reason}`);
    return { delivered: false, reason };
  }
}

/**
 * 推结果 + 失败留痕 + 字面去重写回（FB-239）。
 * 推送失败原来只有一行 console.warn，无人值守场景等于没有信号；这里把原因写进
 * 该次执行记录的 error 字段（执行历史已经在展示它），不新造告警面。
 * 🚫 不改 status：任务本身确实跑成功了，改成 failed 会谎报执行结果。
 * 返回投递 outcome 供调用方/测试核对；生产调用方（CronService）只看副作用。
 */
export async function deliverCronResultToChannel(
  definition: CronJobDefinition,
  result: unknown,
  executions: Map<string, CronJobExecution[]>,
  executionId: string | undefined,
  persistence: CronResultDeliveryPersistence,
): Promise<CronResultDeliveryOutcome> {
  const outcome = await pushCronResult(definition, result);
  if (outcome.delivered) {
    await rememberPushedBody(definition, outcome.pushedBody, persistence);
    return outcome;
  }
  if (!outcome.reason || !executionId) return outcome;
  const executionsForJob = executions.get(definition.id) ?? [];
  const execution = executionsForJob.find((candidate) => candidate.id === executionId);
  if (!execution) return outcome;
  const note = `结果推送失败：${outcome.reason}`;
  execution.error = execution.error ? `${execution.error}\n${note}` : note;
  upsertCronExecutionInMemory(executions, execution);
  await saveCronExecution(execution);
  return outcome;
}

/** lastPushed 只在真推成功后写回：推失败不写——下一轮正文不变也还会再试。写库失败不拖垮本次执行。 */
async function rememberPushedBody(
  definition: CronJobDefinition,
  pushedBody: string | undefined,
  persistence: CronResultDeliveryPersistence,
): Promise<void> {
  if (pushedBody === undefined) return;
  const latest = persistence.getLatestDefinition(definition.id) ?? definition;
  if (latest.action.type !== 'agent') return;
  try {
    await persistence.persistAction(definition.id, {
      ...latest.action,
      context: {
        ...latest.action.context,
        [CRON_RESULT_PUSH.LAST_PUSHED_CONTEXT_KEY]: pushedBody,
      },
    });
  } catch (error) {
    console.warn(`[CronService] Failed to persist last pushed body (job=${definition.id})`, error);
  }
}
