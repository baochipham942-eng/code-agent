// ============================================================================
// B3 审批 → 飞书镜像 relay 契约
// ============================================================================
// - 出站：parked 事件 → 给关联飞书会话发交互卡片（external 徽标 + 编码按钮）
// - 入站：card_action → 解码 → 对的 orchestrator.resolveParkedApproval（幂等第三口）
// - 收尾：resolved → 把卡片更新成结论（去按钮）
// - 判据：非飞书 channel session 零影响；外来按钮 value 一律忽略不误裁决
// 真机卡片交互链路由主控 dogfood（单测挡不住回调链，见 #642/A2）——这里锁住编解码与路由。
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mockChannel = {
  sendCard: vi.fn(),
  updateCard: vi.fn(),
};
const channelManager = new EventEmitter() as EventEmitter & {
  getActiveChannel: ReturnType<typeof vi.fn>;
};
channelManager.getActiveChannel = vi.fn(() => mockChannel);

const mockOrchestrator = { resolveParkedApproval: vi.fn() };
const getOrchestrator = vi.fn(() => mockOrchestrator as unknown);
const getSession = vi.fn();

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => channelManager,
}));
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({ getSession }),
}));
vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({ getOrchestrator }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

import { approvalParkEvents } from '../../../src/host/agent/approvalParkEvents';
import {
  ApprovalFeishuRelay,
  decodeApprovalValue,
} from '../../../src/host/channels/feishu/approvalFeishuRelay';

function feishuSession() {
  return {
    origin: {
      kind: 'channel',
      metadata: { channelType: 'feishu', accountId: 'acc1', chatId: 'oc_1' },
    },
  };
}

function startRelay(): ApprovalFeishuRelay {
  const relay = new ApprovalFeishuRelay();
  relay.start();
  return relay;
}

describe('decodeApprovalValue', () => {
  it('round-trips a well-formed approval button value', () => {
    const value = JSON.stringify({ t: 'apv', r: 'allow', a: 'perm-1', s: 's1' });
    expect(decodeApprovalValue(value)).toEqual({
      resolution: 'allow',
      approvalId: 'perm-1',
      sessionId: 's1',
    });
  });

  it('rejects foreign / malformed / partial values (never mis-routes a decision)', () => {
    expect(decodeApprovalValue(undefined)).toBeNull();
    expect(decodeApprovalValue(null)).toBeNull();
    expect(decodeApprovalValue('')).toBeNull();
    expect(decodeApprovalValue('not json')).toBeNull();
    expect(decodeApprovalValue(JSON.stringify({ t: 'other', r: 'allow', a: 'x', s: 'y' }))).toBeNull();
    expect(decodeApprovalValue(JSON.stringify({ t: 'apv', r: 'nope', a: 'x', s: 'y' }))).toBeNull();
    expect(decodeApprovalValue(JSON.stringify({ t: 'apv', r: 'allow', a: 'x' }))).toBeNull();
    expect(decodeApprovalValue(JSON.stringify('apv'))).toBeNull();
  });
});

describe('ApprovalFeishuRelay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalParkEvents.removeAllListeners();
    channelManager.removeAllListeners();
    channelManager.getActiveChannel = vi.fn(() => mockChannel);
    mockChannel.sendCard.mockResolvedValue({ success: true, messageId: 'om_1' });
    mockChannel.updateCard.mockResolvedValue({ success: true });
    getSession.mockResolvedValue(feishuSession());
  });

  it('parked → sends a card with an external badge and correctly-encoded buttons', async () => {
    startRelay();
    approvalParkEvents.emit('parked', {
      id: 'perm-1',
      sessionId: 's1',
      tool: 'mail_send',
      riskClass: 'external',
    });

    await vi.waitFor(() => expect(mockChannel.sendCard).toHaveBeenCalledTimes(1));
    const [chatId, text, buttons] = mockChannel.sendCard.mock.calls[0];
    expect(chatId).toBe('oc_1');
    expect(text).toContain('mail_send');
    expect(text).toContain('离开本机');
    expect(buttons).toHaveLength(2);
    expect(decodeApprovalValue(buttons[0].value)).toEqual({
      resolution: 'allow',
      approvalId: 'perm-1',
      sessionId: 's1',
    });
    expect(decodeApprovalValue(buttons[1].value)).toEqual({
      resolution: 'deny',
      approvalId: 'perm-1',
      sessionId: 's1',
    });
  });

  it('parked on a non-feishu session → no card (zero impact when Feishu is not wired)', async () => {
    getSession.mockResolvedValue({ origin: { kind: 'cron', metadata: {} } });
    startRelay();
    approvalParkEvents.emit('parked', { id: 'perm-2', sessionId: 's2', tool: 'bash', riskClass: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockChannel.sendCard).not.toHaveBeenCalled();
  });

  it('feishu button → resolves the parked approval on the matching orchestrator (idempotent third mouth)', async () => {
    startRelay();
    const value = JSON.stringify({ t: 'apv', r: 'allow', a: 'perm-9', s: 's9' });
    channelManager.emit('card_action', 'acc1', { value });

    await vi.waitFor(() =>
      expect(mockOrchestrator.resolveParkedApproval).toHaveBeenCalledWith('perm-9', 'allow'),
    );
    expect(getOrchestrator).toHaveBeenCalledWith('s9');
  });

  it('foreign card_action value → ignored, never resolves anything', async () => {
    startRelay();
    channelManager.emit('card_action', 'acc1', { value: JSON.stringify({ t: 'other' }) });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockOrchestrator.resolveParkedApproval).not.toHaveBeenCalled();
    expect(getOrchestrator).not.toHaveBeenCalled();
  });

  it('button click when the run is gone → no throw, no resolve', async () => {
    getOrchestrator.mockReturnValueOnce(undefined as unknown);
    startRelay();
    channelManager.emit('card_action', 'acc1', {
      value: JSON.stringify({ t: 'apv', r: 'deny', a: 'perm-x', s: 'sx' }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockOrchestrator.resolveParkedApproval).not.toHaveBeenCalled();
  });

  it('resolved → updates the earlier card to a buttonless verdict', async () => {
    const relay = startRelay();
    approvalParkEvents.emit('parked', { id: 'perm-3', sessionId: 's3', tool: 'mail_send', riskClass: 'external' });
    await vi.waitFor(() => expect(mockChannel.sendCard).toHaveBeenCalledTimes(1));

    approvalParkEvents.emit('resolved', { id: 'perm-3', sessionId: 's3', status: 'approved' });
    await vi.waitFor(() => expect(mockChannel.updateCard).toHaveBeenCalledTimes(1));
    const [messageId, text] = mockChannel.updateCard.mock.calls[0];
    expect(messageId).toBe('om_1');
    expect(text).toContain('已批准');
    expect(text).toContain('mail_send');
    void relay;
  });

  it('resolved for an unknown / never-mirrored approval → no card update', async () => {
    startRelay();
    approvalParkEvents.emit('resolved', { id: 'perm-unknown', sessionId: 's4', status: 'rejected' });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockChannel.updateCard).not.toHaveBeenCalled();
  });
});
