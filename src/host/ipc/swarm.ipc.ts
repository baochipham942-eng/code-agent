// ============================================================================
// Swarm IPC - Agent Swarm 事件推送到渲染进程
// ============================================================================

import { AppWindow, ipcHost } from '../platform';
import { randomUUID } from 'crypto';
import {
  createScopedSwarmMessageId,
  isSameSwarmRun,
  parseScopedSwarmAgentId,
  type SwarmAgentRef,
  type SwarmEvent,
  type SwarmRunRef,
  type SwarmRunScope,
} from '../../shared/contract/swarm';
import type { CompletedAgentRun } from '../../shared/contract/agentHistory';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type { Message } from '../../shared/contract';
import type { SwarmRunDetail } from '../../shared/contract/swarmTrace';
import { getSwarmServices } from '../agent/swarmServices';
import { getSwarmEventEmitter } from '../agent/swarmEventPublisher';
import { createLogger } from '../services/infra/logger';
import { getSessionManager } from '../services';
import { getEventBus } from '../services/eventing/bus';
import { SWARM_TRACE } from '../../shared/constants/storage';

const logger = createLogger('SwarmIPC');

// ============================================================================
// Swarm 事件回调注册（CLI 模式使用）
// ============================================================================

type SwarmEventListener = (event: SwarmEvent) => void;
const swarmEventListeners: SwarmEventListener[] = [];

interface SwarmSendUserMessagePayload {
  sessionId: string;
  runId: string;
  agentId: string;
  message: string;
  messageId?: string;
  timestamp?: number;
  metadata?: Message['metadata'];
}

function buildPersistedUserMessage(
  payload: SwarmSendUserMessagePayload,
  scope: SwarmRunScope,
  targetAgentIds: string[],
): Message {
  const sourceId = payload.messageId || randomUUID();
  const workbench = payload.metadata?.workbench
    ? { ...payload.metadata.workbench, targetAgentIds: [...targetAgentIds] }
    : undefined;
  return {
    // One conversation turn has one durable session identity even when Direct
    // routing fans it out to several agents. Delivery identities remain scoped
    // per target in TeammateService below.
    id: createScopedSwarmMessageId(scope, `conversation:${sourceId}`),
    role: 'user',
    content: payload.message,
    timestamp: payload.timestamp ?? Date.now(),
    metadata: {
      ...payload.metadata,
      ...(workbench ? { workbench } : {}),
      agentTeam: {
        sessionId: payload.sessionId,
        runId: payload.runId,
        treeId: scope.treeId,
        agentId: targetAgentIds[0] ?? payload.agentId,
        targetAgentIds,
      },
    },
  };
}

function hasExplicitSwarmScope(event: unknown): event is SwarmEvent {
  if (!event || typeof event !== 'object') return false;
  const candidate = event as Partial<SwarmEvent>;
  return Boolean(
    typeof candidate.type === 'string'
    && typeof candidate.sessionId === 'string' && candidate.sessionId
    && typeof candidate.runId === 'string' && candidate.runId
    && typeof candidate.treeId === 'string' && candidate.treeId
  );
}

function resolveRunScope(ref: SwarmRunRef): SwarmRunScope | null {
  const coordinator = getSwarmServices().parallelCoordinators.getByRun(ref);
  const scope = coordinator?.getScope();
  if (!scope || !isSameSwarmRun(scope, ref)) return null;
  return scope;
}

function resolveAgentScope(ref: SwarmAgentRef): SwarmRunScope | null {
  const scope = resolveRunScope(ref);
  const parsed = parseScopedSwarmAgentId(ref.agentId);
  if (
    !scope
    || parsed?.scope.sessionId !== scope.sessionId
    || parsed.scope.runId !== scope.runId
    || parsed.scope.treeId !== scope.treeId
  ) {
    return null;
  }
  return scope;
}

function isDuplicateMessageInsert(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed: messages.id');
}

/**
 * 注册 Swarm 事件监听器（CLI 模式下将事件路由到终端输出）
 * @returns 取消监听的函数
 */
export function addSwarmEventListener(listener: SwarmEventListener): () => void {
  swarmEventListeners.push(listener);
  return () => {
    const idx = swarmEventListeners.indexOf(listener);
    if (idx >= 0) swarmEventListeners.splice(idx, 1);
  };
}

/**
 * 将 SwarmEvent 投递到渲染进程 + CLI listeners
 * EventBus bridge 订阅器收到事件后调用本函数做实际分发。
 * 业务模块通过 getEventBus().publish('swarm', ...) 发布，不直接调本函数。
 */
function deliverSwarmEvent(event: SwarmEvent): void {
  const windows = AppWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('swarm:event', event);
    }
  }
  for (const listener of swarmEventListeners) {
    try { listener(event); } catch { /* 防止监听器错误影响事件流 */ }
  }
}

/**
 * ADR-008: EventBus 'swarm' domain → BrowserWindow + CLI listeners 桥接
 *
 * 业务模块（Phase 2 起：swarmLaunchApproval；Phase 3+：planApproval / agentSwarm）
 * 通过 getEventBus().publish('swarm', ...) 发布事件，由本桥接器统一投递给渲染进程。
 * 订阅 domain 级别（pattern='swarm'）一次即覆盖所有 swarm:* channel。
 *
 * 幂等：多次调用只订阅一次（模块加载 + registerSwarmHandlers 都会触发，
 * 保证即使 swarm.ipc 在 handler 注册前被其它模块引用也能先装好桥）。
 */
let swarmBusBridgeInstalled = false;
function ensureSwarmBusBridge(): void {
  if (swarmBusBridgeInstalled) return;
  swarmBusBridgeInstalled = true;
  getEventBus().subscribe<SwarmEvent>('swarm', (evt) => {
    if (!hasExplicitSwarmScope(evt.data)) {
      logger.warn('Dropped unscoped swarm event', { type: (evt.data as { type?: string })?.type });
      return;
    }
    deliverSwarmEvent(evt.data);
  });
  logger.debug('Swarm EventBus bridge installed');
}

// 模块加载时立即安装桥接器，确保早期发布的事件也能到达渲染进程
ensureSwarmBusBridge();

// ============================================================================
// IPC Handler 注册（Renderer → Main）
// ============================================================================

export function registerSwarmHandlers(
  getAppService: () => AgentApplicationService | null
): void {
  // 幂等安装 EventBus bridge（模块加载时已装一次，此处兜底）
  ensureSwarmBusBridge();

  // 用户发送消息给 Agent
  ipcHost.handle('swarm:send-user-message', async (_, payload: SwarmSendUserMessagePayload) => {
    try {
      const services = getSwarmServices();
      const ref: SwarmAgentRef = payload;
      const scope = resolveAgentScope(ref);
      if (!scope) return { delivered: false, persisted: false };
      const coordinator = services.parallelCoordinators.get(scope);
      if (!coordinator) return { delivered: false, persisted: false };

      const canDeliverToParallel = coordinator.canReceiveMessage(payload.agentId);
      const spawnGuardAgent = services.spawnGuard.get?.(payload.agentId, ref);
      const canDeliverToSpawnGuard = spawnGuardAgent?.status === 'running';

      if (!canDeliverToParallel && !canDeliverToSpawnGuard) {
        return {
          delivered: false,
          persisted: false,
        };
      }

      const requestedTargetIds = Array.from(new Set([
        payload.agentId,
        ...(payload.metadata?.workbench?.targetAgentIds ?? []),
      ]));
      const validatedTargetIds = requestedTargetIds.filter((agentId) => {
        const parsed = parseScopedSwarmAgentId(agentId);
        if (
          parsed?.scope.sessionId !== scope.sessionId
          || parsed.scope.runId !== scope.runId
          || parsed.scope.treeId !== scope.treeId
        ) {
          return false;
        }
        if (coordinator.canReceiveMessage(agentId)) return true;
        return services.spawnGuard.get?.(agentId, ref)?.status === 'running';
      });
      const sessionMessage = buildPersistedUserMessage(payload, scope, validatedTargetIds);
      const delivered =
        coordinator.sendMessage(payload.agentId, payload.message) ||
        Boolean(services.spawnGuard.sendMessage?.(payload.agentId, payload.message, ref));

      if (!delivered) {
        return {
          delivered: false,
          persisted: false,
        };
      }

      try {
        services.teammateService.onUserMessage(scope, payload.agentId, payload.message, {
          id: createScopedSwarmMessageId(
            scope,
            `delivery:${sessionMessage.id}:${payload.agentId}`,
          ),
          timestamp: sessionMessage.timestamp,
        });
      } catch (error) {
        logger.warn('swarm:send-user-message delivery ledger failed', { error: String(error) });
      }

      let persisted = false;
      try {
        await getSessionManager().addMessageToSession(payload.sessionId, sessionMessage);
        persisted = true;
      } catch (error) {
        if (isDuplicateMessageInsert(error)) {
          persisted = true;
        } else {
          logger.error('swarm:send-user-message persistence failed after delivery', {
            error: String(error),
          });
        }
      }
      return {
        delivered,
        persisted,
      };
    } catch (error) {
      logger.error('swarm:send-user-message failed', { error: String(error) });
      return {
        delivered: false,
        persisted: false,
      };
    }
  });

  // 获取 Agent 消息历史
  ipcHost.handle('swarm:get-agent-messages', async (_, payload: SwarmAgentRef) => {
    try {
      const services = getSwarmServices();
      const scope = resolveAgentScope(payload);
      if (!scope) return [];
      const history = services.teammateService.getHistory(scope, 200);
      return history
        .filter((m: { from: string; to: string }) => (
          m.from === payload.agentId || m.to === payload.agentId || m.to === 'all'
        ))
        .map((m: { id: string; from: string; to: string; content: string; timestamp: number; type: string }) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          content: m.content,
          timestamp: m.timestamp,
          messageType: m.type,
        }));
    } catch (error) {
      logger.error('swarm:get-agent-messages failed', { error: String(error) });
      return [];
    }
  });

  // 切换 delegate 模式
  ipcHost.handle('swarm:set-delegate-mode', async (_, enabled: boolean) => {
    try {
      const appService = getAppService();
      if (appService) {
        appService.setDelegateMode(enabled);
      }
    } catch (error) {
      logger.error('swarm:set-delegate-mode failed', { error: String(error) });
    }
  });

  ipcHost.handle('swarm:get-delegate-mode', async () => {
    try {
      const appService = getAppService();
      return appService?.isDelegateMode() ?? false;
    } catch (error) {
      logger.error('swarm:get-delegate-mode failed', { error: String(error) });
      return false;
    }
  });

  ipcHost.handle('swarm:approve-launch', async (_, payload: SwarmRunRef & { requestId: string; feedback?: string }) => {
    try {
      if (!resolveRunScope(payload)) return false;
      return getSwarmServices().launchApproval.approve(payload.requestId, payload.feedback, payload);
    } catch (error) {
      logger.error('swarm:approve-launch failed', { error: String(error) });
      return false;
    }
  });

  ipcHost.handle('swarm:reject-launch', async (_, payload: SwarmRunRef & { requestId: string; feedback: string }) => {
    try {
      const scope = resolveRunScope(payload);
      if (!scope) return false;
      const services = getSwarmServices();
      const rejected = services.launchApproval.reject(payload.requestId, payload.feedback, payload);
      if (rejected) services.parallelCoordinators.finalize(scope, 'cancelled');
      return rejected;
    } catch (error) {
      logger.error('swarm:reject-launch failed', { error: String(error) });
      return false;
    }
  });

  ipcHost.handle('swarm:cancel-run', async (_, payload: SwarmRunRef) => {
    try {
      const services = getSwarmServices();
      const scope = resolveRunScope(payload);
      if (!scope) return false;
      services.planApproval.cancelRun(scope, 'swarm_cancelled');
      services.launchApproval.cancelRun(scope, 'swarm_cancelled');
      services.spawnGuard.cancelRun(scope, 'swarm_cancelled');
      services.parallelCoordinators.abortRun(scope, 'swarm_cancelled');
      getSwarmEventEmitter().cancelled(scope);
      services.parallelCoordinators.finalize(scope, 'cancelled');
      return true;
    } catch (error) {
      logger.error('swarm:cancel-run failed', { error: String(error) });
      return false;
    }
  });

  ipcHost.handle('swarm:cancel-agent', async (_, payload: SwarmAgentRef) => {
    try {
      const services = getSwarmServices();
      const scope = resolveAgentScope(payload);
      if (!scope) return false;
      const coordinator = services.parallelCoordinators.get(scope);
      if (!coordinator) return false;
      const cancelledPlanCount = services.planApproval.cancelAgent(payload, 'user-cancel');
      // Do not short-circuit these calls. One logical agent may be represented
      // in both SpawnGuard and the parallel coordinator while an approval is
      // pending, and every waiter/executor must receive the cancellation.
      const spawnCancelled = services.spawnGuard.cancel(payload.agentId, payload);
      const coordinatorCancelled = coordinator.abortTask(payload.agentId);
      const cancelled = cancelledPlanCount > 0 || spawnCancelled || coordinatorCancelled;

      if (cancelled) {
        getSwarmEventEmitter().agentCancelled(scope, payload.agentId, 'Cancelled by user');
      }

      return cancelled;
    } catch (error) {
      logger.error('swarm:cancel-agent failed', { error: String(error) });
      return false;
    }
  });

  ipcHost.handle('swarm:retry-agent', async (_, payload: SwarmAgentRef) => {
    try {
      const scope = resolveAgentScope(payload);
      if (!scope) return false;
      const coordinator = getSwarmServices().parallelCoordinators.get(scope);
      if (!coordinator) return false;
      const task = coordinator.getTaskDefinition(payload.agentId);
      if (!task) return false;

      getSwarmEventEmitter().agentUpdated(scope, payload.agentId, {
        status: 'running',
        startTime: Date.now(),
        endTime: undefined,
        error: '',
        lastReport: 'Retrying task',
      });

      void coordinator.retryTask(payload.agentId)
        .then((result) => {
          if (result.success) {
            getSwarmEventEmitter().agentCompleted(scope, payload.agentId, result.output);
            return;
          }

          getSwarmEventEmitter().agentFailed(scope, payload.agentId, result.error || 'Unknown error');
        })
        .catch((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          getSwarmEventEmitter().agentFailed(scope, payload.agentId, errorMessage);
        });

      return true;
    } catch (error) {
      logger.error('swarm:retry-agent failed', { error: String(error) });
      return false;
    }
  });

  ipcHost.handle('swarm:approve-plan', async (_, payload: SwarmAgentRef & { planId: string; feedback?: string }) => {
    try {
      const services = getSwarmServices();
      if (!resolveAgentScope(payload)) return false;
      const plan = services.planApproval.getPlan(payload.planId, payload);
      if (!plan) return false;

      const approved = services.planApproval.approve(payload.planId, payload.feedback, payload);
      if (!approved) return false;

      return true;
    } catch (error) {
      logger.error('swarm:approve-plan failed', { error: String(error) });
      return false;
    }
  });

  ipcHost.handle('swarm:reject-plan', async (_, payload: SwarmAgentRef & { planId: string; feedback: string }) => {
    try {
      const services = getSwarmServices();
      if (!resolveAgentScope(payload)) return false;
      const plan = services.planApproval.getPlan(payload.planId, payload);
      if (!plan) return false;

      const rejected = services.planApproval.reject(payload.planId, payload.feedback, payload);
      if (!rejected) return false;

      return true;
    } catch (error) {
      logger.error('swarm:reject-plan failed', { error: String(error) });
      return false;
    }
  });

  // Agent 历史持久化
  ipcHost.handle('swarm:persist-agent-run', async (_, payload: { sessionId: string; run: CompletedAgentRun }) => {
    try {
      await getSwarmServices().agentHistory.persistAgentRun(payload.sessionId, payload.run);
      return true;
    } catch (error) {
      logger.error('swarm:persist-agent-run failed', { error: String(error) });
      return false;
    }
  });

  // 获取最近完成的 agent runs
  ipcHost.handle('swarm:get-agent-history', async (_, payload?: { limit?: number }) => {
    try {
      return await getSwarmServices().agentHistory.getRecentAgentHistory(payload?.limit);
    } catch (error) {
      logger.error('swarm:get-agent-history failed', { error: String(error) });
      return [];
    }
  });

  // ADR-010 #5: Swarm Trace 历史查询
  ipcHost.handle('swarm:list-trace-runs', async (_, payload: { sessionId: string; limit?: number }) => {
    try {
      if (!payload?.sessionId) return [];
      const repo = getSwarmServices().swarmTraceRepo;
      if (!repo) return [];
      const requestedLimit = typeof payload.limit === 'number' && Number.isFinite(payload.limit)
        ? Math.trunc(payload.limit)
        : SWARM_TRACE.DEFAULT_LIST_LIMIT;
      const safeLimit = Math.max(1, Math.min(requestedLimit, SWARM_TRACE.MAX_LIST_LIMIT));
      // Repository list APIs are storage-wide. Read up to the repository cap
      // before filtering so newer foreign-session runs cannot crowd the active
      // session out of its own history window.
      return repo.listRuns(SWARM_TRACE.MAX_LIST_LIMIT)
        .filter((run) => run.sessionId === payload.sessionId)
        .slice(0, safeLimit);
    } catch (error) {
      logger.error('swarm:list-trace-runs failed', { error: String(error) });
      return [];
    }
  });

  ipcHost.handle('swarm:get-trace-run-detail', async (_, payload: { sessionId: string; runId: string }) => {
    try {
      if (!payload?.sessionId || !payload?.runId) return null;
      // ADR-023 D2 切换降级：以协同账本(ledger)为真理源，无账回退 rollup 缓存。
      let detail: SwarmRunDetail | null;
      try {
        const { getDatabase } = await import('../services/core/databaseService');
        detail = getDatabase().getSwarmRunDetailPreferLedger(payload.runId);
      } catch {
        const repo = getSwarmServices().swarmTraceRepo;
        detail = repo ? repo.getRunDetail(payload.runId) : null;
      }
      // runId is an opaque storage identity. Authorization is derived from the
      // stored record, never from parsing or rebuilding the caller-provided id.
      return detail?.run.sessionId === payload.sessionId ? detail : null;
    } catch (error) {
      logger.error('swarm:get-trace-run-detail failed', { error: String(error) });
      return null;
    }
  });
}
