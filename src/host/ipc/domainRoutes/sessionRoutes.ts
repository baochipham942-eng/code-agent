// ============================================================================
// Session Domain Routes - session 域单源路由表（RQ-183 刀 2）
// ============================================================================
//
// 取代此前「桌面 session.ipc switch + web sessionDomainHandler switch」双实现
// （生产装配顺序：桌面版先注册、webServer 随后整个覆盖——桌面 switch 生产是死代码，
// 生产唯一活路径是 web 实现）。本表 handler 的校验/强转/响应形状均以 web 实现为准
// （生产行为严格不变），1.2 drift 明细表的逐项拍板结论：
//
//   switchModel / getModelOverride / clearModelOverride → 归属 web（modelOverride hook）
//   load        → 基座归属 web（restoreSession 直返 null 不抛），装饰归属 web（streamSnapshot+activeRun）
//   delete      → 基座归属 web（sm.deleteSession，删当前会话不自动重建），清理统一桌面同款
//                 （browser link 结束 + 终端 PTY dispose——方案 2.2 明定的行为收口，web 此前缺）
//   create      → 归属 web（title 缺省 + workingDirectory/expertRoleId 白名单）
//   rewindToPrompt / rewindConversation / restoreConversationRewind → 归属 web
//                 （runRegistry 状态源 + 写后失效；桌面 appService 版的 taskManager 状态源不再走）
//   fork        → 归属 web（SessionForkService 直构，runRegistry 状态源；appService 版的
//                 fork 后 context 投影不在 web 生产行为内）
//   list / update → 基座归属 web（sm 直调：list 无 durable 投影、update 无 engine 门）
//   写后失效    → 归属 web（invalidateAfterWrite hook：invalidateSessionCache + messages projection）
//
// 错误契约：code 透传沿用原 web catch 的宽判定（任何带 string code 的错误透传其 code，
// 其余 INTERNAL_ERROR）；SERVICE_UNAVAILABLE / INVALID_PAYLOAD / INVALID_ACTION 以
// SessionRouteError 携带 code 抛出，经表的 resolveErrorCode 落进同一响应形状。
//
// 两侧差异全部沉入 SessionCommandContext（方案 2.1 B3）：
//   - 桌面实现 createDesktopSessionContext（本文件）：AppService 直连；
//   - web 实现 createWebSessionContext（src/web/sessionDomainHandler.ts）：
//     惰性 createSessionApplicationService 平移 + sm 直调四动作原样 + modelSessionState。
//
// 本文件静态依赖保持轻量（zod/schema/类型/logger）；host 服务（终端/浏览器 link/
// 历史恢复/跨会话搜索）一律 handler 内动态 import，对齐原 web handler 的按需装载。

import type { Session } from '../../../shared/contract';
import type {
  AgentApplicationService,
  ModelOverride,
  SessionListQueryOptions,
  SwitchModelParams,
} from '../../../shared/contract/appService';
import type { CreateSessionForkRequest, CreateSessionForkResult } from '../../../shared/contract/sessionFork';
import type {
  RestoreConversationRewindRequest,
  RestoreConversationRewindResult,
  RewindConversationRequest,
  RewindConversationResult,
} from '../../../shared/contract/sessionRewind';
import type {
  ExportSessionForkRequest,
  ImportSessionForkRequest,
  EnqueueSessionForkSyncRequest,
  IngestSessionForkSyncRequest,
  ImportReadySessionForkSyncRequest,
  SearchSessionForkExportsRequest,
  ReadSessionForkTreeRequest,
  ReadSessionForkNeighborhoodRequest,
} from '../../../shared/contract/sessionForkPortability';
import type { HistoricalSessionRecoveryRequest } from '../../../shared/contract/historicalSessionRecovery';
import type { CrossSessionSearchOptions } from '../../../shared/ipc/types';
import type { DomainRouteHandlers, DomainRouteTable } from '../../../shared/ipc/domainRoutes';
import { SessionSchemas, type SessionDomainRequest } from '../../../shared/ipc/schemas/session';
import { defineDomainRoutes } from './registry';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('SessionRoutes');

/** 表 handler 直接复用的 AgentApplicationService 子集（两侧实现一致的 action 走它） */
export type SessionCommandService = Pick<
  AgentApplicationService,
  | 'listSessions'
  | 'createSession'
  | 'findExpertThreadSession'
  | 'getMessages'
  | 'getSessionTasks'
  | 'getForkLineage'
  | 'listForkChildren'
  | 'exportSessionFork'
  | 'importSessionFork'
  | 'enqueueSessionForkSync'
  | 'ingestSessionForkSync'
  | 'importReadySessionForkSync'
  | 'searchSessionForkExports'
  | 'readSessionForkTree'
  | 'readSessionForkNeighborhood'
  | 'replayConversationBranch'
  | 'compareConversationBranches'
  | 'traceConversationProvenance'
  | 'auditConversationLineage'
  | 'quarantineConversationLineage'
  | 'repairConversationLineage'
  | 'recordConversationEvaluationAttribution'
  | 'listConversationEvaluationAttributions'
  | 'restoreWorkspaceFilesAtCheckpoint'
  | 'turnCheckout'
  | 'turnRedo'
  | 'exportSession'
  | 'exportSessionMarkdown'
  | 'exportSessionDiagnostics'
  | 'importSession'
  | 'getMemoryContext'
  | 'archiveSession'
  | 'unarchiveSession'
>;

/**
 * session 域命令上下文：桌面（AppService 直连）与 web（惰性装配 + sm 直调平移）
 * 的差异面。访问 sessions()/ensureBackend() 即过 backend 门（web: DB 未就绪 →
 * SERVICE_UNAVAILABLE；桌面: AppService 未初始化 → INTERNAL_ERROR）。
 */
export interface SessionCommandContext {
  /** 两侧实现一致的 service 动作面（web 每请求惰性构造，桌面 AppService 直连） */
  sessions(): Promise<SessionCommandService>;
  /** 纯 host 构造 action（fork/rewind 家族、getRecap、recoverHistory）的 backend 门 */
  ensureBackend(): Promise<void>;
  // —— 1.2 drift 表逐项拍板后的显式差异面（归属见文件头） ——
  /** web: sm.listSessions 直调（无 durable 投影）；桌面: appService.listSessions */
  listSessions(options?: SessionListQueryOptions): Promise<Session[]>;
  /** web: sm.restoreSession（null 透传不抛）；桌面: appService.loadSession（缺失抛错） */
  loadSession(sessionId: string): Promise<Session | null>;
  /** web: 挂 streamSnapshot + activeRun（runtime-only，不进 DB）；桌面: no-op */
  decorateLoadedSession(session: Session): Promise<void>;
  /** web: sm.deleteSession（不自动重建当前会话）；桌面: appService.deleteSession（自动重建） */
  deleteSession(sessionId: string): Promise<void>;
  /** web: sm.updateSession 直调（无 engine 门）；桌面: appService.updateSession */
  updateSession(sessionId: string, updates: Partial<Session>): Promise<void>;
  /** web: SessionForkService 直构（runRegistry 状态源）；桌面: appService.forkSession */
  forkSession(params: CreateSessionForkRequest): Promise<CreateSessionForkResult>;
  /** web: SessionRewindService 直构 + 写后失效；桌面: appService.rewindConversation */
  rewindConversation(params: RewindConversationRequest): Promise<RewindConversationResult>;
  /** web: SessionRewindService 直构 + 写后失效；桌面: appService.restoreConversationRewind */
  restoreConversationRewind(params: RestoreConversationRewindRequest): Promise<RestoreConversationRewindResult>;
  /** web: invalidateSessionCache + messages projection 失效；桌面: no-op */
  invalidateAfterWrite(sessionId: string): Promise<void>;
  /** web: modelSessionState + db 门控持久化；桌面: appService 三件套 */
  readonly modelOverride: {
    switchModel(params: SwitchModelParams): Promise<{ persisted: boolean }>;
    getOverride(sessionId: string): Promise<ModelOverride | undefined | null>;
    clearOverride(sessionId: string): Promise<{ persisted: boolean }>;
  };
}

/** 域内校验/桩错误：携带 IPC error code，经 resolveSessionErrorCode 透传进响应 */
class SessionRouteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** web backend 门失败（DB 未就绪 / SessionManager 不可用）——原 web handler 同款响应 */
export class SessionBackendUnavailableError extends SessionRouteError {
  constructor() {
    super('SERVICE_UNAVAILABLE', 'SessionManager not available');
  }
}

function invalidPayload(message: string): never {
  throw new SessionRouteError('INVALID_PAYLOAD', message);
}

/** trim 后非空才放行（原 web 校验同款），空值 → INVALID_PAYLOAD */
function requireTrimmed(value: unknown, message: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) invalidPayload(message);
  return trimmed;
}

const SESSION_HANDLERS: DomainRouteHandlers<SessionDomainRequest, SessionCommandContext> = {
  archive: async (ctx, payload) =>
    (await ctx.sessions()).archiveSession((payload as { sessionId?: string } | undefined)?.sessionId as string),

  auditConversationLineage: async (ctx, payload) =>
    (await ctx.sessions()).auditConversationLineage(
      requireTrimmed((payload as { sessionId?: string } | undefined)?.sessionId, 'sessionId is required'),
    ),

  clearModelOverride: async (ctx, payload) => {
    const sessionId = (payload as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) invalidPayload('sessionId is required');
    const result = await ctx.modelOverride.clearOverride(sessionId);
    return { persisted: result.persisted };
  },

  compareConversationBranches: async (ctx, payload) => {
    const p = payload as { leftSessionId?: string; rightSessionId?: string } | undefined;
    const leftSessionId = requireTrimmed(p?.leftSessionId, 'leftSessionId and rightSessionId are required');
    const rightSessionId = requireTrimmed(p?.rightSessionId, 'leftSessionId and rightSessionId are required');
    return (await ctx.sessions()).compareConversationBranches(leftSessionId, rightSessionId);
  },

  create: async (ctx, payload) => {
    const p = payload as { title?: string; workingDirectory?: string; expertRoleId?: string } | undefined;
    return (await ctx.sessions()).createSession({
      title: p?.title || 'New Session',
      workingDirectory: typeof p?.workingDirectory === 'string' ? p.workingDirectory : undefined,
      expertRoleId: p?.expertRoleId,
    });
  },

  delete: async (ctx, payload) => {
    const sessionId = (payload as { sessionId?: string } | undefined)?.sessionId as string;
    // afterSessionDeleted 统一为桌面同款清理（方案 2.2 行为收口，web 此前缺）：
    // 会话没了，它挂着的 browser link 要结束，长生命周期 PTY 也不能继续留着
    // （没有超时会自己收它；dispose 等整树确认退出才返回）。
    const { getUserBrowserLinkService } = await import('../../services/surfaceExecution/UserBrowserLinkService');
    await getUserBrowserLinkService().end(sessionId, 'session-switch').catch((error) => {
      logger.warn('Failed to end user browser run before deleting session', {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    await ctx.deleteSession(sessionId);
    const { disposeTerminalSession } = await import('../../services/terminal/terminalSessionManager');
    await disposeTerminalSession(sessionId);
    return null;
  },

  enqueueSessionForkSync: async (ctx, payload) =>
    (await ctx.sessions()).enqueueSessionForkSync((payload ?? {}) as EnqueueSessionForkSyncRequest),

  export: async (ctx, payload) =>
    (await ctx.sessions()).exportSession((payload as { sessionId?: string } | undefined)?.sessionId as string),

  exportDiagnostics: async (ctx, payload) =>
    (await ctx.sessions()).exportSessionDiagnostics(
      (payload as { sessionId?: string } | undefined)?.sessionId as string,
    ),

  exportMarkdown: async (ctx, payload) =>
    (await ctx.sessions()).exportSessionMarkdown(
      (payload as { sessionId?: string } | undefined)?.sessionId as string,
    ),

  exportSessionFork: async (ctx, payload) =>
    (await ctx.sessions()).exportSessionFork((payload ?? {}) as ExportSessionForkRequest),

  fork: async (ctx, payload) => {
    const p = payload as {
      sourceSessionId?: string;
      anchorAssistantMessageId?: string;
      idempotencyKey?: string;
      workspaceMode?: 'shared_current' | 'isolated_at_anchor';
    } | undefined;
    const message = 'sourceSessionId, anchorAssistantMessageId and idempotencyKey are required';
    const sourceSessionId = requireTrimmed(p?.sourceSessionId, message);
    const anchorAssistantMessageId = requireTrimmed(p?.anchorAssistantMessageId, message);
    const idempotencyKey = requireTrimmed(p?.idempotencyKey, message);
    return ctx.forkSession({
      sourceSessionId,
      anchorAssistantMessageId,
      idempotencyKey,
      workspaceMode: p?.workspaceMode === 'isolated_at_anchor' ? 'isolated_at_anchor' : 'shared_current',
    });
  },

  getForkLineage: async (ctx, payload) =>
    (await ctx.sessions()).getForkLineage(
      requireTrimmed((payload as { sessionId?: string } | undefined)?.sessionId, 'sessionId is required'),
    ),

  findExpertThread: async (ctx, payload) =>
    (await ctx.sessions()).findExpertThreadSession(
      requireTrimmed((payload as { roleId?: string } | undefined)?.roleId, 'roleId is required'),
    ),

  getMemoryContext: async (ctx, payload) => {
    const p = payload as { sessionId: string; workingDirectory?: string; query?: string };
    return (await ctx.sessions()).getMemoryContext(p.sessionId, p.workingDirectory, p.query);
  },

  getMessages: async (ctx, payload) =>
    (await ctx.sessions()).getMessages((payload as { sessionId?: string } | undefined)?.sessionId as string),

  getModelOverride: async (ctx, payload) => {
    const sessionId = (payload as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) invalidPayload('sessionId is required');
    return ctx.modelOverride.getOverride(sessionId);
  },

  getRecap: async (ctx, payload) => {
    // A6 回会话追赶：素材只来自产物快照 + 任务账本，不读消息流水。
    await ctx.ensureBackend();
    const p = payload as { sessionId?: string; since?: number } | undefined;
    const sessionId = requireTrimmed(p?.sessionId, 'sessionId is required');
    const since = typeof p?.since === 'number' ? p.since : 0;
    const { getSessionRecap } = await import('../../session/sessionRecapService');
    return getSessionRecap(sessionId, since);
  },

  getSessionTasks: async (ctx, payload) =>
    (await ctx.sessions()).getSessionTasks(
      requireTrimmed((payload as { sessionId?: string } | undefined)?.sessionId, 'sessionId is required'),
    ),

  import: async (ctx, payload) => (await ctx.sessions()).importSession((payload as { data: unknown }).data),

  importReadySessionForkSync: async (ctx, payload) =>
    (await ctx.sessions()).importReadySessionForkSync((payload ?? {}) as ImportReadySessionForkSyncRequest),

  importSessionFork: async (ctx, payload) =>
    (await ctx.sessions()).importSessionFork((payload ?? {}) as ImportSessionForkRequest),

  ingestSessionForkSync: async (ctx, payload) =>
    (await ctx.sessions()).ingestSessionForkSync((payload ?? {}) as IngestSessionForkSyncRequest),

  list: async (ctx, payload) => ctx.listSessions(payload as SessionListQueryOptions | undefined),

  listConversationEvaluationAttributions: async (ctx, payload) =>
    (await ctx.sessions()).listConversationEvaluationAttributions(
      requireTrimmed((payload as { sessionId?: string } | undefined)?.sessionId, 'sessionId is required'),
    ),

  listForkChildren: async (ctx, payload) =>
    (await ctx.sessions()).listForkChildren(
      requireTrimmed((payload as { sessionId?: string } | undefined)?.sessionId, 'sessionId is required'),
    ),

  load: async (ctx, payload) => {
    const session = await ctx.loadSession(
      (payload as { sessionId?: string } | undefined)?.sessionId as string,
    );
    if (session) await ctx.decorateLoadedSession(session);
    return session;
  },

  quarantineConversationLineage: async (ctx, payload) => {
    const p = payload as { sessionId?: string; idempotencyKey?: string } | undefined;
    const sessionId = requireTrimmed(p?.sessionId, 'sessionId is required');
    const idempotencyKey = requireTrimmed(p?.idempotencyKey, 'idempotencyKey is required');
    return (await ctx.sessions()).quarantineConversationLineage(sessionId, idempotencyKey);
  },

  readSessionForkNeighborhood: async (ctx, payload) =>
    (await ctx.sessions()).readSessionForkNeighborhood((payload ?? {}) as ReadSessionForkNeighborhoodRequest),

  readSessionForkTree: async (ctx, payload) =>
    (await ctx.sessions()).readSessionForkTree((payload ?? {}) as ReadSessionForkTreeRequest),

  recordConversationEvaluationAttribution: async (ctx, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const sessionId = requireTrimmed(p.sessionId, 'sessionId is required');
    return (await ctx.sessions()).recordConversationEvaluationAttribution({
      sessionId,
      evaluationId: String(p.evaluationId ?? ''),
      runId: typeof p.runId === 'string' ? p.runId : null,
      metric: String(p.metric ?? ''),
      value: Number(p.value),
      attributedMessageIds: Array.isArray(p.attributedMessageIds)
        ? p.attributedMessageIds.filter((item): item is string => typeof item === 'string')
        : [],
      idempotencyKey: String(p.idempotencyKey ?? ''),
    });
  },

  recoverHistory: async (ctx, payload) => {
    await ctx.ensureBackend();
    const { recoverHistoricalSession } = await import('../historicalSessionRecovery');
    return recoverHistoricalSession(payload as HistoricalSessionRecoveryRequest);
  },

  repairConversationLineage: async (ctx, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const sessionId = requireTrimmed(p.sessionId, 'sessionId is required');
    return (await ctx.sessions()).repairConversationLineage({
      sessionId,
      issueDigest: String(p.issueDigest ?? ''),
      reason: String(p.reason ?? ''),
      idempotencyKey: String(p.idempotencyKey ?? ''),
    });
  },

  replayConversationBranch: async (ctx, payload) => {
    const p = payload as {
      sessionId?: string;
      options?: { includeRewound?: boolean; allowRepairOverride?: boolean };
    } | undefined;
    const sessionId = requireTrimmed(p?.sessionId, 'sessionId is required');
    return (await ctx.sessions()).replayConversationBranch(sessionId, p?.options);
  },

  restoreConversationRewind: async (ctx, payload) => {
    const p = payload as { sessionId?: string; rewindId?: string } | undefined;
    const message = 'sessionId and rewindId are required';
    const sessionId = requireTrimmed(p?.sessionId, message);
    const rewindId = requireTrimmed(p?.rewindId, message);
    return ctx.restoreConversationRewind({ sessionId, rewindId });
  },

  restoreWorkspaceFilesAtCheckpoint: async (ctx, payload) => {
    const p = payload as { sessionId?: string; checkpointMessageId?: string } | undefined;
    return (await ctx.sessions()).restoreWorkspaceFilesAtCheckpoint({
      sessionId: typeof p?.sessionId === 'string' ? p.sessionId : '',
      checkpointMessageId: typeof p?.checkpointMessageId === 'string' ? p.checkpointMessageId : '',
    });
  },

  rewindConversation: async (ctx, payload) => {
    const p = payload as { sessionId?: string; anchorUserMessageId?: string; idempotencyKey?: string } | undefined;
    const message = 'sessionId, anchorUserMessageId and idempotencyKey are required';
    const sessionId = requireTrimmed(p?.sessionId, message);
    const anchorUserMessageId = requireTrimmed(p?.anchorUserMessageId, message);
    const idempotencyKey = requireTrimmed(p?.idempotencyKey, message);
    return ctx.rewindConversation({ sessionId, anchorUserMessageId, idempotencyKey });
  },

  rewindToPrompt: async (ctx, payload) => {
    const p = payload as {
      sessionId?: string;
      userMessageId?: string;
      anchorUserMessageId?: string;
      idempotencyKey?: string;
    } | undefined;
    const sessionId = requireTrimmed(p?.sessionId, 'sessionId and userMessageId are required');
    // anchorUserMessageId / userMessageId 双名兼容（anchor 优先），legacy 入口缺
    // idempotencyKey 时按会话+锚点幂等合成（原 web 语义）
    const userMessageId = typeof p?.anchorUserMessageId === 'string'
      ? p.anchorUserMessageId.trim()
      : typeof p?.userMessageId === 'string'
        ? p.userMessageId.trim()
        : '';
    if (!userMessageId) invalidPayload('sessionId and userMessageId are required');
    const supplied = typeof p?.idempotencyKey === 'string' ? p.idempotencyKey.trim() : '';
    return ctx.rewindConversation({
      sessionId,
      anchorUserMessageId: userMessageId,
      idempotencyKey: supplied ? supplied : `legacy:${sessionId}:${userMessageId}`,
    });
  },

  search: async (ctx, payload) => {
    const svc = await ctx.sessions();
    const p = payload as { query: string; options?: CrossSessionSearchOptions };
    // 动态 import 断开与 session.ipc 的静态环（session.ipc 装配本表）
    const { performCrossSessionSearch } = await import('../session.ipc');
    return performCrossSessionSearch(p.query, p.options, () => svc as unknown as AgentApplicationService);
  },

  searchSessionForkExports: async (ctx, payload) =>
    (await ctx.sessions()).searchSessionForkExports((payload ?? {}) as SearchSessionForkExportsRequest),

  traceConversationProvenance: async (ctx, payload) => {
    const p = payload as { sessionId?: string; messageId?: string } | undefined;
    const sessionId = requireTrimmed(p?.sessionId, 'sessionId is required');
    const messageId = requireTrimmed(p?.messageId, 'messageId is required');
    return (await ctx.sessions()).traceConversationProvenance(sessionId, messageId);
  },

  switchModel: async (ctx, payload) => {
    const p = payload as SwitchModelParams | undefined;
    if (!p?.sessionId || !p?.provider || !p?.model) {
      invalidPayload('sessionId, provider and model are required');
    }
    const result = await ctx.modelOverride.switchModel(p);
    return { provider: p.provider, model: p.model, adaptive: p.adaptive, persisted: result.persisted };
  },

  turnCheckout: async (ctx, payload) => {
    const p = payload as { sessionId?: string; userMessageId?: string; idempotencyKey?: string } | undefined;
    const data = await (await ctx.sessions()).turnCheckout({
      sessionId: typeof p?.sessionId === 'string' ? p.sessionId : '',
      userMessageId: typeof p?.userMessageId === 'string' ? p.userMessageId : '',
      ...(typeof p?.idempotencyKey === 'string' ? { idempotencyKey: p.idempotencyKey } : {}),
    });
    await ctx.invalidateAfterWrite(typeof p?.sessionId === 'string' ? p.sessionId : '');
    return data;
  },

  turnRedo: async (ctx, payload) => {
    const p = payload as { sessionId?: string; rewindId?: string } | undefined;
    const data = await (await ctx.sessions()).turnRedo({
      sessionId: typeof p?.sessionId === 'string' ? p.sessionId : '',
      rewindId: typeof p?.rewindId === 'string' ? p.rewindId : '',
    });
    await ctx.invalidateAfterWrite(typeof p?.sessionId === 'string' ? p.sessionId : '');
    return data;
  },

  unarchive: async (ctx, payload) =>
    (await ctx.sessions()).unarchiveSession((payload as { sessionId?: string } | undefined)?.sessionId as string),

  update: async (ctx, payload) => {
    const p = payload as { sessionId?: string; updates?: Partial<Session> } | undefined;
    await ctx.updateSession(p?.sessionId as string, p?.updates || {});
    return null;
  },
};

/**
 * web:false 暂缓清单（刀 2 基线平移，数量 5 不变）：desktop-only gap action 在 web
 * 形态表里是 INVALID_ACTION 桩（生产行为平移），刀 3 逐个补齐后清零。
 * 对账数据走 defineSessionRoutes('web').disabledActions（parity 门棘轮从表上读，
 * 不另设测试专用导出）。
 */
const SESSION_PENDING_WEB_ACTIONS = [
  'exportDiagnostics',
  'exportMarkdown',
  'getMemoryContext',
  'import',
  'search',
] as const;

const pendingWebActionStub = (action: string) => async (ctx: SessionCommandContext) => {
  // 先过 backend 门再落桩，对齐原 web handler「门在 switch 之前」的顺序
  await ctx.ensureBackend();
  throw new SessionRouteError('INVALID_ACTION', `Unknown session action: ${action}`);
};

const WEB_PENDING_ACTION_STUBS = {
  exportDiagnostics: pendingWebActionStub('exportDiagnostics'),
  exportMarkdown: pendingWebActionStub('exportMarkdown'),
  getMemoryContext: pendingWebActionStub('getMemoryContext'),
  import: pendingWebActionStub('import'),
  search: pendingWebActionStub('search'),
} satisfies Partial<DomainRouteHandlers<SessionDomainRequest, SessionCommandContext>>;

/** 错误 code 透传（原 web catch 同款宽判定）：带 string code 的错误透传，其余 INTERNAL_ERROR */
const resolveSessionErrorCode = (error: unknown): string | undefined => {
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
};

/**
 * session 域路由表。`web` 形态 = 生产形态（5 个暂缓 action 落 INVALID_ACTION 桩、
 * 未知 action 文案保持 `Unknown session action: <action>`）；`desktop` 形态 = 全量
 * 真实现（AppService 直连 context 用）。
 */
export function defineSessionRoutes(
  surface: 'desktop' | 'web',
): DomainRouteTable<SessionDomainRequest, SessionCommandContext> {
  const actions: DomainRouteHandlers<SessionDomainRequest, SessionCommandContext> =
    surface === 'web' ? { ...SESSION_HANDLERS, ...WEB_PENDING_ACTION_STUBS } : SESSION_HANDLERS;
  return defineDomainRoutes(SessionSchemas.REQUEST, actions, {
    resolveErrorCode: resolveSessionErrorCode,
    ...(surface === 'web'
      ? {
          unknownActionMessage: (action) => `Unknown session action: ${String(action)}`,
          disabledActions: SESSION_PENDING_WEB_ACTIONS,
        }
      : {}),
  });
}

/** 全量（桌面）形态——parity 门三面对账真源；桌面装配直接用它 */
export const sessionRoutes = defineSessionRoutes('desktop');

/**
 * 桌面 context（方案 2.2 表：AppService 直连）。AppService 未初始化时抛
 * 'Services not initialized'（原桌面 requireAppService 语义 → INTERNAL_ERROR）。
 */
export function createDesktopSessionContext(
  getAppService: () => AgentApplicationService | null,
): SessionCommandContext {
  const requireAppService = (): AgentApplicationService => {
    const svc = getAppService();
    if (!svc) throw new Error('Services not initialized');
    return svc;
  };
  return {
    sessions: async () => requireAppService(),
    ensureBackend: async () => {
      requireAppService();
    },
    listSessions: (options) => requireAppService().listSessions(options),
    loadSession: (sessionId) => requireAppService().loadSession(sessionId),
    decorateLoadedSession: async () => {},
    deleteSession: (sessionId) => requireAppService().deleteSession(sessionId),
    updateSession: (sessionId, updates) => requireAppService().updateSession(sessionId, updates),
    forkSession: (params) => requireAppService().forkSession(params),
    rewindConversation: (params) => requireAppService().rewindConversation(params),
    restoreConversationRewind: (params) => requireAppService().restoreConversationRewind(params),
    invalidateAfterWrite: async () => {},
    modelOverride: {
      switchModel: (params) => requireAppService().switchModel(params),
      getOverride: async (sessionId) => requireAppService().getModelOverride(sessionId),
      clearOverride: (sessionId) => requireAppService().clearModelOverride(sessionId),
    },
  };
}
