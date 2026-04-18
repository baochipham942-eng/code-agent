import { useCallback } from 'react';
import { create } from 'zustand';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSkillStore } from '../stores/skillStore';
import { requestMcpStatusReload } from './useMcpStatus';
import ipcService from '../services/ipcService';
import type { WorkbenchCapabilityRegistryItem } from '../utils/workbenchCapabilityRegistry';
import {
  runWorkbenchCapabilityQuickAction,
  type WorkbenchQuickAction,
  type WorkbenchQuickActionCompletion,
} from '../utils/workbenchQuickActions';

const QUICK_ACTION_FEEDBACK_TTL_MS = 10_000;
const GLOBAL_QUICK_ACTION_SESSION_KEY = '__global__';
const EMPTY_ACTION_ERRORS = Object.freeze({}) as Record<string, string>;
const EMPTY_COMPLETED_ACTIONS = Object.freeze({}) as Record<string, WorkbenchQuickActionCompletion>;

interface WorkbenchCapabilityQuickActionState {
  runningActionKeys: Record<string, string | null>;
  actionErrorsBySession: Record<string, Record<string, string>>;
  completedActionsBySession: Record<string, Record<string, WorkbenchQuickActionCompletion>>;
  setRunningActionKey: (sessionKey: string, value: string | null) => void;
  clearActionError: (sessionKey: string, capabilityKey: string) => void;
  setActionError: (sessionKey: string, capabilityKey: string, message: string) => void;
  setCompletedAction: (
    sessionKey: string,
    capabilityKey: string,
    completion: WorkbenchQuickActionCompletion,
  ) => void;
  clearCompletedAction: (sessionKey: string, capabilityKey: string) => void;
  reset: () => void;
}

const useWorkbenchCapabilityQuickActionState = create<WorkbenchCapabilityQuickActionState>((set) => ({
  runningActionKeys: {},
  actionErrorsBySession: {},
  completedActionsBySession: {},
  setRunningActionKey: (sessionKey, value) => set((state) => ({
    runningActionKeys: {
      ...state.runningActionKeys,
      [sessionKey]: value,
    },
  })),
  clearActionError: (sessionKey, capabilityKey) => set((state) => {
    const currentSessionErrors = state.actionErrorsBySession[sessionKey];
    if (!currentSessionErrors || !(capabilityKey in currentSessionErrors)) {
      return state;
    }

    const nextSessionErrors = { ...currentSessionErrors };
    delete nextSessionErrors[capabilityKey];

    return {
      actionErrorsBySession: {
        ...state.actionErrorsBySession,
        [sessionKey]: nextSessionErrors,
      },
    };
  }),
  setActionError: (sessionKey, capabilityKey, message) => set((state) => ({
    actionErrorsBySession: {
      ...state.actionErrorsBySession,
      [sessionKey]: {
        ...(state.actionErrorsBySession[sessionKey] || {}),
        [capabilityKey]: message,
      },
    },
  })),
  setCompletedAction: (sessionKey, capabilityKey, completion) => set((state) => ({
    completedActionsBySession: {
      ...state.completedActionsBySession,
      [sessionKey]: {
        ...(state.completedActionsBySession[sessionKey] || {}),
        [capabilityKey]: completion,
      },
    },
  })),
  clearCompletedAction: (sessionKey, capabilityKey) => set((state) => {
    const currentSessionCompletions = state.completedActionsBySession[sessionKey];
    if (!currentSessionCompletions || !(capabilityKey in currentSessionCompletions)) {
      return state;
    }

    const nextSessionCompletions = { ...currentSessionCompletions };
    delete nextSessionCompletions[capabilityKey];

    return {
      completedActionsBySession: {
        ...state.completedActionsBySession,
        [sessionKey]: nextSessionCompletions,
      },
    };
  }),
  reset: () => set({
    runningActionKeys: {},
    actionErrorsBySession: {},
    completedActionsBySession: {},
  }),
}));

const completionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getQuickActionSessionKey(sessionId: string | null | undefined): string {
  return sessionId || GLOBAL_QUICK_ACTION_SESSION_KEY;
}

function getQuickActionCompletionTimerKey(sessionKey: string, capabilityKey: string): string {
  return `${sessionKey}:${capabilityKey}`;
}

function scheduleCompletionClear(sessionKey: string, capabilityKey: string) {
  const timerKey = getQuickActionCompletionTimerKey(sessionKey, capabilityKey);
  const existing = completionTimers.get(timerKey);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    useWorkbenchCapabilityQuickActionState.getState().clearCompletedAction(sessionKey, capabilityKey);
    completionTimers.delete(timerKey);
  }, QUICK_ACTION_FEEDBACK_TTL_MS);

  completionTimers.set(timerKey, timer);
}

export function __resetWorkbenchCapabilityQuickActionStateForTests(): void {
  completionTimers.forEach((timer) => clearTimeout(timer));
  completionTimers.clear();
  useWorkbenchCapabilityQuickActionState.getState().reset();
}

export function __getWorkbenchCapabilityQuickActionSessionStateForTests(
  sessionId: string | null,
): Pick<WorkbenchCapabilityQuickActionRunner, 'runningActionKey' | 'actionErrors' | 'completedActions'> {
  const sessionKey = getQuickActionSessionKey(sessionId);
  const state = useWorkbenchCapabilityQuickActionState.getState();
  return {
    runningActionKey: state.runningActionKeys[sessionKey] ?? null,
    actionErrors: state.actionErrorsBySession[sessionKey] ?? {},
    completedActions: state.completedActionsBySession[sessionKey] ?? {},
  };
}

export interface WorkbenchCapabilityQuickActionRunner {
  runningActionKey: string | null;
  actionErrors: Record<string, string>;
  completedActions: Record<string, WorkbenchQuickActionCompletion>;
  runQuickAction: (
    capability: WorkbenchCapabilityRegistryItem,
    action: WorkbenchQuickAction,
  ) => Promise<void>;
}

export function useWorkbenchCapabilityQuickActionRunner(): WorkbenchCapabilityQuickActionRunner {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const mountSkill = useSkillStore((state) => state.mountSkill);
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const sessionKey = getQuickActionSessionKey(currentSessionId);
  const runningActionKey = useWorkbenchCapabilityQuickActionState((state) => state.runningActionKeys[sessionKey] ?? null);
  const actionErrors = useWorkbenchCapabilityQuickActionState((state) => state.actionErrorsBySession[sessionKey] ?? EMPTY_ACTION_ERRORS);
  const completedActions = useWorkbenchCapabilityQuickActionState((state) => state.completedActionsBySession[sessionKey] ?? EMPTY_COMPLETED_ACTIONS);

  const runQuickAction = useCallback(async (
    capability: WorkbenchCapabilityRegistryItem,
    action: WorkbenchQuickAction,
  ) => {
    const nextSessionKey = getQuickActionSessionKey(currentSessionId);
    const store = useWorkbenchCapabilityQuickActionState.getState();
    const actionKey = `${capability.key}:${action.kind}`;
    const timerKey = getQuickActionCompletionTimerKey(nextSessionKey, capability.key);

    store.setRunningActionKey(nextSessionKey, actionKey);
    store.clearActionError(nextSessionKey, capability.key);
    store.clearCompletedAction(nextSessionKey, capability.key);

    const existing = completionTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
      completionTimers.delete(timerKey);
    }

    try {
      const completed = await runWorkbenchCapabilityQuickAction(capability, action, {
        mountSkill,
        openSettingsTab,
        reconnectMcpServer: async (serverName) => {
          const result = await ipcService.invokeDomain<{ success: boolean; error?: string }>(
            IPC_DOMAINS.MCP,
            'reconnectServer',
            { serverName },
          );
          if (!result?.success) {
            throw new Error(result?.error || `${serverName} 重连失败`);
          }
          return true;
        },
        refreshMcpStatus: requestMcpStatusReload,
      });

      if (!completed) {
        useWorkbenchCapabilityQuickActionState
          .getState()
          .setActionError(nextSessionKey, capability.key, '这个动作没有执行成功，请检查设置后再试。');
        return;
      }

      useWorkbenchCapabilityQuickActionState
        .getState()
        .setCompletedAction(nextSessionKey, capability.key, {
          kind: action.kind,
          completedAt: Date.now(),
        });
      scheduleCompletionClear(nextSessionKey, capability.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : '动作执行失败';
      useWorkbenchCapabilityQuickActionState
        .getState()
        .setActionError(nextSessionKey, capability.key, message);
    } finally {
      useWorkbenchCapabilityQuickActionState
        .getState()
        .setRunningActionKey(nextSessionKey, null);
    }
  }, [currentSessionId, mountSkill, openSettingsTab]);

  return {
    runningActionKey,
    actionErrors,
    completedActions,
    runQuickAction,
  };
}
