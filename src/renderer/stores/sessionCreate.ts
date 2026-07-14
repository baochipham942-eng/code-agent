import type { Session, Message, TodoItem } from '@shared/contract';
import type { AgentEngineSessionMetadata } from '@shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '@shared/contract/agentEngine';
import { deriveSessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import { IPC_DOMAINS } from '@shared/ipc';
import { createLogger } from '../utils/logger';
import { useAppStore } from './appStore';
import { useAppshotsStore } from './appshotsStore';

const logger = createLogger('SessionCreate');

async function invokeSession<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.SESSION, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Session action failed: ${action}`);
  }
  return response.data as T;
}

/** Minimal session meta shape used by create (avoids circular import with sessionStore). */
export interface SessionCreateMeta extends Session {
  messageCount: number;
  turnCount: number;
}

export interface CreateSessionOptionsInput {
  workingDirectory?: string | null;
  engine?: Partial<AgentEngineSessionMetadata> | null;
}

function normalizeSession(session: Session & {
  messageCount?: number;
  turnCount?: number;
}): SessionCreateMeta {
  return {
    ...session,
    title: session.title || '未命名会话',
    type: session.type || 'chat',
    engine: normalizeAgentEngineSession(session.engine),
    memoryMode: session.memoryMode || 'auto',
    suppressedMemoryEntryIds: session.suppressedMemoryEntryIds || [],
    updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : (Number.isFinite(session.createdAt) ? session.createdAt : Date.now()),
    createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
    messageCount: session.messageCount || 0,
    turnCount: session.turnCount || 0,
    workbenchSnapshot: session.workbenchSnapshot || deriveSessionWorkbenchSnapshot([], {
      workingDirectory: session.workingDirectory ?? null,
    }),
  };
}

export interface SessionCreateStoreSlice {
  sessions: SessionCreateMeta[];
  currentSessionId: string | null;
  messages: Message[];
  todos: TodoItem[];
  switchSession: (sessionId: string) => Promise<void>;
  updateSessionEngine: (sessionId: string, engine: Partial<AgentEngineSessionMetadata>) => Promise<void>;
}

export interface SessionCreateDeps {
  get: () => SessionCreateStoreSlice;
  set: (
    partial:
      | Record<string, unknown>
      | ((state: SessionCreateStoreSlice) => Record<string, unknown>),
  ) => void;
  invalidatePendingSessionSwitches: () => void;
  findReusableNewSessionDraft: (params: {
    sessions: SessionCreateMeta[];
    currentSessionId: string | null;
    messages: Message[];
    todos: TodoItem[];
    workingDirectory?: string | null;
  }) => SessionCreateMeta | null;
}

/**
 * Core createSession implementation (extracted from sessionStore for max-lines debt gate).
 * Caller owns the pending-create tracking / isCreatingSession flag.
 */
export async function executeCreateSession(
  deps: SessionCreateDeps,
  title?: string,
  options?: CreateSessionOptionsInput,
): Promise<Session | null> {
  const { get, set, invalidatePendingSessionSwitches, findReusableNewSessionDraft } = deps;
  try {
    const inheritedWorkingDirectory =
      options?.workingDirectory !== undefined
        ? options.workingDirectory
        : useAppStore.getState().workingDirectory;
    const nextTitle = title?.trim() || '新对话';
    if (nextTitle === '新对话') {
      useAppshotsStore.getState().clear();
      const reusableSession = findReusableNewSessionDraft({
        sessions: get().sessions,
        currentSessionId: get().currentSessionId,
        messages: get().messages,
        todos: get().todos,
        workingDirectory: inheritedWorkingDirectory,
      });
      if (reusableSession) {
        // 与新建路径一致：复用空草稿时也继承当前会话的 native 模型选择，
        // 避免「点新会话模型被重置」。仅当当前会话有显式 override 时才应用，
        // 不覆盖草稿自身已设的模型；switchModel 须在 switchSession 之前完成，
        // 否则 ModelSwitcher 监听 sessionId 变化会先读到旧值。
        const draftPrevSessionId = get().currentSessionId;
        if (!options?.engine && draftPrevSessionId && draftPrevSessionId !== reusableSession.id) {
          try {
            const override = await invokeSession<{ provider: string; model: string; adaptive?: boolean } | null>(
              'getModelOverride',
              { sessionId: draftPrevSessionId },
            );
            if (override?.provider && override?.model) {
              await invokeSession('switchModel', {
                sessionId: reusableSession.id,
                provider: override.provider,
                model: override.model,
                adaptive: !!override.adaptive,
              });
            }
          } catch {
            logger.warn('Failed to inherit model selection for reused draft session');
          }
        }
        if (get().currentSessionId !== reusableSession.id) {
          await get().switchSession(reusableSession.id);
        }
        useAppStore.getState().setWorkingDirectory(reusableSession.workingDirectory ?? null);
        // 复用空白草稿时刷新时间戳，避免侧边栏显示旧草稿的"3 天前"。
        set((state) => ({
          isLoading: false,
          error: null,
          sessions: state.sessions.map((s) => (
            s.id === reusableSession.id
              ? normalizeSession({ ...s, updatedAt: Date.now() })
              : s
          )),
        }));
        return reusableSession;
      }
    }

    // 记录上一个会话的 engine，外部引擎（Codex/Claude）选择在新会话创建后继承
    const previousSessionId = get().currentSessionId;
    const previousEngine = get().sessions.find((s) => s.id === previousSessionId)?.engine;
    const shouldInheritNativeModel =
      !options?.engine &&
      (!previousEngine || previousEngine.kind === 'native') &&
      !!previousSessionId;
    // 预读上一会话的 native 模型覆盖（与 create 并行，降低延迟）
    const previousModelOverridePromise = shouldInheritNativeModel
      ? invokeSession<{ provider: string; model: string; adaptive?: boolean } | null>(
          'getModelOverride',
          { sessionId: previousSessionId },
        ).catch(() => null)
      : Promise.resolve(null);

    set({ isLoading: true, error: null });
    const session = await invokeSession<Session | null>('create', {
      title: nextTitle,
      workingDirectory: inheritedWorkingDirectory,
      engine: options?.engine ?? null,
    });
    if (session) {
      const newSessionWithMeta = normalizeSession({
        ...session,
        messageCount: 0,
        turnCount: 0,
      });

      // 继承上一会话的 native 模型选择，必须在激活（设置 currentSessionId）之前完成：
      // 否则 ModelSwitcher 监听 sessionId 变化拉取 override 时会先拿到默认值再不刷新，
      // 表现为「新会话模型被重置」。提前 switchModel 让其挂载即读到正确 override。
      if (shouldInheritNativeModel && previousSessionId !== session.id) {
        try {
          const override = await previousModelOverridePromise;
          if (override?.provider && override?.model) {
            await invokeSession('switchModel', {
              sessionId: session.id,
              provider: override.provider,
              model: override.model,
              adaptive: !!override.adaptive,
            });
          }
        } catch {
          logger.warn('Failed to inherit model selection for new session');
        }
      }

      invalidatePendingSessionSwitches();
      useAppStore.getState().setWorkingDirectory(newSessionWithMeta.workingDirectory ?? null);
      // 新会话继承 draft 期（无会话时）的 agent 选择，其余情况从 per-session map 读取
      useAppStore.getState().syncActiveAgentForSession(session.id, { inheritCurrent: !previousSessionId });
      set({
        sessions: [newSessionWithMeta, ...get().sessions],
        currentSessionId: session.id,
        messages: [],
        todos: [],
        sessionTasks: [],
        streamSnapshot: null,
        hasOlderMessages: false,
        isLoadingOlder: false,
        isLoading: false,
      });
      useAppStore.getState().setContextHealth(null);

      // 继承上一个会话的外部 engine 选择（后端禁止创建时直接指定外部引擎，
      // 必须走创建后的 select 校验路径：需要工作目录 + 引擎可用，失败则保持 native）
      if (!options?.engine && previousEngine && previousEngine.kind !== 'native') {
        try {
          await get().updateSessionEngine(session.id, {
            kind: previousEngine.kind,
            permissionProfile: previousEngine.permissionProfile,
            model: previousEngine.model,
            cwd: previousEngine.cwd ?? newSessionWithMeta.workingDirectory ?? undefined,
          });
        } catch {
          logger.warn('Failed to inherit external engine for new session, falling back to native');
        }
      }
      return session;
    }
    return null;
  } catch (error) {
    logger.error('Failed to create session', error);
    set({
      error: error instanceof Error ? error.message : 'Failed to create session',
      isLoading: false,
    });
    return null;
  }
}
