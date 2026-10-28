// initializeSessionStore 的 IPC 订阅。从 sessionStore 拆出，只留接线（max-lines）。

import type { Session, SessionStatus } from '@shared/contract';
import type { BackgroundTaskUpdateEvent } from '@shared/contract/sessionState';
import { IPC_CHANNELS, type SessionStatusUpdateEvent, type SessionUpdatedEvent } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { isTerminalRecoverySessionStatus } from '../utils/streamRecoveryMessage';
import { useAppStore } from './appStore';
import { runningBroadcastLightsTurn } from './parkedContinueTurn';
import { useSessionStore, type SessionWithMeta } from './sessionStore';
import { useStatusStore } from './statusStore';
import { useTaskStore } from './taskStore';
import { hostStampPredatesTerminal, useTerminalRunGuardStore } from './terminalRunGuardStore';
import { createTerminalStatusReconciler } from './terminalStatusReconcile';

type NormalizableSession = Session & { messageCount?: number; turnCount?: number };

// 终态广播对账（语义与宽限期见 terminalStatusReconcile.ts）：模块级单例，
// 与 streamSnapshotRehydrate 的 handler 同款接线。
const handleTerminalStatusReconcile = createTerminalStatusReconciler({
  getCurrentSessionId: () => useSessionStore.getState().currentSessionId,
  getLastMessage: () => {
    const { messages } = useSessionStore.getState();
    return messages[messages.length - 1];
  },
  reloadSession: (sessionId) => useSessionStore.getState().switchSession(sessionId, { force: true }),
  isRunActive: (sessionId) => useAppStore.getState().isSessionProcessing(sessionId),
  isTerminalStatus: (status) => isTerminalRecoverySessionStatus(status as SessionStatus | undefined),
});

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
      // 终态粘滞：记下宿主戳，拦住终局前读库的旧 load 响应与开跑时的旧 running 广播。
      useTerminalRunGuardStore.getState().markTerminal(
        sessionId,
        typeof updates?.updatedAt === 'number' ? updates.updatedAt : null,
      );
      useAppStore.getState().setSessionProcessing(sessionId, false);
      useTaskStore.getState().updateSessionState(sessionId, { status: 'idle' });
      // 对账：终局事件只走 run 响应流，流若静默失联，上面只清指示不补消息——
      // 这里挂宽限期检查，超时仍未见 assistant 终稿就走快照重灌把 DB 真相拉回页面。
      handleTerminalStatusReconcile(event);
    }

    // 宿主说开始跑了就点亮。可继续的停靠不能被更旧的 running 广播重新点亮；
    // 已应用过终局的会话，宿主戳早于终态广播的 running 是旧 run 的回声，不点亮。
    if (
      runningBroadcastLightsTurn({ updates, previous })
      && !hostStampPredatesTerminal(sessionId, updates?.updatedAt)
    ) {
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
