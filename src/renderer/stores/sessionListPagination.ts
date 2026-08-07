// ============================================================================
// sessionListPagination —— 侧栏会话列表分页（2026-08-07 工单：历史会话够不到）。
//
// 背景：侧栏原只加载最近 50 条（sessionManager 默认 limit，上层从不传），
// 生产库 5000+ 会话时历史会话在侧栏翻不到。仓储层本就有 limit/offset，
// 本模块把它接成「加载更多」翻页：
// - executeLoadSessions：首屏/刷新，重置到第一页；静默刷新（云端同步广播）
//   按已加载窗口大小重取，不把用户翻出来的历史会话收回第一页。
// - executeLoadOlderSessions：按 offset=已加载条数 取下一页追加，按 id 去重
//   （翻页中途新建/活跃的会话会把后续行整体后挤，offset 窗口会重复扫到上一页末尾）。
//
// 从 sessionStore 拆出（god-file 门：sessionStore effective 996/1000，只留最小接线）。
// ============================================================================

import type { Session } from '@shared/contract';
import { normalizeAgentEngineSession } from '@shared/contract/agentEngine';
import { deriveSessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import { IPC_DOMAINS } from '@shared/ipc';
import { SESSION_LIST_PAGE_SIZE } from '@shared/constants';
import type { SessionListQueryOptions } from '@shared/contract/appService';
import { createLogger } from '../utils/logger';
import { sessionsSignature } from '../utils/sessionListSignature';
import { useSessionUIStore } from './sessionUIStore';
import type { SessionFilter } from './sessionStore';

const logger = createLogger('SessionListPagination');

async function invokeSession<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.SESSION, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Session action failed: ${action}`);
  }
  return response.data as T;
}

/**
 * 会话列表本地乐观变更版本号（归档/取消归档/删除时 +1）。
 * 根因（2026-08-01 归档连点无响应）：host 每次归档都广播 SESSION_LIST_UPDATED，
 * 而 invokeDomain 的 in-flight dedupe 会把第二次广播触发的 loadSessions 并进
 * 第一次的在途 list 请求——拿到的是归档前的陈旧快照并写回 store，把刚乐观移除
 * 的行复活。loadSessions 落地前比对本版本号：在途期间发生过本地变更就丢弃快照
 * 重取，而不是把陈旧列表写回。
 */
let _sessionsLocalVersion = 0;

function getSessionsLocalVersion(): number {
  return _sessionsLocalVersion;
}

export function bumpSessionsLocalVersion(): void {
  _sessionsLocalVersion += 1;
}

/** 与 sessionStore/sessionCreate 同款的最小 meta 形状（避免与 sessionStore 循环 import 运行时值）。 */
interface SessionListMeta extends Session {
  messageCount: number;
  turnCount: number;
}

/** 与 sessionStore.normalizeSession 同逻辑（sessionCreate 里也有同款副本，同为避循环 import）。 */
function normalizeSession(session: Session & { messageCount?: number; turnCount?: number }): SessionListMeta {
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

/** store 切片最小依赖（结构化类型，sessionStore 的 get/set 天然兼容）。 */
interface SessionListPaginationSlice {
  sessions: SessionListMeta[];
  isLoading: boolean;
  error: string | null;
  hasOlderSessions: boolean;
  isLoadingOlderSessions: boolean;
}

interface SessionListPaginationDeps {
  get: () => SessionListPaginationSlice;
  set: (partial: Partial<SessionListPaginationSlice>) => void;
}

/**
 * 过滤器 → host 查询参数。三种过滤各自成立独立分页：
 * - active：SQL 层排除归档（includeArchived=false）；
 * - archived：SQL 层只取归档（archivedOnly）——不再拉混合页回前端挑，
 *   否则混合分页下归档会话被摊薄到可能整页为零、翻不到底；
 * - all：归档与未归档按 updated_at 混排分页。
 */
function buildSessionListQuery(filter: SessionFilter, offset: number, limit: number): SessionListQueryOptions {
  if (filter === 'archived') {
    return { archivedOnly: true, offset, limit };
  }
  return { includeArchived: filter === 'all', offset, limit };
}

/**
 * 防御性前端过滤：host 已在 SQL 层保证归档语义，正常路径下这里一行都不会删；
 * 保留它只是为 host 行为漂移兜底（与改动前的前端过滤语义一致），因此
 * sessions.length 始终等于已从 DB 取出的原始条数，可直接当 offset 用。
 */
function applyClientFilter(sessions: SessionListMeta[], filter: SessionFilter): SessionListMeta[] {
  if (filter !== 'active' && filter !== 'archived') return sessions;
  return sessions.filter((s) => (filter === 'archived' ? s.isArchived : !s.isArchived));
}

export async function executeLoadSessions(
  deps: SessionListPaginationDeps,
  options?: { silent?: boolean },
): Promise<void> {
  const { get, set } = deps;
  // silent：后台刷新（云端同步广播）不动 isLoading，避免侧栏白刷一帧。
  const silent = options?.silent ?? false;
  const { filter } = useSessionUIStore.getState();
  if (!silent) set({ isLoading: true, error: null });
  // 在途期间若发生本地乐观变更（归档/删除等），拿到的是陈旧快照——落地前比对。
  const localVersionAtStart = getSessionsLocalVersion();
  try {
    // 静默刷新保持已加载窗口：用户已翻到 N 条就按 N 条重取同一窗口，
    // 否则每次云端同步广播都会把列表收回第一页，翻出来的历史会话瞬间消失。
    const loadedCount = silent ? get().sessions.length : 0;
    const limit = Math.max(SESSION_LIST_PAGE_SIZE, loadedCount);
    const sessions = await invokeSession<Session[]>('list', buildSessionListQuery(filter, 0, limit));

    if (localVersionAtStart !== getSessionsLocalVersion()) {
      // 快照陈旧（典型：归档①的广播触发本次 list，归档②在在途期间已乐观移除，
      // 且 dedupe 把归档②的广播并进本次请求）——丢弃重取，别把旧列表写回。
      return executeLoadSessions(deps, options);
    }

    const sessionsWithMeta = applyClientFilter(
      (sessions || []).map((session) => normalizeSession(session as Session & { messageCount?: number; turnCount?: number })),
      filter,
    );

    // 闪烁修复：数据签名不变就保留旧引用、跳过 setState，避免云端同步广播触发侧栏整树重渲染。
    if (sessionsSignature(get().sessions) === sessionsSignature(sessionsWithMeta)) {
      if (!silent) set({ isLoading: false });
      return;
    }

    set({
      sessions: sessionsWithMeta,
      isLoading: false,
      // 原始页（前端过滤前）不满一页 = 后面没有更多了。
      hasOlderSessions: (sessions || []).length >= limit,
    });
  } catch (error) {
    logger.error('Failed to load sessions', error);
    set({
      error: error instanceof Error ? error.message : 'Failed to load sessions',
      isLoading: false,
    });
  }
}

export async function executeLoadOlderSessions(deps: SessionListPaginationDeps): Promise<void> {
  const { get, set } = deps;
  const state = get();
  if (state.isLoading || state.isLoadingOlderSessions || !state.hasOlderSessions) return;
  const { filter } = useSessionUIStore.getState();
  set({ isLoadingOlderSessions: true });
  const localVersionAtStart = getSessionsLocalVersion();
  try {
    // sessions.length 恒等于已从 DB 取出的原始条数（见 applyClientFilter），直接当 offset。
    const offset = state.sessions.length;
    const page = await invokeSession<Session[]>('list', buildSessionListQuery(filter, offset, SESSION_LIST_PAGE_SIZE));

    if (localVersionAtStart !== getSessionsLocalVersion()) {
      // 在途期间发生本地乐观变更：本页可能是错位快照，丢弃不追加，等广播触发的静默刷新重取整个窗口。
      set({ isLoadingOlderSessions: false });
      return;
    }

    const pageWithMeta = applyClientFilter(
      (page || []).map((session) => normalizeSession(session as Session & { messageCount?: number; turnCount?: number })),
      filter,
    );

    // 翻页中途新建/活跃的会话会顶到列表最前、把后续行整体后挤，offset 窗口于是
    // 重复扫到上一页末尾若干行——按 id 去重，只追加真正的新行。
    const current = get().sessions;
    const knownIds = new Set(current.map((session) => session.id));
    const fresh = pageWithMeta.filter((session) => !knownIds.has(session.id));

    set({
      sessions: fresh.length > 0 ? [...current, ...fresh] : current,
      isLoadingOlderSessions: false,
      hasOlderSessions: (page || []).length >= SESSION_LIST_PAGE_SIZE,
    });
  } catch (error) {
    logger.error('Failed to load older sessions', error);
    // 追加失败不回滚已加载内容，只放下加载态；hasOlderSessions 保持 true，用户可重试。
    set({ isLoadingOlderSessions: false });
  }
}
