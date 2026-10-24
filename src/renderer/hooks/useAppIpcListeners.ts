// ============================================================================
// useAppIpcListeners - App 级全局 IPC 事件监听
// （N-MAXLINES-MINEFIELD-2-FU1-S10 自 App.tsx 原样搬移：effect 体与依赖数组逐字保留）
// ============================================================================
import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  IPC_CHANNELS,
  type NotificationClickedEvent,
  type ToolCreateRequestEvent,
  type ConfirmActionRequest,
  type ContextHealthUpdateEvent,
} from '@shared/ipc';
import type { UserQuestionRequest, MCPElicitationRequest, MCPOAuthConsentRequest, Message } from '@shared/contract';
import type { ToolCreateRequest } from '../components/ConfirmModal';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSwarmStore } from '../stores/swarmStore';
import {
  shouldActivateSwarmScopeFromRoot,
  isSwarmSurfaceArtifact,
} from '../utils/swarmEventRouting';
import { openSurfaceForArtifact } from '../services/surfaceIntentDispatcher';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';

const logger = createLogger('App');

interface UseAppIpcListenersArgs {
  setToolCreateRequest: Dispatch<SetStateAction<ToolCreateRequest | null>>;
  setMcpElicitation: Dispatch<SetStateAction<MCPElicitationRequest | null>>;
  setMcpOAuthConsent: Dispatch<SetStateAction<MCPOAuthConsentRequest | null>>;
  setConfirmActionRequest: Dispatch<SetStateAction<ConfirmActionRequest | null>>;
  openWorkbenchTab: ReturnType<typeof useAppStore.getState>['openWorkbenchTab'];
  setTaskPanelTab: ReturnType<typeof useAppStore.getState>['setTaskPanelTab'];
}

export function useAppIpcListeners({
  setToolCreateRequest,
  setMcpElicitation,
  setMcpOAuthConsent,
  setConfirmActionRequest,
  openWorkbenchTab,
  setTaskPanelTab,
}: UseAppIpcListenersArgs): void {
  // 监听工具创建确认请求
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.SECURITY_TOOL_CREATE_REQUEST,
      (request: ToolCreateRequestEvent) => {
        logger.info('Received tool create request', { name: request.name });
        setToolCreateRequest(request);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for user question events (Gen 3+)
  // G2 拍板形态：问题进 pending 队列，由 ChatView 的打断式选项卡（遮盖 composer）
  // 渲染，不再弹全局 Modal。无 sessionId 的请求绑到当前会话，保证用户总能答到。
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.USER_QUESTION_ASK,
      (request: UserQuestionRequest) => {
        logger.info('Received user question', { id: request.id, sessionId: request.sessionId });
        const withSession = request.sessionId
          ? request
          : { ...request, sessionId: useSessionStore.getState().currentSessionId ?? undefined };
        useSessionStore.getState().addPendingUserQuestion(withSession);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for MCP elicitation events
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.MCP_ELICITATION_REQUEST,
      (request: MCPElicitationRequest) => {
        logger.info('Received MCP elicitation request', { id: request.id, server: request.serverName });
        setMcpElicitation(request);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for MCP OAuth consent events
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.MCP_OAUTH_CONSENT_REQUEST,
      (request: MCPOAuthConsentRequest) => {
        logger.info('Received MCP OAuth consent request', { id: request.requestId, server: request.serverName });
        setMcpOAuthConsent(request);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for notification click events (切换到对应会话)
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.NOTIFICATION_CLICKED,
      (event: NotificationClickedEvent) => {
        logger.info('Notification clicked, switching to session', { sessionId: event.sessionId });
        void useSessionStore.getState().switchSession(event.sessionId);
        openWorkbenchTab('task');
        setTaskPanelTab('monitor');
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [openWorkbenchTab, setTaskPanelTab]);

  // 会话级自动化回流消息：主进程写入 automation 通知后实时推过来。
  // 打开中的源会话即时 append（按消息 id 去重；created 通知的唯一发射方就是
  // host 这条广播，渲染端不再乐观插入），其他会话标记未读由侧栏徽标提示，
  // 无需等切换重载才可见。
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.SESSION_AUTOMATION_MESSAGE,
      (payload: { sessionId?: string; message?: Message }) => {
        if (!payload?.sessionId || !payload.message?.id) return;
        const message = payload.message;
        const store = useSessionStore.getState();
        if (payload.sessionId === store.currentSessionId) {
          if (!store.messages.some((m) => m.id === message.id)) {
            store.addMessage(payload.message);
          }
        } else {
          store.markSessionUnread(payload.sessionId);
        }
      }
    );
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for confirm_action events (Gen 3+)
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.CONFIRM_ACTION_ASK,
      (request: ConfirmActionRequest) => {
        logger.info('Received confirm action request', { id: request.id, title: request.title });
        setConfirmActionRequest(request);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for context health updates
  const { setContextHealth } = useAppStore();
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.CONTEXT_HEALTH_EVENT,
      (event: ContextHealthUpdateEvent) => {
        // 只更新当前会话的健康状态
        const currentSessionId = useSessionStore.getState().currentSessionId;
        if (event.sessionId === currentSessionId) {
          setContextHealth(event.health);
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [setContextHealth]);

  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.SWARM_EVENT,
      (event) => {
        const selectedSessionId = useSessionStore.getState().currentSessionId;
        const swarmState = useSwarmStore.getState();
        const shouldActivateScope = shouldActivateSwarmScopeFromRoot(
          event,
          selectedSessionId,
          swarmState,
        );
        if (isSwarmSurfaceArtifact(event)) {
          openSurfaceForArtifact({
            artifact: { kind: 'swarm-monitor' },
            artifactSessionId: event.sessionId,
          });
        }
        swarmState.handleEvent(event);
        if (shouldActivateScope) {
          useSwarmStore.getState().activateScope(event.sessionId, event.runId);
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);
}
