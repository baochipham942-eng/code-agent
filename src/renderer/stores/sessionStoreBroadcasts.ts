// initializeSessionStore 的 IPC 订阅。从 sessionStore 拆出，只留接线（max-lines）。

import type { Session } from '@shared/contract';
import type { BackgroundTaskUpdateEvent } from '@shared/contract/sessionState';
import { IPC_CHANNELS, type SessionStatusUpdateEvent, type SessionUpdatedEvent } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { isTerminalRecoverySessionStatus } from '../utils/streamRecoveryMessage';
import { useAppStore } from './appStore';
import { runningBroadcastLightsTurn } from './parkedContinueTurn';
import { useSessionStore, type SessionWithMeta } from './sessionStore';
import { useStatusStore } from './statusStore';
import { useTaskStore } from './taskStore';

type NormalizableSession = Session & { messageCount?: number; turnCount?: number };

export async function bindInitializedSessionBroadcasts(
  normalize: (session: NormalizableSession) => SessionWithMeta,
): Promise<void> {
  ipcService.on(IPC_CHANNELS.SESSION_UPDATED, (event: SessionUpdatedEvent) => {
    const { sessionId, updates } = event;
    const previous = useSessionStore.getState().sessions.find((session) => session.id === sessionId);
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => (
        session.id === sessionId
          ? normalize({ ...session, ...updates })
          : session
      )),
    }));

    // run 收尾时宿主一定会广播一次带终态的 session:updated（AgentRunController.updateSessionStatus），
    // 而且是全局广播、不挑连接——这是「刷新后接回来的运行态」唯一的出口。没有它，
    // switchSession 里按 activeRun 点亮的运行态会永远亮着（那一轮的 SSE 已经跟着旧页面断了，
    // agent_complete 到不了这个新页面）。
    if (isTerminalRecoverySessionStatus(updates?.status)) {
      useAppStore.getState().setSessionProcessing(sessionId, false);
      useTaskStore.getState().updateSessionState(sessionId, { status: 'idle' });
    }

    // 宿主说开始跑了就点亮。可继续的停靠不能被更旧的 running 广播重新点亮。
    if (runningBroadcastLightsTurn({ updates, previous })) {
      useAppStore.getState().setSessionProcessing(sessionId, true);
      useTaskStore.getState().updateSessionState(sessionId, { status: 'running' });
    }

    if (useSessionStore.getState().currentSessionId === sessionId && updates.workingDirectory !== undefined) {
      useAppStore.getState().setWorkingDirectory(updates.workingDirectory ?? null);
    }
  });

  ipcService.on(IPC_CHANNELS.SESSION_LIST_UPDATED, () => {
    void useSessionStore.getState().loadSessions({ silent: true });
  });

  ipcService.on(IPC_CHANNELS.WORKSPACE_CURRENT_CHANGED, (event: { dir: string | null }) => {
    useAppStore.getState().setWorkingDirectory(event.dir ?? null);
  });

  ipcService.on(IPC_CHANNELS.SESSION_STATUS_UPDATE, (event: SessionStatusUpdateEvent) => {
    useSessionStore.getState().updateSessionRuntime(event);
  });

  ipcService.on(IPC_CHANNELS.BACKGROUND_TASK_UPDATE, (event: BackgroundTaskUpdateEvent) => {
    useSessionStore.getState().updateBackgroundTask(event);
  });

  ipcService.on(IPC_CHANNELS.STATUS_CONTEXT_UPDATE, (event: { percent: number }) => {
    useStatusStore.getState().setContextUsage(event.percent);
  });
  ipcService.on(IPC_CHANNELS.STATUS_GIT_UPDATE, (event: { branch: string | null; changes: { staged: number; unstaged: number; untracked: number } | null }) => {
    useStatusStore.getState().setGitInfo(event.branch, useStatusStore.getState().workingDirectory);
    useStatusStore.getState().setGitChanges(event.changes);
  });

  try {
    const backgroundSessions = await ipcService.invoke(IPC_CHANNELS.BACKGROUND_GET_TASKS);
    if (backgroundSessions && backgroundSessions.length > 0) {
      useSessionStore.setState({ backgroundSessions });
    }
  } catch {
    // ignore
  }
}
