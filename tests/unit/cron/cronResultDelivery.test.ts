import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobAction, CronJobDefinition } from '../../../src/shared/contract/cron';
import { CRON_AGENT_SNAPSHOT } from '../../../src/shared/constants';
import { truncateUtf8Snapshot } from '../../../src/host/cron/cronAgentPrompt';

const sendMessage = vi.fn();
const getAllAccounts = vi.fn();

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({ getAllAccounts, sendMessage }),
}));

const { deliverCronResultToChannel } = await import('../../../src/host/cron/cronResultDelivery');

function job(resultChannel?: string): CronJobDefinition {
  return {
    id: 'job-1',
    name: '每日简报',
    runsOn: 'local',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * *' },
    action: { type: 'agent', agentType: 'default', prompt: '写简报' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...(resultChannel === undefined ? {} : { resultChannel }),
  };
}

// 行为面入口：pushCronResult 是模块内私有实现细节，测试走 deliverCronResultToChannel。
// persistence 替身模拟 CronService 的 updateJob 写回——getLatestDefinition 读同一个
// definition，persistAction 把合并后的 action 写回去，两轮调用之间去重状态真实流转。
function deliver(definition: CronJobDefinition, result: unknown) {
  const persistAction = vi.fn(async (_jobId: string, action: CronJobAction) => {
    definition.action = action;
  });
  const outcome = deliverCronResultToChannel(definition, result, new Map(), undefined, {
    getLatestDefinition: () => definition,
    persistAction,
  });
  return { outcome, persistAction };
}

const feishuAccount = { id: 'account-uuid', name: '飞书 · Neo 助手', type: 'feishu' };

beforeEach(() => {
  sendMessage.mockReset();
  getAllAccounts.mockReset();
  getAllAccounts.mockReturnValue([feishuAccount]);
  sendMessage.mockResolvedValue({ success: true, messageId: 'om_1' });
});

describe('deliverCronResultToChannel', () => {
  // 🔴 承重：会话 id 必须原样传给通道，不能传账号 id。原实现传 account.id，
  // 飞书实测回 230001 invalid receive_id（2026-08-24 实测），结果永远到不了群里。
  it('sends to the conversation id from the target, not the account id', async () => {
    const { outcome, persistAction } = deliver(job('feishu:oc_group1'), '简报内容');
    await expect(outcome).resolves.toEqual({ delivered: true, pushedBody: '简报内容' });
    expect(sendMessage).toHaveBeenCalledWith('account-uuid', 'oc_group1', '简报内容');
    // 真推成功 → lastPushed 写回（合并进 action.context 落库）。
    expect(persistAction).toHaveBeenCalledWith('job-1', expect.objectContaining({
      context: { lastPushedResult: '简报内容' },
    }));
  });

  it('matches the account by name as well as by type', async () => {
    await deliver(job('飞书 · Neo 助手:oc_group1'), '内容').outcome;
    expect(sendMessage).toHaveBeenCalledWith('account-uuid', 'oc_group1', '内容');
  });

  // 没给会话 id 时宁可不发也不猜——猜错等于把任务结果发给错误的人。
  it('refuses to guess a conversation when the target has no chat id', async () => {
    const { outcome, persistAction } = deliver(job('feishu'), '内容');
    const result = await outcome;
    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('no conversation id');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(persistAction).not.toHaveBeenCalled();
  });

  it('reports a missing channel account instead of failing silently', async () => {
    getAllAccounts.mockReturnValue([]);
    const result = await deliver(job('feishu:oc_group1'), '内容').outcome;
    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('not configured');
  });

  // 🔴 平台拒发（无效 receive_id / 不在出站白名单）原来被整个丢掉 ⇒
  // 「任务成功、结果没到」且零信号。返回值必须被看。
  it('surfaces a platform rejection as a failure reason', async () => {
    sendMessage.mockResolvedValue({ success: false, error: 'invalid receive_id' });
    const { outcome, persistAction } = deliver(job('feishu:oc_group1'), '内容');
    const result = await outcome;
    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('invalid receive_id');
    // 没推成就不许更新 lastPushed——下一轮同正文还会再试。
    expect(persistAction).not.toHaveBeenCalled();
  });

  it('stays quiet when the user chose no push target', async () => {
    const result = await deliver(job(undefined), '内容').outcome;
    expect(result).toEqual({ delivered: false });
    expect(result.reason).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('deliverCronResultToChannel literal dedup against lastPushed (FB-239)', () => {
  // 字面门（免 Jev 的免费路径）：只跟「上次真推出去的」比，不是「上次跑的」。
  it('skips the push when the body is byte-identical to the last pushed body', async () => {
    const definition = job('feishu:oc_group1');
    definition.action = { ...definition.action, context: { lastPushedResult: '简报内容' } } as typeof definition.action;

    const { outcome, persistAction } = deliver(definition, '简报内容');

    expect(await outcome).toEqual({ delivered: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(persistAction).not.toHaveBeenCalled();
  });

  it('pushes when the body differs from lastPushed by even one character', async () => {
    const definition = job('feishu:oc_group1');
    definition.action = { ...definition.action, context: { lastPushedResult: '简报内容' } } as typeof definition.action;

    const result = await deliver(definition, '简报内容。').outcome;

    expect(result).toEqual({ delivered: true, pushedBody: '简报内容。' });
    expect(sendMessage).toHaveBeenCalledWith('account-uuid', 'oc_group1', '简报内容。');
  });

  // 写回后再来同正文：persistence 替身把 lastPushed 真写回 definition，第二轮被去重拦下。
  it('dedups a repeat push after the persisted lastPushed write-back', async () => {
    const definition = job('feishu:oc_group1');

    expect(await deliver(definition, '同正文').outcome).toEqual({ delivered: true, pushedBody: '同正文' });
    expect(await deliver(definition, '同正文').outcome).toEqual({ delivered: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  // 去重状态只存在 agent action 的 context 袋里；shell/webhook 没有袋子可放，
  // 它们的推送行为保持不变（每次照推）。
  it('never dedups non-agent actions: identical bodies still push every time', async () => {
    const shellDefinition = {
      ...job('feishu:oc_group1'),
      action: { type: 'shell', command: 'echo ok' },
    } as CronJobDefinition;

    await expect(deliver(shellDefinition, 'same').outcome).resolves.toEqual({ delivered: true, pushedBody: 'same' });
    await expect(deliver(shellDefinition, 'same').outcome).resolves.toEqual({ delivered: true, pushedBody: 'same' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  // 去重键落库前按快照同一口径截断（8KB UTF-8），比较也用同一口径：
  // 超长按截断后形态比对，≤8KB 正文则「一字不差不推」严格成立。
  it('compares and stores lastPushed with the shared 8KB truncation', async () => {
    const longBody = `${'长'.repeat(CRON_AGENT_SNAPSHOT.MAX_BYTES)}尾巴`;
    const truncated = truncateUtf8Snapshot(longBody).value;
    const definition = job('feishu:oc_group1');
    definition.action = { ...definition.action, context: { lastPushedResult: truncated } } as typeof definition.action;

    const result = await deliver(definition, longBody).outcome;

    expect(result).toEqual({ delivered: false });
    expect(sendMessage).not.toHaveBeenCalled();

    // 截断窗口内差一字仍照推，且写回键就是截断后的正文。
    const changedBody = `异${longBody.slice(1)}`;
    await expect(deliver(definition, changedBody).outcome).resolves.toEqual({
      delivered: true,
      pushedBody: truncateUtf8Snapshot(changedBody).value,
    });
  });
});

describe('deliverCronResultToChannel push body sanitization (PR#2060 round 2)', () => {
  // 监听模板让模型把对比状态包进 <cron_snapshot>、新发现包进 <cron_alert>；
  // 剥快照块 + 只推 alert 内文，标签壳不许进通道。
  it('strips snapshot blocks and pushes only the alert inner text', async () => {
    const raw = '巡检完成。<cron_snapshot>{"fingerprint":"abc"}</cron_snapshot><cron_alert>冲突 A</cron_alert> 其余说明 <cron_alert>冲突 B</cron_alert>';
    const result = await deliver(job('feishu:oc_group1'), raw).outcome;

    expect(result).toEqual({ delivered: true, pushedBody: '冲突 A\n冲突 B' });
    expect(sendMessage).toHaveBeenCalledWith('account-uuid', 'oc_group1', '冲突 A\n冲突 B');
  });

  it('strips snapshot blocks from plain bodies without touching the text', async () => {
    const result = await deliver(job('feishu:oc_group1'), '日报正文<cron_snapshot>state</cron_snapshot>').outcome;

    expect(result).toEqual({ delivered: true, pushedBody: '日报正文' });
    expect(sendMessage).toHaveBeenCalledWith('account-uuid', 'oc_group1', '日报正文');
  });

  // 剥完为空 = 没东西要发：按安静处理不推，且不写失败留痕（reason 为 undefined）。
  it('stays quiet when nothing survives sanitization', async () => {
    const result = await deliver(job('feishu:oc_group1'), '<cron_snapshot>only-state</cron_snapshot>').outcome;

    expect(result).toEqual({ delivered: false });
    expect(result.reason).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
