import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { BudgetAlertLevel, type BudgetConfig } from '../../../src/host/services/core/budgetService';
import {
  getEventBridge,
  getEventBus,
  initWebEventBridge,
  shutdownEventBus,
} from '../../../src/host/services/eventing';
import {
  kickoffWebStartupServices,
  wireBudgetService,
  wirePostHogIdentity,
  type WebStartupTaskName,
  type WebStartupTasks,
} from '../../../src/web/webStartupServices';
import {
  __resetSSEReplayBufferForTests,
  broadcastSSE,
  sseClients,
} from '../../../src/web/helpers/sse';

const TASK_NAMES: WebStartupTaskName[] = [
  'budget',
  'eventBridge',
  'comboRecorder',
  'dagEventBridge',
  'dagResolver',
  'dreamExecutor',
  'distillExecutor',
  'heartbeatService',
  'heartbeatLoader',
  'posthogIdentity',
  'logBridgeHandler',
  'fileCheckpointCleanup',
  'debugSnapshotCleanup',
  'openchronicle',
  'soulWatcher',
  'modelConsistency',
];

afterEach(() => {
  getEventBridge()?.stop();
  shutdownEventBus();
  sseClients.clear();
  __resetSSEReplayBufferForTests();
});

describe('web startup service chain', () => {
  it('dispatches every migrated registration from the single web startup entry', async () => {
    const calls = new Map<WebStartupTaskName, ReturnType<typeof vi.fn>>();
    const tasks = Object.fromEntries(TASK_NAMES.map((name) => {
      const task = vi.fn();
      calls.set(name, task);
      return [name, task];
    })) as WebStartupTasks;
    const configService = {
      getBudgetConfig: () => ({ enabled: true, maxBudget: 25 }),
      getSettings: () => ({ workspace: {} }),
    };

    kickoffWebStartupServices(configService as never, {
      broadcastSSE: vi.fn(),
      tasks,
    });
    await Promise.resolve();

    for (const name of TASK_NAMES) {
      expect(calls.get(name), `${name} must be invoked by kickoffWebStartupServices`).toHaveBeenCalledTimes(1);
    }
  });

  it('hydrates the persisted budget config and sends blocked alerts to the renderer channel', () => {
    const config: BudgetConfig = {
      enabled: true,
      maxBudget: 42,
      silentThreshold: 0.7,
      warningThreshold: 0.85,
      blockThreshold: 1,
      resetPeriodHours: 24,
    };
    let listener: ((status: {
      alertLevel: BudgetAlertLevel;
      currentCost: number;
      maxBudget: number;
      usagePercentage: number;
      message?: string;
    }) => void) | null = null;
    const initBudget = vi.fn(() => ({
      setAlertListener(next: typeof listener) {
        listener = next;
      },
    }));
    const push = vi.fn();

    wireBudgetService(
      { getBudgetConfig: () => config },
      push,
      { initBudgetService: initBudget as never },
    );

    expect(initBudget).toHaveBeenCalledWith(config);
    expect(listener).not.toBeNull();
    listener?.({
      alertLevel: BudgetAlertLevel.BLOCKED,
      currentCost: 42,
      maxBudget: 42,
      usagePercentage: 1,
      message: 'blocked',
    });
    expect(push).toHaveBeenCalledWith(IPC_CHANNELS.BUDGET_ALERT, {
      level: 'blocked',
      currentCost: 42,
      maxBudget: 42,
      usagePercentage: 1,
      message: 'blocked',
    });
  });

  it('forwards a real EventBus event through the SSE broadcast layer', () => {
    const chunks: string[] = [];
    const client = {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    };
    sseClients.add(client as unknown as Response);
    initWebEventBridge(broadcastSSE).start();

    getEventBus().publish(
      'agent',
      'combo_skill_suggestion',
      { suggestedName: 'review-flow' },
      { sessionId: 'session-1' },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('"channel":"agent:event"');
    expect(chunks[0]).toContain('"type":"combo_skill_suggestion"');
    expect(chunks[0]).toContain('"sessionId":"session-1"');
  });

  it('reconciles the restored PostHog identity and keeps Node + renderer in sync', () => {
    const callbacks: Array<(user: { id: string } | null) => void> = [];
    const authService = {
      getCurrentUser: () => ({ id: 'raw-user-id' }),
      addAuthChangeCallback(callback: (user: { id: string } | null) => void) {
        callbacks.push(callback);
      },
    };
    const setCurrentDistinctId = vi.fn();
    const identifyNode = vi.fn();
    const push = vi.fn();

    wirePostHogIdentity(authService as never, {
      getDistinctId: (userId) => `hashed:${userId}`,
      setCurrentDistinctId,
      identifyNode,
      broadcastSSE: push,
    });

    expect(setCurrentDistinctId).toHaveBeenCalledWith('hashed:raw-user-id');
    expect(identifyNode).toHaveBeenCalledWith('hashed:raw-user-id');
    expect(push).toHaveBeenCalledWith(IPC_CHANNELS.POSTHOG_IDENTITY, {
      distinctId: 'hashed:raw-user-id',
    });

    callbacks[0](null);
    expect(setCurrentDistinctId).toHaveBeenLastCalledWith(null);
    expect(push).toHaveBeenLastCalledWith(IPC_CHANNELS.POSTHOG_IDENTITY, {
      distinctId: null,
    });
  });
});
