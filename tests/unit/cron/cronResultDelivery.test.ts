import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { CRON_AGENT_SNAPSHOT } from '../../../src/shared/constants';
import { truncateUtf8Snapshot } from '../../../src/host/cron/cronAgentPrompt';

const sendMessage = vi.fn();
const getAllAccounts = vi.fn();

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({ getAllAccounts, sendMessage }),
}));

const { pushCronResult } = await import('../../../src/host/cron/cronResultDelivery');

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

const feishuAccount = { id: 'account-uuid', name: '飞书 · Neo 助手', type: 'feishu' };

beforeEach(() => {
  sendMessage.mockReset();
  getAllAccounts.mockReset();
  getAllAccounts.mockReturnValue([feishuAccount]);
  sendMessage.mockResolvedValue({ success: true, messageId: 'om_1' });
});

describe('pushCronResult', () => {
  // 🔴 承重：会话 id 必须原样传给通道，不能传账号 id。原实现传 account.id，
  // 飞书实测回 230001 invalid receive_id（2026-08-24 实测），结果永远到不了群里。
  it('sends to the conversation id from the target, not the account id', async () => {
    await expect(pushCronResult(job('feishu:oc_group1'), '简报内容')).resolves.toEqual({ delivered: true, pushedBody: '简报内容' });
    expect(sendMessage).toHaveBeenCalledWith('account-uuid', 'oc_group1', '简报内容');
  });

  it('matches the account by name as well as by type', async () => {
    await pushCronResult(job('飞书 · Neo 助手:oc_group1'), '内容');
    expect(sendMessage).toHaveBeenCalledWith('account-uuid', 'oc_group1', '内容');
  });

  // 没给会话 id 时宁可不发也不猜——猜错等于把任务结果发给错误的人。
  it('refuses to guess a conversation when the target has no chat id', async () => {
    const outcome = await pushCronResult(job('feishu'), '内容');
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain('no conversation id');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reports a missing channel account instead of failing silently', async () => {
    getAllAccounts.mockReturnValue([]);
    const outcome = await pushCronResult(job('feishu:oc_group1'), '内容');
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain('not configured');
  });

  // 🔴 平台拒发（无效 receive_id / 不在出站白名单）原来被整个丢掉 ⇒
  // 「任务成功、结果没到」且零信号。返回值必须被看。
  it('surfaces a platform rejection as a failure reason', async () => {
    sendMessage.mockResolvedValue({ success: false, error: 'invalid receive_id' });
    const outcome = await pushCronResult(job('feishu:oc_group1'), '内容');
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain('invalid receive_id');
  });

  it('stays quiet when the user chose no push target', async () => {
    const outcome = await pushCronResult(job(undefined), '内容');
    expect(outcome).toEqual({ delivered: false });
    expect(outcome.reason).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('pushCronResult literal dedup against lastPushed (FB-239)', () => {
  // 字面门（免 Jev 的免费路径）：只跟「上次真推出去的」比，不是「上次跑的」。
  it('skips the push when the body is byte-identical to the last pushed body', async () => {
    const definition = job('feishu:oc_group1');
    definition.action = { ...definition.action, context: { lastPushedResult: '简报内容' } } as typeof definition.action;

    const outcome = await pushCronResult(definition, '简报内容');

    expect(outcome).toEqual({ delivered: false });
    expect(outcome.reason).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('pushes when the body differs from lastPushed by even one character', async () => {
    const definition = job('feishu:oc_group1');
    definition.action = { ...definition.action, context: { lastPushedResult: '简报内容' } } as typeof definition.action;

    const outcome = await pushCronResult(definition, '简报内容。');

    expect(outcome).toEqual({ delivered: true, pushedBody: '简报内容。' });
    expect(sendMessage).toHaveBeenCalledWith('account-uuid', 'oc_group1', '简报内容。');
  });

  // 去重状态只存在 agent action 的 context 袋里；shell/webhook 没有袋子可放，
  // 它们的推送行为保持不变（每次照推）。
  it('never dedups non-agent actions: identical bodies still push every time', async () => {
    const shellDefinition = {
      ...job('feishu:oc_group1'),
      action: { type: 'shell', command: 'echo ok' },
    } as CronJobDefinition;

    await expect(pushCronResult(shellDefinition, 'same')).resolves.toEqual({ delivered: true, pushedBody: 'same' });
    await expect(pushCronResult(shellDefinition, 'same')).resolves.toEqual({ delivered: true, pushedBody: 'same' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  // 去重键落库前按快照同一口径截断（8KB UTF-8），比较也用同一口径：
  // 超长按截断后形态比对，≤8KB 正文则「一字不差不推」严格成立。
  it('compares and stores lastPushed with the shared 8KB truncation', async () => {
    const longBody = `${'长'.repeat(CRON_AGENT_SNAPSHOT.MAX_BYTES)}尾巴`;
    const truncated = truncateUtf8Snapshot(longBody).value;
    const definition = job('feishu:oc_group1');
    definition.action = { ...definition.action, context: { lastPushedResult: truncated } } as typeof definition.action;

    const outcome = await pushCronResult(definition, longBody);

    expect(outcome).toEqual({ delivered: false });
    expect(sendMessage).not.toHaveBeenCalled();

    // 截断窗口内差一字仍照推，且写回键就是截断后的正文。
    const changedBody = `异${longBody.slice(1)}`;
    await expect(pushCronResult(definition, changedBody)).resolves.toEqual({
      delivered: true,
      pushedBody: truncateUtf8Snapshot(changedBody).value,
    });
  });
});
