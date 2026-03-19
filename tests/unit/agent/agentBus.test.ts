// ============================================================================
// AgentBus Tests
// Tests for pub/sub, shared state, request-response, history, and lifecycle
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

import { AgentBus, resetAgentBus, getAgentBus, initAgentBus } from '../../../src/main/agent/agentBus';
import type { AgentMessage } from '../../../src/main/agent/agentBus';

describe('AgentBus', () => {
  let bus: AgentBus;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new AgentBus({
      stateCleanupInterval: 60000, // 60s to avoid interference
      enableHistory: true,
      maxQueueSize: 100,
      messageRetention: 300000,
      defaultRequestTimeout: 5000,
    });
  });

  afterEach(() => {
    bus.dispose();
    vi.useRealTimers();
  });

  // ==========================================================================
  // Publish / Subscribe
  // ==========================================================================

  describe('subscribe / publish', () => {
    it('should deliver messages to subscribers on the same channel', async () => {
      const handler = vi.fn();
      bus.subscribe('agent-b', 'tasks', handler);

      await bus.publish('agent-a', 'tasks', { action: 'build' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload).toEqual({ action: 'build' });
    });

    it('should not deliver messages to the sender itself', async () => {
      const handler = vi.fn();
      bus.subscribe('agent-a', 'tasks', handler);

      await bus.publish('agent-a', 'tasks', { action: 'build' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not deliver messages to subscribers on a different channel', async () => {
      const handler = vi.fn();
      bus.subscribe('agent-b', 'other-channel', handler);

      await bus.publish('agent-a', 'tasks', { action: 'build' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should deliver to multiple subscribers on the same channel', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.subscribe('agent-b', 'tasks', handler1);
      bus.subscribe('agent-c', 'tasks', handler2);

      await bus.publish('agent-a', 'tasks', { action: 'build' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should return a valid message with all fields populated', async () => {
      const msg = await bus.publish('agent-a', 'tasks', 'hello', {
        type: 'broadcast',
        priority: 'high',
        metadata: { source: 'test' },
      });

      expect(msg.id).toMatch(/^msg-/);
      expect(msg.from).toBe('agent-a');
      expect(msg.channel).toBe('tasks');
      expect(msg.payload).toBe('hello');
      expect(msg.type).toBe('broadcast');
      expect(msg.priority).toBe('high');
      expect(msg.metadata).toEqual({ source: 'test' });
      expect(msg.timestamp).toBeTypeOf('number');
    });

    it('should return unique subscription IDs', () => {
      const id1 = bus.subscribe('agent-a', 'ch', vi.fn());
      const id2 = bus.subscribe('agent-b', 'ch', vi.fn());
      expect(id1).not.toBe(id2);
    });
  });

  // ==========================================================================
  // Event Filtering
  // ==========================================================================

  describe('message filtering', () => {
    it('should apply subscriber filter function', async () => {
      const handler = vi.fn();
      bus.subscribe('agent-b', 'tasks', handler, (msg) => msg.priority === 'urgent');

      await bus.publish('agent-a', 'tasks', 'low-prio', { priority: 'low' });
      expect(handler).not.toHaveBeenCalled();

      await bus.publish('agent-a', 'tasks', 'urgent-msg', { priority: 'urgent' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should deliver directed messages only to the target agent', async () => {
      const handlerB = vi.fn();
      const handlerC = vi.fn();
      bus.subscribe('agent-b', 'tasks', handlerB);
      bus.subscribe('agent-c', 'tasks', handlerC);

      await bus.publish('agent-a', 'tasks', 'private', { to: 'agent-b' });

      expect(handlerB).toHaveBeenCalledTimes(1);
      expect(handlerC).not.toHaveBeenCalled();
    });

    it('should handle errors in subscriber handlers gracefully', async () => {
      const errorHandler = vi.fn(() => { throw new Error('boom'); });
      const normalHandler = vi.fn();
      bus.subscribe('agent-b', 'ch', errorHandler);
      bus.subscribe('agent-c', 'ch', normalHandler);

      // Publish urgent to await all handlers
      await bus.publish('agent-a', 'ch', 'data', { priority: 'urgent' });

      expect(errorHandler).toHaveBeenCalledTimes(1);
      // Normal handler should still be called despite errorHandler throwing
      expect(normalHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Multi-session Isolation
  // ==========================================================================

  describe('multi-session isolation', () => {
    it('should isolate channels — subscribers only receive messages from their channel', async () => {
      const session1Handler = vi.fn();
      const session2Handler = vi.fn();
      bus.subscribe('agent-s1', 'session-1', session1Handler);
      bus.subscribe('agent-s2', 'session-2', session2Handler);

      await bus.publish('agent-a', 'session-1', 'msg-for-s1');
      await bus.publish('agent-a', 'session-2', 'msg-for-s2');

      expect(session1Handler).toHaveBeenCalledTimes(1);
      expect(session1Handler.mock.calls[0][0].payload).toBe('msg-for-s1');
      expect(session2Handler).toHaveBeenCalledTimes(1);
      expect(session2Handler.mock.calls[0][0].payload).toBe('msg-for-s2');
    });

    it('should isolate shared state by key namespace', () => {
      bus.setState('session:1:data', { count: 1 }, 'agent-1');
      bus.setState('session:2:data', { count: 2 }, 'agent-2');

      expect(bus.getState('session:1:data')).toEqual({ count: 1 });
      expect(bus.getState('session:2:data')).toEqual({ count: 2 });
    });
  });

  // ==========================================================================
  // Unsubscribe
  // ==========================================================================

  describe('unsubscribe', () => {
    it('should stop delivering messages after unsubscribe', async () => {
      const handler = vi.fn();
      const subId = bus.subscribe('agent-b', 'tasks', handler);

      await bus.publish('agent-a', 'tasks', 'msg1');
      expect(handler).toHaveBeenCalledTimes(1);

      bus.unsubscribe(subId);
      await bus.publish('agent-a', 'tasks', 'msg2');
      expect(handler).toHaveBeenCalledTimes(1); // still 1
    });

    it('should return true when unsubscribing an existing subscription', () => {
      const subId = bus.subscribe('agent-b', 'tasks', vi.fn());
      expect(bus.unsubscribe(subId)).toBe(true);
    });

    it('should return false when unsubscribing a non-existent subscription', () => {
      expect(bus.unsubscribe('nonexistent-sub-id')).toBe(false);
    });

    it('should remove all subscriptions for an agent via unsubscribeAll', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.subscribe('agent-b', 'ch1', handler1);
      bus.subscribe('agent-b', 'ch2', handler2);

      const count = bus.unsubscribeAll('agent-b');
      expect(count).toBe(2);

      await bus.publish('agent-a', 'ch1', 'test');
      await bus.publish('agent-a', 'ch2', 'test');
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should return 0 when unsubscribeAll for unknown agent', () => {
      const count = bus.unsubscribeAll('nonexistent-agent');
      expect(count).toBe(0);
    });
  });

  // ==========================================================================
  // Shared State
  // ==========================================================================

  describe('shared state', () => {
    it('should set and get state', () => {
      bus.setState('key1', 'value1', 'agent-a');
      expect(bus.getState('key1')).toBe('value1');
    });

    it('should return undefined for non-existent key', () => {
      expect(bus.getState('nonexistent')).toBeUndefined();
    });

    it('should increment version on update', () => {
      bus.setState('key1', 'v1', 'agent-a');
      const entry1 = bus.getStateEntry('key1');
      expect(entry1?.version).toBe(1);

      bus.setState('key1', 'v2', 'agent-a');
      const entry2 = bus.getStateEntry('key1');
      expect(entry2?.version).toBe(2);
    });

    it('should throw when modifying readonly state from non-owner', () => {
      bus.setState('key1', 'value', 'owner-agent', { readonly: true });

      expect(() => {
        bus.setState('key1', 'new-value', 'other-agent');
      }).toThrow('Cannot modify readonly state');
    });

    it('should allow owner to modify their own readonly state', () => {
      bus.setState('key1', 'value', 'owner-agent', { readonly: true });
      bus.setState('key1', 'updated', 'owner-agent');
      expect(bus.getState('key1')).toBe('updated');
    });

    it('should expire state after TTL', () => {
      bus.setState('temp', 'data', 'agent-a', { ttl: 5000 });
      expect(bus.getState('temp')).toBe('data');

      vi.advanceTimersByTime(6000);
      expect(bus.getState('temp')).toBeUndefined();
    });

    it('should delete state and emit event', () => {
      const deleteHandler = vi.fn();
      bus.on('state:delete', deleteHandler);

      bus.setState('key1', 'value', 'agent-a');
      const result = bus.deleteState('key1', 'agent-a');

      expect(result).toBe(true);
      expect(bus.getState('key1')).toBeUndefined();
      expect(deleteHandler).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'key1', deletedBy: 'agent-a' })
      );
    });

    it('should throw when deleting readonly state from non-owner', () => {
      bus.setState('key1', 'value', 'owner', { readonly: true });
      expect(() => bus.deleteState('key1', 'other')).toThrow('Cannot delete readonly state');
    });

    it('should return false when deleting non-existent state', () => {
      expect(bus.deleteState('nonexistent', 'agent-a')).toBe(false);
    });

    it('should get all states for a specific agent', () => {
      bus.setState('a1', 'v1', 'agent-a');
      bus.setState('a2', 'v2', 'agent-a');
      bus.setState('b1', 'v3', 'agent-b');

      const states = bus.getAgentStates('agent-a');
      expect(states).toHaveLength(2);
      expect(states.map(s => s.key).sort()).toEqual(['a1', 'a2']);
    });

    it('should get states matching a pattern', () => {
      bus.setState('task:1', 'data1', 'agent-a');
      bus.setState('task:2', 'data2', 'agent-a');
      bus.setState('config:x', 'data3', 'agent-a');

      const taskStates = bus.getStates(/^task:/);
      expect(taskStates.size).toBe(2);
    });
  });

  // ==========================================================================
  // State Watch
  // ==========================================================================

  describe('watchState', () => {
    it('should notify watcher on state change', () => {
      const watcher = vi.fn();
      bus.watchState('key1', watcher);

      bus.setState('key1', 'value', 'agent-a');

      expect(watcher).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'key1',
          newValue: 'value',
          changedBy: 'agent-a',
          version: 1,
        })
      );
    });

    it('should unwatch when returned disposer is called', () => {
      const watcher = vi.fn();
      const dispose = bus.watchState('key1', watcher);

      bus.setState('key1', 'v1', 'agent-a');
      expect(watcher).toHaveBeenCalledTimes(1);

      dispose();
      bus.setState('key1', 'v2', 'agent-a');
      expect(watcher).toHaveBeenCalledTimes(1); // still 1
    });
  });

  // ==========================================================================
  // History & Stats
  // ==========================================================================

  describe('history', () => {
    it('should record messages in history', async () => {
      await bus.publish('a', 'ch1', 'msg1');
      await bus.publish('a', 'ch2', 'msg2');

      const history = bus.getHistory();
      expect(history).toHaveLength(2);
    });

    it('should filter history by channel', async () => {
      await bus.publish('a', 'ch1', 'msg1');
      await bus.publish('a', 'ch2', 'msg2');
      await bus.publish('a', 'ch1', 'msg3');

      const history = bus.getHistory({ channel: 'ch1' });
      expect(history).toHaveLength(2);
    });

    it('should filter history by sender', async () => {
      await bus.publish('a', 'ch', 'msg1');
      await bus.publish('b', 'ch', 'msg2');

      const history = bus.getHistory({ from: 'a' });
      expect(history).toHaveLength(1);
    });

    it('should filter history by message type', async () => {
      await bus.publish('a', 'ch', 'p1', { type: 'progress' });
      await bus.publish('a', 'ch', 'e1', { type: 'error' });

      const history = bus.getHistory({ type: 'error' });
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('error');
    });

    it('should limit history results', async () => {
      for (let i = 0; i < 10; i++) {
        await bus.publish('a', 'ch', `msg${i}`);
      }

      const history = bus.getHistory({ limit: 3 });
      expect(history).toHaveLength(3);
    });

    it('should not record history when enableHistory is false', async () => {
      bus.dispose();
      bus = new AgentBus({
        enableHistory: false,
        stateCleanupInterval: 60000,
      });

      await bus.publish('a', 'ch', 'msg1');
      expect(bus.getHistory()).toHaveLength(0);
    });

    it('should enforce maxQueueSize on history', async () => {
      bus.dispose();
      bus = new AgentBus({
        maxQueueSize: 3,
        enableHistory: true,
        stateCleanupInterval: 60000,
      });

      for (let i = 0; i < 5; i++) {
        await bus.publish('a', 'ch', `msg${i}`);
      }

      expect(bus.getHistory()).toHaveLength(3);
    });
  });

  describe('stats', () => {
    it('should report correct statistics', async () => {
      bus.subscribe('b', 'ch1', vi.fn());
      bus.subscribe('c', 'ch1', vi.fn());
      bus.subscribe('d', 'ch2', vi.fn());
      bus.setState('k1', 'v1', 'a');

      await bus.publish('a', 'ch1', 'msg1');

      const stats = bus.getStats();
      expect(stats.totalMessages).toBe(1);
      expect(stats.totalSubscribers).toBe(3);
      expect(stats.totalStates).toBe(1);
      expect(stats.messagesByChannel).toEqual({ ch1: 1 });
      expect(stats.subscribersByChannel).toEqual({ ch1: 2, ch2: 1 });
      expect(stats.pendingRequests).toBe(0);
    });
  });

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  describe('convenience methods', () => {
    it('broadcastDiscovery should publish to discoveries channel and set state', async () => {
      const handler = vi.fn();
      bus.subscribe('agent-b', 'discoveries', handler);

      await bus.broadcastDiscovery('agent-a', {
        type: 'file',
        content: 'Found important file',
        confidence: 0.9,
      });

      expect(handler).toHaveBeenCalledTimes(1);
      // State should also be set with discovery prefix
      const states = bus.getStates(/^discovery:agent-a/);
      expect(states.size).toBe(1);
    });

    it('reportProgress should publish to progress channel and update state', async () => {
      const handler = vi.fn();
      bus.subscribe('agent-b', 'progress', handler);

      await bus.reportProgress('agent-a', {
        iteration: 3,
        maxIterations: 10,
        status: 'running',
        percentage: 30,
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(bus.getState('progress:agent-a')).toEqual({
        iteration: 3,
        maxIterations: 10,
        status: 'running',
        percentage: 30,
      });
    });

    it('reportError should publish to errors channel with correct priority', async () => {
      const handler = vi.fn();
      bus.subscribe('agent-b', 'errors', handler);

      await bus.reportError('agent-a', { message: 'fatal crash', fatal: true });

      expect(handler).toHaveBeenCalledTimes(1);
      const msg: AgentMessage = handler.mock.calls[0][0];
      expect(msg.priority).toBe('urgent');
    });

    it('notifyComplete should publish to completions channel and set state', async () => {
      const handler = vi.fn();
      bus.subscribe('agent-b', 'completions', handler);

      await bus.notifyComplete('agent-a', { success: true, summary: 'Done' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(bus.getState('complete:agent-a')).toEqual({ success: true, summary: 'Done' });
    });
  });

  // ==========================================================================
  // EventEmitter integration
  // ==========================================================================

  describe('EventEmitter events', () => {
    it('should emit "message" event on publish', async () => {
      const emitHandler = vi.fn();
      bus.on('message', emitHandler);

      await bus.publish('a', 'ch', 'payload');

      expect(emitHandler).toHaveBeenCalledTimes(1);
      expect(emitHandler.mock.calls[0][0].channel).toBe('ch');
    });

    it('should emit "message:<channel>" event on publish', async () => {
      const emitHandler = vi.fn();
      bus.on('message:tasks', emitHandler);

      await bus.publish('a', 'tasks', 'data');

      expect(emitHandler).toHaveBeenCalledTimes(1);
    });

    it('should emit "state:change" event on setState', () => {
      const changeHandler = vi.fn();
      bus.on('state:change', changeHandler);

      bus.setState('k', 'v', 'a');

      expect(changeHandler).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'k', newValue: 'v' })
      );
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe('lifecycle', () => {
    it('dispose should clear all internal state', async () => {
      bus.subscribe('b', 'ch', vi.fn());
      bus.setState('k', 'v', 'a');
      await bus.publish('a', 'ch', 'msg');

      bus.dispose();

      expect(bus.getHistory()).toHaveLength(0);
      expect(bus.getState('k')).toBeUndefined();
      const stats = bus.getStats();
      expect(stats.totalSubscribers).toBe(0);
      expect(stats.totalStates).toBe(0);
    });

    it('reset should clear data without stopping cleanup interval', () => {
      bus.subscribe('b', 'ch', vi.fn());
      bus.setState('k', 'v', 'a');

      bus.reset();

      const stats = bus.getStats();
      expect(stats.totalSubscribers).toBe(0);
      expect(stats.totalStates).toBe(0);
      expect(stats.totalMessages).toBe(0);
    });
  });

  // ==========================================================================
  // Singleton helpers
  // ==========================================================================

  describe('singleton helpers', () => {
    afterEach(() => {
      resetAgentBus();
    });

    it('getAgentBus should return the same instance', () => {
      const bus1 = getAgentBus();
      const bus2 = getAgentBus();
      expect(bus1).toBe(bus2);
    });

    it('initAgentBus should replace the singleton', () => {
      const bus1 = getAgentBus();
      const bus2 = initAgentBus({ maxQueueSize: 50 });
      expect(bus2).not.toBe(bus1);
      expect(getAgentBus()).toBe(bus2);
    });

    it('resetAgentBus should clear the singleton', () => {
      const bus1 = getAgentBus();
      resetAgentBus();
      const bus2 = getAgentBus();
      expect(bus2).not.toBe(bus1);
    });
  });
});
