// ============================================================================
// Model Override Persistence - 会话级模型选择跨重启持久化
// ============================================================================
//
// modelSessionState 是纯内存 Map，重启即空。这里把用户显式切换的模型落进
// sessions 表（model_provider/model_name 列 + metadata.modelOverride 标记），
// 恢复时按标记回灌内存 Map。
//
// 为什么需要 metadata 标记而不是直接回灌 model_name 列：
// sessions.model_provider/model_name 在建会话时就写入了默认模型快照，
// 只按列回灌会把「从未切换过」的会话钉死在建会话时的默认模型上。
// 标记只在用户显式 switchModel 时写入，从未切换的会话保持跟随全局默认。
//
// 并发（Codex audit R1-HIGH1/MED1）：
// - DB 写走 patchSessionMetadata（key 级同步补丁，无 await 窗口，不整列替换）
// - 同一会话的 persist/clear 经 per-session promise 链串行，保证 DB 落地顺序
//   与内存写入顺序一致（否则慢的旧写会在重启后复活已清除的 override）

import { createLogger } from '../services/infra/logger';
import { getModelSessionState, type ModelOverride } from './modelSessionState';
import type { ModelProvider } from '../../shared/contract/model';
import type { Session } from '../../shared/contract/session';

const logger = createLogger('ModelOverridePersistence');

export const MODEL_OVERRIDE_METADATA_KEY = 'modelOverride';

export interface PersistedModelOverride {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  adaptive?: boolean;
  setAt: number;
}

type SessionLike = Pick<Session, 'id'> & { metadata?: Record<string, unknown> };

// per-session 持久化操作串行链（audit R1-HIGH1：乱序落地会让旧 override 复活）
const persistChains = new Map<string, Promise<unknown>>();

function enqueuePersistOp<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
  const prev = persistChains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(op, op);
  persistChains.set(sessionId, next);
  const cleanup = () => {
    if (persistChains.get(sessionId) === next) persistChains.delete(sessionId);
  };
  next.then(cleanup, cleanup);
  return next;
}

export function readPersistedModelOverride(
  session: Partial<SessionLike> | null | undefined,
): PersistedModelOverride | null {
  const raw = session?.metadata?.[MODEL_OVERRIDE_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (typeof marker.provider !== 'string' || marker.provider.length === 0) return null;
  if (typeof marker.model !== 'string' || marker.model.length === 0) return null;
  return {
    provider: marker.provider,
    model: marker.model,
    temperature: typeof marker.temperature === 'number' ? marker.temperature : undefined,
    maxTokens: typeof marker.maxTokens === 'number' ? marker.maxTokens : undefined,
    adaptive: typeof marker.adaptive === 'boolean' ? marker.adaptive : undefined,
    setAt: typeof marker.setAt === 'number' ? marker.setAt : 0,
  };
}

/**
 * 把模型切换落库。返回 persisted 结果（audit R1-HIGH2：失败不再完全静默，
 * 调用方把 persisted 标志透出到响应）；失败不抛：内存 override 本轮仍生效，
 * 落库失败仅意味着重启后不恢复（如 web 模式无 DB）。
 */
export async function persistModelOverride(
  sessionId: string,
  override: Omit<ModelOverride, 'setAt'> & { setAt?: number },
): Promise<boolean> {
  return enqueuePersistOp(sessionId, async () => {
    try {
      const { getSessionManager } = await import('../services/infra/sessionManager');
      const marker: PersistedModelOverride = {
        provider: override.provider,
        model: override.model,
        temperature: override.temperature,
        maxTokens: override.maxTokens,
        adaptive: override.adaptive,
        setAt: override.setAt ?? Date.now(),
      };
      const persisted = await getSessionManager().patchSessionMetadata(
        sessionId,
        { [MODEL_OVERRIDE_METADATA_KEY]: { ...marker } },
        {
          // adaptive（自动路由）时 provider/model 只是占位，不写进列，避免列语义失真
          ...(override.adaptive === true
            ? {}
            : { modelConfig: { provider: override.provider, model: override.model } }),
          updatedAt: Date.now(),
        },
      );
      if (!persisted) {
        logger.warn('Cannot persist model override: session not found', { sessionId });
      }
      return persisted;
    } catch (error) {
      logger.warn('Failed to persist model override', { sessionId, error: String(error) });
      return false;
    }
  });
}

/**
 * 清除落库的切换标记（用户重置回全局默认）。列值保留为最后快照，无读回语义。
 */
export async function clearPersistedModelOverride(sessionId: string): Promise<boolean> {
  return enqueuePersistOp(sessionId, async () => {
    try {
      const { getSessionManager } = await import('../services/infra/sessionManager');
      return await getSessionManager().patchSessionMetadata(sessionId, {
        [MODEL_OVERRIDE_METADATA_KEY]: null,
      });
    } catch (error) {
      logger.warn('Failed to clear persisted model override', { sessionId, error: String(error) });
      return false;
    }
  });
}

/**
 * 恢复回灌：内存里已有 override（更新鲜）则原样返回；否则按持久化标记重建。
 * 没有标记（从未切换）返回 null，不动内存 Map。
 */
export function rehydrateModelOverrideFromSession(
  session: Partial<SessionLike> | null | undefined,
): ModelOverride | null {
  if (!session?.id) return null;
  const state = getModelSessionState();
  const existing = state.getOverride(session.id);
  if (existing) return existing;
  const persisted = readPersistedModelOverride(session);
  if (!persisted) return null;
  state.setOverride(session.id, {
    provider: persisted.provider as ModelProvider,
    model: persisted.model,
    temperature: persisted.temperature,
    maxTokens: persisted.maxTokens,
    adaptive: persisted.adaptive,
  });
  logger.info('Model override rehydrated from session metadata', {
    sessionId: session.id,
    provider: persisted.provider,
    model: persisted.model,
    adaptive: persisted.adaptive === true,
  });
  return state.getOverride(session.id);
}
