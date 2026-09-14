// ============================================================================
// Web Session Command Context（RQ-183 刀 2）
// ============================================================================
//
// 本文件曾是 web standalone 的 session domain handler 独立 switch（与桌面
// session.ipc.ts 双实现、同一个 action 两边各注册一次）。刀 2 起域通道走单源
// 路由表（src/host/ipc/domainRoutes/sessionRoutes.ts），两侧差异全部沉入
// SessionCommandContext——本文件退化为 web context 工厂：原 switch 的实现
// 原样平移成 context 方法（惰性 createSessionApplicationService + SessionManager
// 直调四动作 + modelSessionState + 写后失效），行为严格不变。
import type { DurableRunReadService } from '../host/app/durableRunReadService';
import type { ModelProvider, Session } from '../shared/contract';
import type {
  SessionListQueryOptions,
  SwitchModelParams,
} from '../shared/contract/appService';
import { getModelSessionState } from '../host/session/modelSessionState';
import {
  clearPersistedModelOverride,
  persistModelOverride,
  rehydrateModelOverrideFromSession,
} from '../host/session/modelOverridePersistence';
import {
  SessionBackendUnavailableError,
  type SessionCommandContext,
  type SessionCommandService,
} from '../host/ipc/domainRoutes/sessionRoutes';
import { invalidateSessionMessagesProjection } from './helpers/webSessionStore';

export interface WebSessionContextDependencies {
  getDbAvailable: () => boolean;
  hasActiveRun: (sessionId: string) => boolean;
  getCurrentSessionId: () => string | null;
  setCurrentSessionId: (sessionId: string) => void;
  getDurableRunReadService: () => DurableRunReadService | undefined;
}

async function createSessionApplicationService(deps: WebSessionContextDependencies) {
  const [{ AgentAppServiceImpl }, { getTaskManager }, { getConfigService }] = await Promise.all([
    import('../host/app/agentAppService'),
    import('../host/task'),
    import('../host/services/core/configService'),
  ]);
  return new AgentAppServiceImpl(
    () => getTaskManager(),
    () => getConfigService(),
    deps.getCurrentSessionId,
    deps.setCurrentSessionId,
    undefined,
    deps.getDurableRunReadService(),
  );
}

type SessionManager = Awaited<ReturnType<typeof import('../host/services/infra/sessionManager').getSessionManager>>;

/** backend 门（原 web handler 开关原样）：DB 未就绪或 SessionManager 不可用 → SERVICE_UNAVAILABLE */
async function requireSessionBackend(deps: WebSessionContextDependencies): Promise<void> {
  if (!deps.getDbAvailable()) {
    throw new SessionBackendUnavailableError();
  }
  const { getSessionManager } = await import('../host/services/infra/sessionManager');
  try {
    getSessionManager();
  } catch {
    throw new SessionBackendUnavailableError();
  }
}

async function resolveSessionManager(deps: WebSessionContextDependencies): Promise<SessionManager> {
  await requireSessionBackend(deps);
  const { getSessionManager } = await import('../host/services/infra/sessionManager');
  return getSessionManager();
}

/** web 实现（方案 2.2 表「现状平移」列）：与原 switch 逐 case 等价 */
export function createWebSessionContext(deps: WebSessionContextDependencies): SessionCommandContext {
  return {
    // 每请求惰性构造（durableRunReadService 异步装配，构造时机不同会冻结 undefined，
    // 保持原 handler 每请求构造的现状）
    sessions: async (): Promise<SessionCommandService> => {
      await requireSessionBackend(deps);
      return createSessionApplicationService(deps);
    },

    ensureBackend: async () => {
      await requireSessionBackend(deps);
    },

    // —— sm 直调四动作（1.2 drift 表拍板归属 web；桌面实现是 AppService 直连语义） ——
    listSessions: (options?: SessionListQueryOptions) =>
      resolveSessionManager(deps).then((sm) => sm.listSessions(options)),

    loadSession: (sessionId: string) =>
      resolveSessionManager(deps).then((sm) => sm.restoreSession(sessionId)),

    deleteSession: (sessionId: string) =>
      resolveSessionManager(deps).then((sm) => sm.deleteSession(sessionId)),

    updateSession: (sessionId: string, updates: Partial<Session>) =>
      resolveSessionManager(deps).then((sm) => sm.updateSession(sessionId, updates)),

    // —— load 装饰：streamSnapshot + activeRun（runtime-only 字段，不进 DB） ——
    decorateLoadedSession: async (session: Session) => {
      const { loadStreamSnapshot } = await import('../host/session/streamSnapshot');
      const streamSnapshot = loadStreamSnapshot({
        workingDir: session.workingDirectory,
        sessionId: session.id,
      });
      if (streamSnapshot?.sessionId === session.id) {
        (session as { streamSnapshot?: unknown }).streamSnapshot = streamSnapshot;
      }
      // 前端的「这个会话在不在跑」是纯内存态，刷新即清零；宿主这边 runRegistry 才是真源。
      // 不带这一条，刷新页面后前端一律显示空闲，而宿主可能还在跑同一轮——真机实测
      // 断连后那一轮又跑了 51 秒，期间屏幕空闲、排队卡还显示「立即发送」，用户一点就撞车
      // （2026-08-01 C3）。
      (session as { activeRun?: boolean }).activeRun = deps.hasActiveRun(session.id);
    },

    // —— fork / rewind 构造（runRegistry 状态源，原 web 直构原样） ——
    forkSession: async (params) => {
      await requireSessionBackend(deps);
      const { getDatabase } = await import('../host/services/core/databaseService');
      const { getAuthService } = await import('../host/services/auth/authService');
      const { SessionForkService } = await import('../host/services/sessionFork/SessionForkService');
      const service = new SessionForkService(getDatabase(), {
        getRuntimeStatus: (sessionId) => deps.hasActiveRun(sessionId) ? 'running' : undefined,
        ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
      });
      return service.createFork(params);
    },

    rewindConversation: async (params) => {
      const sm = await resolveSessionManager(deps);
      const { getDatabase } = await import('../host/services/core/databaseService');
      const { getAuthService } = await import('../host/services/auth/authService');
      const { SessionRewindService } = await import('../host/services/sessionRewind/SessionRewindService');
      const data = await new SessionRewindService(getDatabase(), {
        getRuntimeStatus: (id) => deps.hasActiveRun(id) ? 'running' : undefined,
        ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
      }).rewindConversation(params);
      sm.invalidateSessionCache(params.sessionId);
      invalidateSessionMessagesProjection(params.sessionId);
      return data;
    },

    restoreConversationRewind: async (params) => {
      const sm = await resolveSessionManager(deps);
      const { getDatabase } = await import('../host/services/core/databaseService');
      const { getAuthService } = await import('../host/services/auth/authService');
      const { SessionRewindService } = await import('../host/services/sessionRewind/SessionRewindService');
      const data = await new SessionRewindService(getDatabase(), {
        getRuntimeStatus: (id) => deps.hasActiveRun(id) ? 'running' : undefined,
        ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
      }).restoreConversation(params);
      sm.invalidateSessionCache(params.sessionId);
      invalidateSessionMessagesProjection(params.sessionId);
      return data;
    },

    // —— 写后失效：rewind/checkout/redo 后缓存 + 投影一并失效（原 web 语义） ——
    invalidateAfterWrite: async (sessionId: string) => {
      const sm = await resolveSessionManager(deps);
      sm.invalidateSessionCache(sessionId);
      invalidateSessionMessagesProjection(sessionId);
    },

    // —— model override：modelSessionState + db 门控持久化（原 web 三段原样） ——
    modelOverride: {
      switchModel: async (params: SwitchModelParams) => {
        const override = {
          provider: params.provider as ModelProvider,
          model: params.model,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
          adaptive: params.adaptive,
        };
        getModelSessionState().setOverride(params.sessionId, override);
        const persisted = deps.getDbAvailable()
          ? await persistModelOverride(params.sessionId, override)
          : false;
        return { persisted };
      },

      getOverride: async (sessionId: string) => {
        let override = getModelSessionState().getOverride(sessionId);
        if (!override && deps.getDbAvailable()) {
          try {
            const { getSessionManager } = await import('../host/services/infra/sessionManager');
            const session = await getSessionManager().getSession(sessionId, 1);
            override = rehydrateModelOverrideFromSession(session);
          } catch { /* Session missing or DB unavailable: preserve null fallback. */ }
        }
        return override;
      },

      clearOverride: async (sessionId: string) => {
        getModelSessionState().clearOverride(sessionId);
        const cleared = deps.getDbAvailable()
          ? await clearPersistedModelOverride(sessionId)
          : false;
        return { persisted: cleared };
      },
    },
  };
}
