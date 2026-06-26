import type { Message, TodoItem } from '../../shared/contract';
import { IPC_CHANNELS } from '../../shared/ipc';
import { broadcastSSE } from '../helpers/sse';

export class DevApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface DevSupabaseError {
  message?: string;
}

interface DevSupabaseResult {
  data: unknown[] | null;
  error: DevSupabaseError | null;
}

interface DevSupabaseQuery {
  select(columns: string): DevSupabaseQuery;
  eq(column: string, value: string): DevSupabaseQuery;
  order(column: string, options: { ascending: boolean }): DevSupabaseQuery;
  limit(count: number): Promise<DevSupabaseResult>;
}

interface DevSupabaseClient {
  from(table: string): DevSupabaseQuery;
}

export interface DevTelemetrySeedTurnRequest {
  sessionId?: unknown;
  turnId?: unknown;
  title?: unknown;
  userPrompt?: unknown;
  assistantResponse?: unknown;
  modelProvider?: unknown;
  modelName?: unknown;
  workingDirectory?: unknown;
}

export interface DevTodoSeedRequest {
  sessionId?: unknown;
  todos?: unknown;
}

export interface DevCompactStateSeedRequest {
  sessionId?: unknown;
  summaryMessageId?: unknown;
  summary?: unknown;
  compactedMessageIds?: unknown;
  preservedMessageIds?: unknown;
  anchorMessageId?: unknown;
}

export interface NormalizedDevCompactStateSeed {
  sessionId: string;
  summaryMessageId: string;
  summary: string;
  compactedMessageIds: string[];
  preservedMessageIds: string[];
  anchorMessageId: string;
}

export function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DevApiError(400, `${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readOptionalStringArray(value: unknown, fieldName: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    throw new DevApiError(400, `${fieldName} must be an array when provided.`);
  }
  return value.map((item, index) => readRequiredString(item, `${fieldName}[${index}]`));
}

export function normalizeDevTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    throw new DevApiError(400, 'todos must be an array.');
  }

  const allowedStatuses = new Set(['pending', 'in_progress', 'completed']);
  return value.map((item, index): TodoItem => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new DevApiError(400, `todos[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const content = readRequiredString(record.content, `todos[${index}].content`);
    const activeForm = readRequiredString(record.activeForm, `todos[${index}].activeForm`);
    const status = readRequiredString(record.status, `todos[${index}].status`);
    if (!allowedStatuses.has(status)) {
      throw new DevApiError(400, `todos[${index}].status must be pending, in_progress, or completed.`);
    }
    return {
      content,
      activeForm,
      status: status as TodoItem['status'],
    };
  });
}

export function normalizeDevCompactStateSeed(body: DevCompactStateSeedRequest): NormalizedDevCompactStateSeed {
  const sessionId = readRequiredString(body.sessionId, 'sessionId');
  const compactedMessageIds = readOptionalStringArray(
    body.compactedMessageIds,
    'compactedMessageIds',
    [`${sessionId}-compact-source-user`, `${sessionId}-compact-source-assistant`],
  );
  const preservedMessageIds = readOptionalStringArray(body.preservedMessageIds, 'preservedMessageIds', []);
  const summaryMessageId = readOptionalString(body.summaryMessageId, `${sessionId}-compact-summary`);
  const summary = readOptionalString(body.summary, 'Dev compact state seed summary.');
  const anchorMessageId = readOptionalString(
    body.anchorMessageId,
    compactedMessageIds[compactedMessageIds.length - 1] ?? summaryMessageId,
  );

  return {
    sessionId,
    summaryMessageId,
    summary,
    compactedMessageIds,
    preservedMessageIds,
    anchorMessageId,
  };
}

export async function seedCompletedTelemetryTurn(body: DevTelemetrySeedTurnRequest): Promise<{
  sessionId: string;
  turnId: string;
  hasUser: boolean;
  messageIds: string[];
}> {
  const sessionId = readRequiredString(body.sessionId, 'sessionId');
  const turnId = readRequiredString(body.turnId, 'turnId');
  const userPrompt = readOptionalString(body.userPrompt, 'Acceptance smoke prompt');
  const assistantResponse = readOptionalString(body.assistantResponse, 'Acceptance smoke response');
  const title = readOptionalString(body.title, 'Telemetry feedback acceptance');
  const modelProvider = readOptionalString(body.modelProvider, 'acceptance');
  const modelName = readOptionalString(body.modelName, 'telemetry-feedback-smoke');
  const workingDirectory = readOptionalString(body.workingDirectory, process.cwd());

  const [{ getAuthService }, { getTelemetryCollector }, { getSessionManager }] = await Promise.all([
    import('../../host/services/auth/authService'),
    import('../../host/telemetry'),
    import('../../host/services/infra/sessionManager'),
  ]);
  const user = getAuthService().getCurrentUser();
  const collector = getTelemetryCollector();
  const now = Date.now();
  const messages: Message[] = [
    {
      id: `${turnId}-user`,
      role: 'user',
      content: userPrompt,
      timestamp: now,
    },
    {
      id: turnId,
      role: 'assistant',
      content: assistantResponse,
      timestamp: now + 1,
      toolCalls: [],
    },
  ];

  collector.startSession(sessionId, {
    title,
    userId: user?.id ?? null,
    modelProvider,
    modelName,
    workingDirectory,
  });
  collector.startTurn(sessionId, turnId, 1, userPrompt);
  collector.endTurn(sessionId, turnId, assistantResponse);
  collector.endSession(sessionId);

  const sessionManager = getSessionManager();
  for (const message of messages) {
    await sessionManager.addMessageToSession(sessionId, message);
  }
  broadcastSSE(IPC_CHANNELS.SESSION_UPDATED, {
    sessionId,
    updates: { updatedAt: now + 1 },
  });
  broadcastSSE(IPC_CHANNELS.SESSION_LIST_UPDATED, undefined);

  return { sessionId, turnId, hasUser: Boolean(user?.id), messageIds: messages.map((message) => message.id) };
}

export async function findCloudTelemetryFeedback(sessionId: string, turnId: string): Promise<{
  found: boolean;
  feedback?: unknown;
}> {
  const { getSupabase } = await import('../../host/services/infra/supabaseService');
  const supabase = getSupabase() as unknown as DevSupabaseClient;

  const { data, error } = await supabase
    .from('telemetry_feedback')
    .select('id, session_id, turn_id, rating, comment, full_content, created_at, uploaded_at')
    .eq('session_id', sessionId)
    .eq('turn_id', turnId)
    .order('uploaded_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new DevApiError(502, error.message || 'Cloud telemetry feedback query failed.');
  }

  const row = data?.[0];
  return row ? { found: true, feedback: row } : { found: false };
}

export async function findCloudTelemetryTrace(sessionId: string, turnId: string): Promise<{
  foundSession: boolean;
  foundTurn: boolean;
  session?: unknown;
  turn?: unknown;
}> {
  const { getSupabase } = await import('../../host/services/infra/supabaseService');
  const supabase = getSupabase() as unknown as DevSupabaseClient;

  const [sessionResult, turnResult] = await Promise.all([
    supabase
      .from('telemetry_sessions')
      .select('id, user_id, model_provider, model_name, status, turn_count, total_tokens, uploaded_at')
      .eq('id', sessionId)
      .limit(1),
    supabase
      .from('telemetry_turns')
      .select('id, session_id, user_id, turn_number, turn_type, outcome_status, payload, uploaded_at')
      .eq('session_id', sessionId)
      .eq('id', turnId)
      .limit(1),
  ]);

  if (sessionResult.error) {
    throw new DevApiError(502, sessionResult.error.message || 'Cloud telemetry session query failed.');
  }
  if (turnResult.error) {
    throw new DevApiError(502, turnResult.error.message || 'Cloud telemetry turn query failed.');
  }

  const session = sessionResult.data?.[0];
  const turn = turnResult.data?.[0];
  return {
    foundSession: Boolean(session),
    foundTurn: Boolean(turn),
    ...(session ? { session } : {}),
    ...(turn ? { turn } : {}),
  };
}

export async function seedDevTodos(body: DevTodoSeedRequest): Promise<{ sessionId: string; todos: TodoItem[] }> {
  const sessionId = readRequiredString(body.sessionId, 'sessionId');
  const todos = normalizeDevTodoItems(body.todos);
  const { setSessionTodos, getSessionTodos } = await import('../../host/agent/todoParser');
  setSessionTodos(sessionId, todos);
  return { sessionId, todos: getSessionTodos(sessionId) };
}

export async function readDevTodos(sessionId: unknown): Promise<{ sessionId: string; todos: TodoItem[] }> {
  const resolvedSessionId = readRequiredString(sessionId, 'sessionId');
  const { getSessionTodos } = await import('../../host/agent/todoParser');
  return { sessionId: resolvedSessionId, todos: getSessionTodos(resolvedSessionId) };
}

export async function seedDevCompactState(body: DevCompactStateSeedRequest): Promise<{
  sessionId: string;
  compactionMessages: Array<{
    id: string;
    source?: string;
    compactedMessageCount: number;
    compactedMessageIds: string[];
    preservedMessageIds: string[];
  }>;
  compressionCommitCount: number;
  compressionTargetIds: string[];
}> {
  const request = normalizeDevCompactStateSeed(body);
  const now = Date.now();
  const [{ getSessionManager }, { getDatabase }, { CompressionState }] = await Promise.all([
    import('../../host/services/infra/sessionManager'),
    import('../../host/services/core/databaseService'),
    import('../../host/context/compressionState'),
  ]);

  const compactedTokenCount = request.compactedMessageIds.length * 128;
  const compactionMessage: Message = {
    id: request.summaryMessageId,
    role: 'system',
    content: request.summary,
    timestamp: now,
    compaction: {
      type: 'compaction',
      content: request.summary,
      timestamp: now,
      compactedMessageCount: request.compactedMessageIds.length,
      compactedTokenCount,
      source: 'manual_current',
      summaryVersion: 1,
      anchorMessageId: request.anchorMessageId,
      preservedMessageIds: request.preservedMessageIds,
      compactedMessageIds: request.compactedMessageIds,
      survivorManifest: {
        sessionId: request.sessionId,
        source: 'manual_current',
        anchorMessageId: request.anchorMessageId,
        compactedMessageIds: request.compactedMessageIds,
        preservedMessageIds: request.preservedMessageIds,
        preserveRecentCount: request.preservedMessageIds.length,
        openWork: [
          {
            label: 'Acceptance compact state seed',
            detail: 'Verifies compaction message and compression state survive app-host restart.',
            severity: 'info',
          },
        ],
      },
      provider: 'acceptance',
      model: 'compact-state-smoke',
    },
  };
  const preservedMessages: Message[] = request.preservedMessageIds
    .filter((id) => id !== request.summaryMessageId)
    .map((id, index) => ({
      id,
      role: 'assistant' as const,
      content: `Preserved message ${index + 1} for compact state restart smoke.`,
      timestamp: now + index + 1,
      toolCalls: [],
    }));

  await getSessionManager().replaceMessages(request.sessionId, [compactionMessage, ...preservedMessages]);

  const compressionState = new CompressionState();
  compressionState.applyCommit({
    layer: 'autocompact',
    operation: 'compact',
    targetMessageIds: [request.summaryMessageId],
    timestamp: now,
    metadata: {
      kind: 'manual_current',
      source: 'dev_compact_state_seed',
      compactedMessageCount: request.compactedMessageIds.length,
      compactedTokenCount,
      anchorMessageId: request.anchorMessageId,
    },
  });
  getDatabase().saveSessionRuntimeState(request.sessionId, {
    compressionStateJson: compressionState.serialize(),
  });

  return readDevCompactState(request.sessionId);
}

export async function readDevCompactState(sessionId: unknown): Promise<{
  sessionId: string;
  compactionMessages: Array<{
    id: string;
    source?: string;
    compactedMessageCount: number;
    compactedMessageIds: string[];
    preservedMessageIds: string[];
  }>;
  compressionCommitCount: number;
  compressionTargetIds: string[];
}> {
  const resolvedSessionId = readRequiredString(sessionId, 'sessionId');
  const [{ getSessionManager }, { getDatabase }, { CompressionState }] = await Promise.all([
    import('../../host/services/infra/sessionManager'),
    import('../../host/services/core/databaseService'),
    import('../../host/context/compressionState'),
  ]);
  const session = await getSessionManager().getSession(resolvedSessionId, Number.MAX_SAFE_INTEGER);
  const compactionMessages = (session?.messages ?? [])
    .filter((message) => message.compaction?.type === 'compaction')
    .map((message) => ({
      id: message.id,
      source: message.compaction?.source,
      compactedMessageCount: message.compaction?.compactedMessageCount ?? 0,
      compactedMessageIds: message.compaction?.compactedMessageIds ?? [],
      preservedMessageIds: message.compaction?.preservedMessageIds ?? [],
    }));

  const runtimeState = getDatabase().getSessionRuntimeState(resolvedSessionId);
  const compressionState = runtimeState?.compressionStateJson
    ? CompressionState.deserialize(runtimeState.compressionStateJson)
    : new CompressionState();
  const commits = compressionState.getCommitLog();

  return {
    sessionId: resolvedSessionId,
    compactionMessages,
    compressionCommitCount: commits.length,
    compressionTargetIds: commits.flatMap((commit) => commit.targetMessageIds),
  };
}

export async function readDevReplayState(sessionId: unknown): Promise<{
  sessionId: string;
  replayKey: string | null;
  dataSource: string | null;
  turnCount: number;
  telemetryCompleteness: unknown;
}> {
  const resolvedSessionId = readRequiredString(sessionId, 'sessionId');
  const { extractStructuredReplay } = await import('../../host/evaluation/replayService');
  const replay = await extractStructuredReplay(resolvedSessionId);

  return {
    sessionId: resolvedSessionId,
    replayKey: replay?.traceIdentity?.replayKey ?? null,
    dataSource: replay?.dataSource ?? null,
    turnCount: replay?.summary?.totalTurns ?? 0,
    telemetryCompleteness: replay?.summary?.telemetryCompleteness ?? null,
  };
}
