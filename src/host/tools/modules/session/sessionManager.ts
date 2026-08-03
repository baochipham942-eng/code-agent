import { createHash } from 'node:crypto';

import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { Session } from '../../../../shared/contract/session';
import type { Message } from '../../../../shared/contract/message';
import { SessionForkError } from '../../../../shared/contract/sessionFork';
import { SessionHistoryAppService } from '../../../app/sessionHistoryAppService';
import { resolveSessionDefaultModelConfig } from '../../../services/core/sessionDefaults';
import { getSessionManager } from '../../../services/infra/sessionManager';
import { getTaskManager } from '../../../task/TaskManager';
import { sessionManagerSchema as schema } from './sessionManager.schema';

type SessionManagerAction = 'list' | 'get' | 'create' | 'fork' | 'archive' | 'unarchive' | 'rename';
type ListScope = 'active' | 'archived' | 'all';

const MUTATING_ACTIONS = new Set<SessionManagerAction>(['create', 'fork', 'archive', 'unarchive', 'rename']);
const RUNNING_STATUSES = new Set<string>(['running', 'queued', 'paused', 'cancelling']);

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function normalizeAction(value: unknown): SessionManagerAction | null {
  if (typeof value !== 'string') return null;
  if (['list', 'get', 'create', 'fork', 'archive', 'unarchive', 'rename'].includes(value)) {
    return value as SessionManagerAction;
  }
  return null;
}

function normalizeScope(value: unknown): ListScope {
  return value === 'archived' || value === 'all' ? value : 'active';
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  return Math.min(Math.max(Math.trunc(value), 1), 100);
}

function matchesQuery(session: Session, query: string): boolean {
  const normalized = query.toLowerCase();
  return [
    session.id,
    session.title,
    session.workingDirectory,
  ].some((value) => typeof value === 'string' && value.toLowerCase().includes(normalized));
}

function getSessionSummary(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    status: session.status ?? 'idle',
    isArchived: Boolean(session.isArchived || session.status === 'archived'),
    archivedAt: session.archivedAt,
    type: session.type ?? 'chat',
    workingDirectory: session.workingDirectory ?? null,
    parentSessionId: session.parentSessionId ?? null,
    sourceRunId: session.sourceRunId ?? null,
    origin: session.origin ?? null,
    readOnly: Boolean(session.readOnly),
    messageCount: (session as Session & { messageCount?: number }).messageCount ?? 0,
    turnCount: session.turnCount ?? 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    gitBranch: session.gitBranch ?? null,
  };
}

function formatSessionLine(session: Session): string {
  const status = session.status ?? 'idle';
  const archived = session.isArchived || status === 'archived' ? ' archived' : '';
  const cwd = session.workingDirectory ? ` cwd=${session.workingDirectory}` : '';
  return `- ${session.id}: ${session.title} [${status}${archived}]${cwd}`;
}

function isRunningStatus(status?: string | null): boolean {
  return status ? RUNNING_STATUSES.has(status) : false;
}

async function requireMutationPermission(
  action: SessionManagerAction,
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  target?: Session | null,
): Promise<ToolResult<never> | null> {
  if (!MUTATING_ACTIONS.has(action)) return null;

  const targetLabel = target ? `${target.title} (${target.id})` : asTrimmedString(args.sessionId) ?? 'new session';
  const reason = asTrimmedString(args.reason)
    ?? (action === 'create'
      ? 'Create a session from the current session'
      : action === 'fork'
        ? `Create a fork from session ${targetLabel}`
      : `${action} session ${targetLabel}`);

  const permit = await canUseTool(
    schema.name,
    args,
    reason,
    {
      sessionId: ctx.sessionId,
      type: 'command',
      tool: schema.name,
      details: {
        action,
        targetSessionId: target?.id ?? asTrimmedString(args.sessionId) ?? null,
        targetTitle: target?.title ?? asTrimmedString(args.title) ?? null,
      },
      reason,
      dangerLevel: action === 'archive' ? 'warning' : 'normal',
    },
  );

  if (!permit.allow) {
    return {
      ok: false,
      error: `permission denied: ${permit.reason}`,
      code: 'PERMISSION_DENIED',
    };
  }
  return null;
}

async function executeList(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult<string>> {
  const sessionManager = getSessionManager();
  const scope = normalizeScope(args.scope);
  const limit = normalizeLimit(args.limit);
  const query = asTrimmedString(args.query);
  const currentWorkingDirectoryOnly = args.currentWorkingDirectoryOnly === true;

  const sessions = scope === 'archived'
    ? await sessionManager.listArchivedSessions(limit, 0)
    : await sessionManager.listSessions({
        limit,
        includeArchived: scope === 'all',
        ...(query ? { searchQuery: query } : {}),
      });

  const queryFiltered = query
    ? sessions.filter((session) => matchesQuery(session, query))
    : sessions;
  const currentWorkingDir = ctx.workingDir?.trim();
  const filtered = currentWorkingDirectoryOnly && currentWorkingDir
    ? queryFiltered.filter((session) => session.workingDirectory === currentWorkingDir)
    : queryFiltered;

  const lines = filtered.map(formatSessionLine);
  return {
    ok: true,
    output: lines.length > 0
      ? `Sessions (${filtered.length}, scope=${scope}):\n${lines.join('\n')}`
      : `No sessions found (scope=${scope}).`,
    meta: {
      action: 'list',
      scope,
      sessions: filtered.map(getSessionSummary),
    },
  };
}

async function executeGet(args: Record<string, unknown>): Promise<ToolResult<string>> {
  const sessionId = asTrimmedString(args.sessionId);
  if (!sessionId) {
    return { ok: false, error: 'sessionId is required', code: 'INVALID_ARGS' };
  }

  const session = await getSessionManager().getSession(sessionId, 1);
  if (!session) {
    return { ok: false, error: `Session not found: ${sessionId}`, code: 'NOT_FOUND' };
  }

  return {
    ok: true,
    output: `Session ${session.id}: ${session.title}\nStatus: ${session.status ?? 'idle'}\nWorking directory: ${session.workingDirectory ?? 'none'}`,
    meta: {
      action: 'get',
      session: getSessionSummary(session),
    },
  };
}

async function resolveParentSession(ctx: ToolContext): Promise<Session | null> {
  if (!ctx.sessionId || ctx.sessionId === 'protocol-unknown') {
    return null;
  }
  return getSessionManager().getSession(ctx.sessionId, 1);
}

function resolveWorkingDirectory(
  args: Record<string, unknown>,
  parentSession: Session | null,
  ctx: ToolContext,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(args, 'workingDirectory')) {
    const explicit = asTrimmedString(args.workingDirectory);
    return explicit || undefined;
  }
  if (args.inheritCurrentContext === false) {
    return undefined;
  }
  return parentSession?.workingDirectory || ctx.workingDir || undefined;
}

async function executeCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const permission = await requireMutationPermission('create', args, ctx, canUseTool);
  if (permission) return permission;

  const sessionManager = getSessionManager();
  const parentSession = await resolveParentSession(ctx);
  const inheritCurrentContext = args.inheritCurrentContext !== false;
  const title = asTrimmedString(args.title) || 'New Session';
  const workingDirectory = resolveWorkingDirectory(args, parentSession, ctx);
  const modelConfig = inheritCurrentContext && parentSession
    ? parentSession.modelConfig
    : resolveSessionDefaultModelConfig();
  const parentSessionId = parentSession?.id ?? (ctx.sessionId === 'protocol-unknown' ? undefined : ctx.sessionId);

  const session = await sessionManager.createSession({
    title,
    modelConfig,
    workingDirectory,
    parentSessionId,
    sourceRunId: ctx.currentToolCallId,
    type: 'chat',
    readOnly: args.readOnly === true,
    origin: {
      kind: 'agent_session_manager',
      id: parentSessionId,
      name: 'SessionManager',
      metadata: {
        parentSessionId,
        reason: asTrimmedString(args.reason) ?? null,
      },
    },
  });

  const handoffContent = asTrimmedString(args.handoffContent);
  if (handoffContent) {
    const message: Message = {
      id: `handoff-${session.id}-${Date.now()}`,
      role: 'user',
      content: handoffContent,
      timestamp: Date.now(),
      source: 'system',
    };
    await sessionManager.addMessageToSession(session.id, message);
  }

  const reloaded = await sessionManager.getSession(session.id, 1);
  const created = reloaded ?? session;
  const summary = getSessionSummary(created);

  return {
    ok: true,
    output: `Created session ${created.id}: ${created.title}`,
    meta: {
      action: 'create',
      session: summary,
      currentSessionPreserved: true,
      handoffMessageCreated: Boolean(handoffContent),
    },
  };
}

function isCompletedAssistantForkAnchor(message: Message): boolean {
  return message.role === 'assistant'
    && !message.isMeta
    && message.subtype !== 'tool_use'
    && (message.visibility ?? 'active') === 'active'
    && message.content.trim().length > 0
    && (!message.toolCalls || message.toolCalls.length === 0)
    && !message.contentParts?.some((part) => part.type === 'tool_call');
}

function createForkIdempotencyKey(sessionId: string, anchorMessageId: string): string {
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(anchorMessageId)
    .digest('hex');
  return `agent-session-fork:${digest}`;
}

function forkFailure(
  error: unknown,
  sourceSessionId: string,
  anchorMessageId?: string,
): ToolResult<string> {
  const code = error instanceof SessionForkError ? error.code : 'FORK_OPERATION_FAILED';
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code,
    meta: {
      action: 'fork',
      sourceSessionId,
      anchorMessageId: anchorMessageId ?? null,
    },
  };
}

async function executeFork(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const explicitSessionId = asTrimmedString(args.sessionId);
  const sourceSessionId = explicitSessionId
    || (ctx.sessionId !== 'protocol-unknown' ? ctx.sessionId.trim() : '');
  if (!sourceSessionId) {
    return {
      ok: false,
      error: 'sessionId is required when there is no current session',
      code: 'INVALID_ARGS',
      meta: { action: 'fork' },
    };
  }

  let anchorMessageId = asTrimmedString(args.anchorMessageId);
  try {
    const sessionManager = getSessionManager();
    const sourceSession = await sessionManager.getSession(sourceSessionId, 1);
    if (!sourceSession) {
      return {
        ok: false,
        error: `Session not found: ${sourceSessionId}`,
        code: 'SESSION_NOT_FOUND',
        meta: { action: 'fork', sourceSessionId },
      };
    }

    const runtimeState = getTaskManager().getSessionState(sourceSessionId);
    const runningStatus = isRunningStatus(runtimeState.status)
      ? runtimeState.status
      : isRunningStatus(sourceSession.status)
        ? sourceSession.status
        : undefined;
    if (runningStatus) {
      return {
        ok: false,
        error: `Refusing to fork running session ${sourceSessionId} (status=${runningStatus})`,
        code: 'SESSION_RUNNING',
        meta: {
          action: 'fork',
          sourceSessionId,
          runtimeStatus: runtimeState.status,
          sessionStatus: sourceSession.status ?? null,
        },
      };
    }

    if (!anchorMessageId) {
      const messages = await sessionManager.getMessages(sourceSessionId);
      anchorMessageId = [...messages].reverse().find(isCompletedAssistantForkAnchor)?.id;
      if (!anchorMessageId) {
        return {
          ok: false,
          error: `No completed assistant message is available to fork in session ${sourceSessionId}`,
          code: 'INVALID_ANCHOR',
          meta: { action: 'fork', sourceSessionId, anchorMessageId: null },
        };
      }
    }

    const permissionArgs = {
      ...args,
      sessionId: sourceSessionId,
      anchorMessageId,
    };
    const permission = await requireMutationPermission(
      'fork',
      permissionArgs,
      ctx,
      canUseTool,
      sourceSession,
    );
    if (permission) return permission;

    const idempotencyKey = createForkIdempotencyKey(sourceSessionId, anchorMessageId);
    const result = await new SessionHistoryAppService(getTaskManager).forkSession({
      sourceSessionId,
      anchorAssistantMessageId: anchorMessageId,
      workspaceMode: 'shared_current',
      idempotencyKey,
    });

    return {
      ok: true,
      output: `Created fork session ${result.childSession.id} "${result.childSession.title}" from parent ${sourceSessionId} at assistant message ${anchorMessageId}.`,
      meta: {
        action: 'fork',
        childSessionId: result.childSession.id,
        title: result.childSession.title,
        parentSessionId: sourceSessionId,
        anchorMessageId,
        workspaceMode: 'shared_current',
        currentSessionPreserved: true,
      },
    };
  } catch (error) {
    return forkFailure(error, sourceSessionId, anchorMessageId);
  }
}

async function loadTargetSession(args: Record<string, unknown>): Promise<ToolResult<never> | Session> {
  const sessionId = asTrimmedString(args.sessionId);
  if (!sessionId) {
    return { ok: false, error: 'sessionId is required', code: 'INVALID_ARGS' };
  }
  const session = await getSessionManager().getSession(sessionId, 1);
  if (!session) {
    return { ok: false, error: `Session not found: ${sessionId}`, code: 'NOT_FOUND' };
  }
  return session;
}

async function executeArchive(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const target = await loadTargetSession(args);
  if ('ok' in target) return target;

  if (target.id === ctx.sessionId) {
    return { ok: false, error: 'Refusing to archive the current session', code: 'CURRENT_SESSION_DENIED' };
  }

  const runtimeState = getTaskManager().getSessionState(target.id);
  if (isRunningStatus(runtimeState.status) || isRunningStatus(target.status)) {
    return {
      ok: false,
      error: `Refusing to archive running session ${target.id} (status=${runtimeState.status || target.status})`,
      code: 'SESSION_RUNNING',
      meta: {
        session: getSessionSummary(target),
        runtimeStatus: runtimeState.status,
      },
    };
  }

  const permission = await requireMutationPermission('archive', args, ctx, canUseTool, target);
  if (permission) return permission;

  const previousStatus = target.status ?? 'idle';
  const archived = await getSessionManager().archiveSession(target.id);
  if (!archived) {
    return { ok: false, error: `Session not found after archive: ${target.id}`, code: 'NOT_FOUND' };
  }

  return {
    ok: true,
    output: `Archived session ${archived.id}: ${archived.title}`,
    meta: {
      action: 'archive',
      previousStatus,
      session: getSessionSummary(archived),
    },
  };
}

async function executeUnarchive(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const target = await loadTargetSession(args);
  if ('ok' in target) return target;

  const permission = await requireMutationPermission('unarchive', args, ctx, canUseTool, target);
  if (permission) return permission;

  const previousStatus = target.status ?? 'idle';
  const restored = await getSessionManager().unarchiveSession(target.id);
  if (!restored) {
    return { ok: false, error: `Session not found after unarchive: ${target.id}`, code: 'NOT_FOUND' };
  }

  return {
    ok: true,
    output: `Unarchived session ${restored.id}: ${restored.title}`,
    meta: {
      action: 'unarchive',
      previousStatus,
      session: getSessionSummary(restored),
    },
  };
}

async function executeRename(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const target = await loadTargetSession(args);
  if ('ok' in target) return target;

  const title = asTrimmedString(args.title);
  if (!title) {
    return { ok: false, error: 'title is required', code: 'INVALID_ARGS' };
  }

  const permission = await requireMutationPermission('rename', args, ctx, canUseTool, target);
  if (permission) return permission;

  await getSessionManager().updateSession(target.id, {
    title,
    updatedAt: Date.now(),
  });
  const renamed = await getSessionManager().getSession(target.id, 1);

  return {
    ok: true,
    output: `Renamed session ${target.id}: ${target.title} -> ${title}`,
    meta: {
      action: 'rename',
      previousTitle: target.title,
      session: renamed ? getSessionSummary(renamed) : { id: target.id, title },
    },
  };
}

export async function executeSessionManager(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = normalizeAction(args.action);
  if (!action) {
    return {
      ok: false,
      error: `Unknown action: ${String(args.action)}. Valid actions: list, get, create, fork, archive, unarchive, rename`,
      code: 'INVALID_ARGS',
    };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `${schema.name}:${action}` });

  let result: ToolResult<string>;
  switch (action) {
    case 'list':
      result = await executeList(args, ctx);
      break;
    case 'get':
      result = await executeGet(args);
      break;
    case 'create':
      result = await executeCreate(args, ctx, canUseTool);
      break;
    case 'fork':
      result = await executeFork(args, ctx, canUseTool);
      break;
    case 'archive':
      result = await executeArchive(args, ctx, canUseTool);
      break;
    case 'unarchive':
      result = await executeUnarchive(args, ctx, canUseTool);
      break;
    case 'rename':
      result = await executeRename(args, ctx, canUseTool);
      break;
  }

  if (result.ok) {
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('SessionManager done', { action });
  }
  return result;
}

class SessionManagerHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeSessionManager(args, ctx, canUseTool, onProgress);
  }
}

export const sessionManagerModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new SessionManagerHandler();
  },
};
