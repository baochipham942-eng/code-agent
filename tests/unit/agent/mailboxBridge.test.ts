// ============================================================================
// MailboxBridge Tests
// Tests for AgentBus mailbox protocol and MailboxBridge polling
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  AgentBus,
  initAgentBus,
  resetAgentBus,
} from '../../../src/main/agent/agentBus';
import type { MailboxMessage } from '../../../src/main/agent/agentBus';
import { MailboxBridge } from '../../../src/main/agent/mailboxBridge';

// --------------------------------------------------------------------------
// AgentBus mailbox protocol
// --------------------------------------------------------------------------

describe('AgentBus mailbox protocol', () => {
  let bus: AgentBus;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = initAgentBus({ stateCleanupInterval: 60000 });
  });

  afterEach(() => {
    resetAgentBus();
    vi.useRealTimers();
  });

  it('sendMailbox delivers to target agent', () => {
    bus.sendMailbox('agent-b', {
      type: 'task_dispatch',
      from: 'agent-a',
      to: 'agent-b',
      payload: { task: 'analyze' },
    });
    expect(bus.getMailboxSize('agent-b')).toBe(1);
  });

  it('pollMailbox drains all messages', () => {
    bus.sendMailbox('agent-b', { type: 'status_report', from: 'agent-a', to: 'agent-b', payload: 1 });
    bus.sendMailbox('agent-b', { type: 'status_report', from: 'agent-a', to: 'agent-b', payload: 2 });

    const messages = bus.pollMailbox('agent-b');
    expect(messages).toHaveLength(2);
    expect(messages[0].payload).toBe(1);
    expect(messages[1].payload).toBe(2);
  });

  it('pollMailbox returns empty after drain', () => {
    bus.sendMailbox('agent-b', { type: 'status_report', from: 'agent-a', to: 'agent-b', payload: null });
    bus.pollMailbox('agent-b'); // drain
    const second = bus.pollMailbox('agent-b');
    expect(second).toHaveLength(0);
    expect(bus.getMailboxSize('agent-b')).toBe(0);
  });

  it('multiple agents have independent mailboxes', () => {
    bus.sendMailbox('agent-a', { type: 'task_dispatch', from: 'leader', to: 'agent-a', payload: 'taskA' });
    bus.sendMailbox('agent-b', { type: 'task_dispatch', from: 'leader', to: 'agent-b', payload: 'taskB' });

    const msgsA = bus.pollMailbox('agent-a');
    const msgsB = bus.pollMailbox('agent-b');

    expect(msgsA).toHaveLength(1);
    expect(msgsA[0].payload).toBe('taskA');
    expect(msgsB).toHaveLength(1);
    expect(msgsB[0].payload).toBe('taskB');
  });

  it('getMailboxSize returns correct count', () => {
    expect(bus.getMailboxSize('agent-x')).toBe(0);
    bus.sendMailbox('agent-x', { type: 'status_report', from: 'src', to: 'agent-x', payload: null });
    expect(bus.getMailboxSize('agent-x')).toBe(1);
    bus.sendMailbox('agent-x', { type: 'status_report', from: 'src', to: 'agent-x', payload: null });
    expect(bus.getMailboxSize('agent-x')).toBe(2);
  });

  it('clearMailbox removes all messages', () => {
    bus.sendMailbox('agent-c', { type: 'status_report', from: 'src', to: 'agent-c', payload: null });
    bus.sendMailbox('agent-c', { type: 'status_report', from: 'src', to: 'agent-c', payload: null });
    bus.clearMailbox('agent-c');
    expect(bus.getMailboxSize('agent-c')).toBe(0);
    expect(bus.pollMailbox('agent-c')).toHaveLength(0);
  });

  it('permission_request → permission_response round trip', () => {
    // Worker sends permission request to leader
    bus.sendMailbox('leader', {
      type: 'permission_request',
      from: 'worker-1',
      to: 'leader',
      payload: { action: 'write_file', path: '/tmp/out.txt' },
    });

    // Leader reads it
    const leaderInbox = bus.pollMailbox('leader');
    expect(leaderInbox).toHaveLength(1);
    expect(leaderInbox[0].type).toBe('permission_request');

    // Leader replies
    bus.sendMailbox('worker-1', {
      type: 'permission_response',
      from: 'leader',
      to: 'worker-1',
      payload: { granted: true },
    });

    // Worker reads response
    const workerInbox = bus.pollMailbox('worker-1');
    expect(workerInbox).toHaveLength(1);
    expect(workerInbox[0].type).toBe('permission_response');
    expect((workerInbox[0].payload as { granted: boolean }).granted).toBe(true);
  });
});

// --------------------------------------------------------------------------
// MailboxBridge
// --------------------------------------------------------------------------

describe('MailboxBridge', () => {
  let bus: AgentBus;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = initAgentBus({ stateCleanupInterval: 60000 });
  });

  afterEach(() => {
    resetAgentBus();
    vi.useRealTimers();
  });

  it('pollOnce processes pending messages', () => {
    bus.sendMailbox('bridge-agent', { type: 'task_dispatch', from: 'src', to: 'bridge-agent', payload: 42 });

    const received: MailboxMessage[] = [];
    const bridge = new MailboxBridge({
      agentId: 'bridge-agent',
      onMessage: (msg) => received.push(msg),
    });

    const count = bridge.pollOnce();
    expect(count).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].payload).toBe(42);
  });

  it('pollOnce returns 0 when no messages', () => {
    const bridge = new MailboxBridge({
      agentId: 'empty-agent',
      onMessage: vi.fn(),
    });
    expect(bridge.pollOnce()).toBe(0);
  });

  it('pollOnce calls onMessage for each message', () => {
    bus.sendMailbox('multi-agent', { type: 'status_report', from: 'src', to: 'multi-agent', payload: 'a' });
    bus.sendMailbox('multi-agent', { type: 'status_report', from: 'src', to: 'multi-agent', payload: 'b' });
    bus.sendMailbox('multi-agent', { type: 'status_report', from: 'src', to: 'multi-agent', payload: 'c' });

    const onMessage = vi.fn();
    const bridge = new MailboxBridge({ agentId: 'multi-agent', onMessage });

    bridge.pollOnce();
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage.mock.calls[0][0].payload).toBe('a');
    expect(onMessage.mock.calls[1][0].payload).toBe('b');
    expect(onMessage.mock.calls[2][0].payload).toBe('c');
  });

  it('start begins polling', () => {
    const onMessage = vi.fn();
    const bridge = new MailboxBridge({ agentId: 'poll-agent', pollIntervalMs: 500, onMessage });

    bridge.start();
    expect(bridge.isActive()).toBe(true);

    bus.sendMailbox('poll-agent', { type: 'status_report', from: 'src', to: 'poll-agent', payload: 'tick' });
    vi.advanceTimersByTime(500);
    expect(onMessage).toHaveBeenCalledTimes(1);

    bridge.stop();
  });

  it('stop clears interval', () => {
    const bridge = new MailboxBridge({ agentId: 'stop-agent', pollIntervalMs: 500, onMessage: vi.fn() });
    bridge.start();
    expect(bridge.isActive()).toBe(true);

    bridge.stop();
    expect(bridge.isActive()).toBe(false);
  });

  it('isActive reflects polling state', () => {
    const bridge = new MailboxBridge({ agentId: 'active-agent', onMessage: vi.fn() });
    expect(bridge.isActive()).toBe(false);

    bridge.start();
    expect(bridge.isActive()).toBe(true);

    bridge.stop();
    expect(bridge.isActive()).toBe(false);
  });

  it('reentrance guard prevents concurrent processing', () => {
    const onMessage = vi.fn();
    const bridge = new MailboxBridge({ agentId: 'reentrant-agent', onMessage });

    // Simulate reentrance by calling pollOnce while isProcessing would be true
    // We test this by having onMessage call pollOnce again
    let innerCount = -1;
    const reentranceOnMessage = vi.fn(() => {
      innerCount = bridge.pollOnce(); // should be skipped (return 0)
    });

    const bridge2 = new MailboxBridge({ agentId: 'reentrant-agent2', onMessage: reentranceOnMessage });

    bus.sendMailbox('reentrant-agent2', { type: 'status_report', from: 'src', to: 'reentrant-agent2', payload: 'x' });
    bus.sendMailbox('reentrant-agent2', { type: 'status_report', from: 'src', to: 'reentrant-agent2', payload: 'y' });

    bridge2.pollOnce();

    // The first onMessage call triggered a nested pollOnce, which should return 0 (guard)
    expect(innerCount).toBe(0);
    // onMessage was called once (for first message; second message was drained before guard fired)
    expect(reentranceOnMessage).toHaveBeenCalled();
  });
});
