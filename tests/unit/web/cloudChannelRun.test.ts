// ============================================================================
// ADR-087 S4B：生产装配 wireChannelCloudRun（真 sqlite 账本 + CloudRunRouteRuntime）。
// - ② executeChannelRun 注入后，提升起的 channel 行从 request_json 还原载荷、
//   经桥的 runAdmittedChannelTurn 执行并收 succeeded（不落 failed）。
// - 桥缺席 / 载荷损坏：fail-closed，行收 failed 并留痕。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const runAdmittedChannelTurn = vi.hoisted(() => vi.fn());

let currentBridge: { runAdmittedChannelTurn: (payload: unknown, runId: string) => Promise<boolean> } | null = null;

vi.mock('../../../src/host/channels/channelAgentBridge', () => ({
  getChannelAgentBridge: () => currentBridge,
  initChannelAgentBridge: vi.fn(),
  ChannelAgentBridge: class {},
}));

import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { createCloudRunLedger, type CloudRunLedger } from '../../../src/host/services/cloudRun/cloudRunLedger';
import { CloudRunRouteRuntime } from '../../../src/web/routes/cloudRunRoutes';
import { channelCloudRuntimeDeps, wireChannelCloudRun } from '../../../src/web/routes/cloudChannelRun';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { setChannelCloudRunPort, getChannelCloudRunPort } from '../../../src/host/channels/channelCloudRunPort';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function channelPayloadJson(messageId = 'om_promoted'): string {
  return JSON.stringify({
    accountId: 'account-1',
    message: {
      id: messageId,
      channelId: 'feishu-1',
      sender: { id: 'sender-1', name: 'Sender' },
      context: { chatId: 'chat-9', chatType: 'p2p' },
      content: 'run me later',
      timestamp: 1,
      ingressAuth: 'paired',
    },
    partIds: [messageId],
  });
}

describe('wireChannelCloudRun production assembly', () => {
  let db: BetterSqlite3.Database;
  let ledger: CloudRunLedger;
  let runtime: CloudRunRouteRuntime;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger as unknown as Parameters<typeof applySchema>[1]);
    ledger = createCloudRunLedger({ db, accountResolver: () => 'acct_a' });
    const runRegistry = new RunRegistry();
    const wired = wireChannelCloudRun({ getLedger: () => ledger, logger: logger as never });
    runtime = new CloudRunRouteRuntime({
      getLedger: () => ledger,
      runRegistry,
      execute: async () => {},
      ...channelCloudRuntimeDeps(wired),
      logger: logger as never,
    });
    runtime.ledger(); // 挂 transition listener（生产里 admit 先经过它，这里直连账本要补挂）
    currentBridge = {
      // 假桥履约：真桥在 runAdmittedChannelTurn 内部经端口收线（channelCloudAdmission）。
      runAdmittedChannelTurn: async (payload: unknown, runId: string) => {
        runAdmittedChannelTurn(payload, runId);
        getChannelCloudRunPort()!.settle(runId, 'succeeded');
        return true;
      },
    };
    runAdmittedChannelTurn.mockClear();
    logger.error.mockClear();
  });

  afterEach(() => {
    setChannelCloudRunPort(null);
    currentBridge = null;
    db.close();
  });

  function queueBehindBusySlots(requestJson: string, channelDeliveryId: string): string {
    ledger.admit({ sessionId: 'session_busy_1', trigger: 'manual', requestJson: JSON.stringify({ prompt: 'busy1' }) });
    ledger.admit({ sessionId: 'session_busy_2', trigger: 'manual', requestJson: JSON.stringify({ prompt: 'busy2' }) });
    const admission = ledger.admit({
      sessionId: 'session_channel',
      trigger: 'channel',
      requestJson,
      channelDeliveryId,
    });
    expect(admission.record.state).toBe('queued');
    return admission.record.runId;
  }

  it('③ desktop shape: no wiring (channelCloud undefined) injects nothing into the runtime deps', () => {
    expect(channelCloudRuntimeDeps(undefined)).toEqual({});
    const wired = wireChannelCloudRun({ getLedger: () => ledger, logger: logger as never });
    expect(channelCloudRuntimeDeps(wired).executeChannelRun).toBe(wired.executeChannelRun);
  });

  it('② executes a promoted channel row from request_json through the bridge and settles succeeded', async () => {
    const runId = queueBehindBusySlots(channelPayloadJson(), 'account-1:om_promoted');

    // 释放一个槽 → 提升 → executeChannelRun 从 request_json 还原载荷交桥执行。
    const busyRow = db.prepare("SELECT run_id FROM cloud_runs WHERE \"trigger\" = 'manual' ORDER BY rowid LIMIT 1").get() as { run_id: string };
    ledger.transition(busyRow.run_id, 'succeeded');

    await vi.waitFor(() => expect(ledger.getRun(runId)?.state).toBe('succeeded'));
    expect(runAdmittedChannelTurn).toHaveBeenCalledTimes(1);
    const [payload, passedRunId] = runAdmittedChannelTurn.mock.calls[0] as [
      { accountId: string; message: { id: string }; partIds: string[] },
      string,
    ];
    expect(passedRunId).toBe(runId);
    expect(payload).toMatchObject({ accountId: 'account-1', partIds: ['om_promoted'] });
    expect(payload.message).toMatchObject({ id: 'om_promoted', content: 'run me later' });
    expect(ledger.getRun(runId)?.state).not.toBe('failed');
  });

  it('settles failed with a logged reason when no ChannelAgentBridge exists', async () => {
    currentBridge = null;
    const runId = queueBehindBusySlots(channelPayloadJson(), 'account-1:om_nobridge');

    const busyRow = db.prepare("SELECT run_id FROM cloud_runs WHERE \"trigger\" = 'manual' ORDER BY rowid LIMIT 1").get() as { run_id: string };
    ledger.transition(busyRow.run_id, 'succeeded');

    await vi.waitFor(() => expect(ledger.getRun(runId)?.state).toBe('failed'));
    expect(runAdmittedChannelTurn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('no ChannelAgentBridge'),
      expect.objectContaining({ runId }),
    );
  });

  it('settles failed when the persisted payload is corrupt and never reaches the bridge', async () => {
    const runId = queueBehindBusySlots('not json at all', 'account-1:om_corrupt');

    const busyRow = db.prepare("SELECT run_id FROM cloud_runs WHERE \"trigger\" = 'manual' ORDER BY rowid LIMIT 1").get() as { run_id: string };
    ledger.transition(busyRow.run_id, 'succeeded');

    await vi.waitFor(() => expect(ledger.getRun(runId)?.state).toBe('failed'));
    expect(runAdmittedChannelTurn).not.toHaveBeenCalled();
  });
});
