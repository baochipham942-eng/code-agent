// ============================================================================
// Dev API Routes — dev/exec-tool, dev/smoke/office, workspace/file
// ============================================================================

import path from 'path';
import fs from 'fs';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentEvent, Message, PermissionRequest, PermissionResponse, TodoItem } from '../../shared/contract';
import { generatePermissionRequestId } from '../../shared/utils/id';
import { IPC_CHANNELS } from '../../shared/ipc';
import { sseClients, broadcastSSE } from '../helpers/sse';
import { formatError } from '../helpers/utils';
import { isWorkspaceFileAllowed, getContentType } from '../helpers/upload';
import { getEventBus } from '../../main/services/eventing/bus';
import type { SwarmEvent } from '../../shared/contract/swarm';
import type { ScriptRunEvent } from '../../shared/contract/scriptRun';
import type { WebRouteLogger } from './routeTypes';
import { createDevCancellableToolSmokeRouter } from './devCancellableToolSmoke';
import { createDevAgentLoopStubSmokeRouter } from './devAgentLoopStubSmoke';
import { createDevAgentTeamSmokeRouter } from './devAgentTeamSmoke';
import type { ActiveAgentLoop } from './agent';

// ── Types ─────────────────────────────────────────────────────────────────

export class DevApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface DevToolExecutionRequest {
  tool?: unknown;
  params?: unknown;
  project?: unknown;
  sessionId?: unknown;
  allowWrite?: unknown;
  requireRealApproval?: unknown;
}

interface DevToolExecutionResponse {
  tool: string;
  params: Record<string, unknown>;
  project: string;
  sessionId: string;
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  result?: unknown;
}

interface OfficeSmokeStep {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  check: 'connected' | 'array';
}

type RendererAgentEvent = AgentEvent & { sessionId?: string };

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

interface DevTelemetrySeedTurnRequest {
  sessionId?: unknown;
  turnId?: unknown;
  title?: unknown;
  userPrompt?: unknown;
  assistantResponse?: unknown;
  modelProvider?: unknown;
  modelName?: unknown;
  workingDirectory?: unknown;
}

interface DevTodoSeedRequest {
  sessionId?: unknown;
  todos?: unknown;
}

interface DevCompactStateSeedRequest {
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

export interface PendingDevPermissionRequest {
  request: PermissionRequest;
  resolve: (response: PermissionResponse) => void;
  reject: (error: DevApiError) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DEV_EXEC_ALLOWED_TOOLS = new Set([
  'desktop_activity_recent',
  'desktop_activity_stats',
  'task_create',
  'task_get',
  'task_list',
  'task_update',
  'mail',
  'mail_draft',
  'mail_send',
  'calendar',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'reminders',
  'reminders_create',
  'reminders_update',
  'reminders_delete',
]);

const DEV_WRITE_TOOLS = new Set([
  'task_create',
  'task_update',
  'mail_draft',
  'mail_send',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'reminders_create',
  'reminders_update',
  'reminders_delete',
]);

const DEV_REAL_APPROVAL_TIMEOUT_MS = 60_000;
const GLOBAL_PERMISSION_REQUEST_SESSION_ID = 'global';

const DEV_REAL_APPROVAL_ERROR_CODES = {
  unavailableInWebMode: 'REAL_APPROVAL_UNAVAILABLE_IN_WEB_MODE',
  noApprovalClientConnected: 'NO_APPROVAL_CLIENT_CONNECTED',
  timeout: 'REAL_APPROVAL_TIMEOUT',
  denied: 'REAL_APPROVAL_DENIED',
} as const;

const OFFICE_SMOKE_STEPS: OfficeSmokeStep[] = [
  { id: 'mail-status', tool: 'mail', params: { action: 'get_status' }, check: 'connected' },
  { id: 'mail-accounts', tool: 'mail', params: { action: 'list_accounts' }, check: 'array' },
  { id: 'mail-mailboxes', tool: 'mail', params: { action: 'list_mailboxes' }, check: 'array' },
  { id: 'calendar-status', tool: 'calendar', params: { action: 'get_status' }, check: 'connected' },
  { id: 'calendar-list', tool: 'calendar', params: { action: 'list_calendars' }, check: 'array' },
  { id: 'reminders-status', tool: 'reminders', params: { action: 'get_status' }, check: 'connected' },
  { id: 'reminders-list', tool: 'reminders', params: { action: 'list_lists' }, check: 'array' },
];

// ── Module-level state ────────────────────────────────────────────────────

let devRealApprovalToolExecutor: import('../../main/tools/toolExecutor').ToolExecutor | null = null;

// ── Helper functions ──────────────────────────────────────────────────────

export function isDevApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_ENABLE_DEV_API === 'true' || env.CODE_AGENT_E2E === '1';
}

export function isDevExecToolAllowed(tool: string): boolean {
  return DEV_EXEC_ALLOWED_TOOLS.has(tool);
}

export function devExecToolRequiresAllowWrite(tool: string): boolean {
  return DEV_WRITE_TOOLS.has(tool);
}

function ensureDevApiEnabled(res: Response): boolean {
  if (isDevApiEnabled()) return true;
  res.status(404).json({ error: 'Dev API is not available in production mode.' });
  return false;
}

function normalizeDevParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new DevApiError(400, 'params must be a JSON object.');
  }
  return params as Record<string, unknown>;
}

function normalizeRequireRealApproval(requireRealApproval: unknown): boolean {
  if (requireRealApproval === undefined) return false;
  if (typeof requireRealApproval !== 'boolean') {
    throw new DevApiError(400, 'requireRealApproval must be a boolean when provided.');
  }
  return requireRealApproval;
}

function normalizePermissionRequestSessionId(sessionId?: string): string {
  if (typeof sessionId === 'string' && sessionId.trim()) {
    return sessionId.trim();
  }
  return GLOBAL_PERMISSION_REQUEST_SESSION_ID;
}

function readObjectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function readRequiredString(value: unknown, fieldName: string): string {
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

function readOfficeSmokeBody(body: unknown): { project: string; sessionId: string } {
  const record = readObjectBody(body);
  const project = typeof record.project === 'string' && record.project.trim()
    ? record.project
    : process.cwd();
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.trim()
    ? record.sessionId
    : `web-office-smoke-${Date.now()}`;
  return { project, sessionId };
}

async function requestDevToolPermission(
  pendingDevPermissions: Map<string, PendingDevPermissionRequest>,
  request: import('../../main/tools/types').PermissionRequestData,
): Promise<boolean> {
  if (sseClients.size === 0) {
    throw new DevApiError(
      503,
      'Real approval requires an active web client subscribed to `/api/events`, but no approval client is connected.',
      DEV_REAL_APPROVAL_ERROR_CODES.noApprovalClientConnected,
    );
  }

  const sessionId = normalizePermissionRequestSessionId(request.sessionId);
  const fullRequest: PermissionRequest = {
    id: generatePermissionRequestId(),
    sessionId,
    forceConfirm: request.forceConfirm,
    type: request.type,
    tool: request.tool,
    details: request.details as PermissionRequest['details'],
    reason: request.reason,
    timestamp: Date.now(),
    dangerLevel: request.dangerLevel,
  };

  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDevPermissions.delete(fullRequest.id);
      reject(new DevApiError(
        504,
        `Timed out after ${DEV_REAL_APPROVAL_TIMEOUT_MS / 1000}s waiting for real approval response.`,
        DEV_REAL_APPROVAL_ERROR_CODES.timeout,
      ));
    }, DEV_REAL_APPROVAL_TIMEOUT_MS);

    pendingDevPermissions.set(fullRequest.id, {
      request: fullRequest,
      resolve: (response) => {
        clearTimeout(timer);
        pendingDevPermissions.delete(fullRequest.id);
        if (response === 'allow' || response === 'allow_session') {
          resolve(true);
          return;
        }
        reject(new DevApiError(
          403,
          'Real approval denied by user.',
          DEV_REAL_APPROVAL_ERROR_CODES.denied,
        ));
      },
      reject: (error) => {
        clearTimeout(timer);
        pendingDevPermissions.delete(fullRequest.id);
        reject(error);
      },
      timer,
    });

    broadcastSSE('agent:event', {
      type: 'permission_request',
      data: fullRequest,
      sessionId,
    });
  });
}

async function getRealApprovalDevToolExecutor(
  pendingDevPermissions: Map<string, PendingDevPermissionRequest>,
  workingDirectory?: string,
) {
  const { initializeCLIServices } = await import('../../cli/bootstrap');
  await initializeCLIServices();

  if (!devRealApprovalToolExecutor) {
    const { ToolExecutor } = await import('../../main/tools/toolExecutor');

    devRealApprovalToolExecutor = new ToolExecutor({
      requestPermission: (req) => requestDevToolPermission(pendingDevPermissions, req),
      workingDirectory: process.cwd(),
    });
  }

  devRealApprovalToolExecutor.setWorkingDirectory(workingDirectory ? path.resolve(workingDirectory) : process.cwd());
  return devRealApprovalToolExecutor;
}

async function getDevToolExecutor(
  pendingDevPermissions: Map<string, PendingDevPermissionRequest>,
  options?: {
    workingDirectory?: string;
    requireRealApproval?: boolean;
  },
) {
  if (options?.requireRealApproval === true) {
    return getRealApprovalDevToolExecutor(pendingDevPermissions, options.workingDirectory);
  }

  const { initializeCLIServices, getToolExecutor } = await import('../../cli/bootstrap');
  await initializeCLIServices();

  const executor = getToolExecutor();
  if (!executor) {
    throw new DevApiError(500, 'ToolExecutor is not available.');
  }

  executor.setWorkingDirectory(options?.workingDirectory ? path.resolve(options.workingDirectory) : process.cwd());
  return executor;
}

async function executeDevTool(
  pendingDevPermissions: Map<string, PendingDevPermissionRequest>,
  request: DevToolExecutionRequest,
): Promise<DevToolExecutionResponse> {
  const tool = typeof request.tool === 'string' ? request.tool.trim() : '';
  if (!tool) {
    throw new DevApiError(400, 'Missing tool.');
  }
  if (!DEV_EXEC_ALLOWED_TOOLS.has(tool)) {
    throw new DevApiError(403, `Tool is not allowed in dev host exec: ${tool}`);
  }
  if (DEV_WRITE_TOOLS.has(tool) && request.allowWrite !== true) {
    throw new DevApiError(400, `Tool ${tool} requires allowWrite=true.`);
  }

  const params = normalizeDevParams(request.params);
  const requireRealApproval = normalizeRequireRealApproval(request.requireRealApproval);
  const project = typeof request.project === 'string' && request.project.trim()
    ? path.resolve(request.project)
    : process.cwd();
  const sessionId = typeof request.sessionId === 'string' && request.sessionId.trim()
    ? request.sessionId
    : `web-dev-${Date.now()}`;
  const executor = await getDevToolExecutor(pendingDevPermissions, { workingDirectory: project, requireRealApproval });
  const result = await executor.execute(tool, params, { sessionId });

  return {
    tool,
    params,
    project,
    sessionId,
    success: result.success,
    output: result.output,
    error: result.error,
    metadata: result.metadata,
    result: result.result,
  };
}

function evaluateOfficeSmokeStep(
  step: OfficeSmokeStep,
  response: DevToolExecutionResponse,
): { passed: boolean; detail: string } {
  if (!response.success) {
    return {
      passed: false,
      detail: response.error || 'Tool execution failed.',
    };
  }

  if (step.check === 'connected') {
    const connected = Boolean((response.result as { connected?: boolean } | undefined)?.connected);
    return {
      passed: connected,
      detail: connected
        ? 'connected'
        : String((response.result as { detail?: string } | undefined)?.detail || 'Connector reported disconnected'),
    };
  }

  const isArrayResult = Array.isArray(response.result);
  return {
    passed: isArrayResult,
    detail: isArrayResult
      ? `count=${(response.result as unknown[]).length}`
      : 'Expected array result',
  };
}

function normalizeDevAgentEvents(body: unknown): RendererAgentEvent[] | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const payload = body as { event?: unknown; events?: unknown } | unknown[];
  const rawEvents = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { events?: unknown }).events)
      ? (payload as { events: unknown[] }).events
      : (payload as { event?: unknown }).event !== undefined
        ? [(payload as { event: unknown }).event]
        : [payload];

  if (rawEvents.length === 0) {
    return null;
  }

  const events: RendererAgentEvent[] = [];
  for (const event of rawEvents) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const candidate = event as Partial<RendererAgentEvent> & { type?: unknown; sessionId?: unknown };
    if (
      typeof candidate.type !== 'string'
      || (candidate.sessionId !== undefined && typeof candidate.sessionId !== 'string')
    ) {
      return null;
    }
    events.push(candidate as RendererAgentEvent);
  }

  return events;
}

async function seedCompletedTelemetryTurn(body: DevTelemetrySeedTurnRequest): Promise<{
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
    import('../../main/services/auth/authService'),
    import('../../main/telemetry'),
    import('../../main/services/infra/sessionManager'),
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

async function findCloudTelemetryFeedback(sessionId: string, turnId: string): Promise<{
  found: boolean;
  feedback?: unknown;
}> {
  const { getSupabase } = await import('../../main/services/infra/supabaseService');
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

async function findCloudTelemetryTrace(sessionId: string, turnId: string): Promise<{
  foundSession: boolean;
  foundTurn: boolean;
  session?: unknown;
  turn?: unknown;
}> {
  const { getSupabase } = await import('../../main/services/infra/supabaseService');
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

async function seedDevTodos(body: DevTodoSeedRequest): Promise<{ sessionId: string; todos: TodoItem[] }> {
  const sessionId = readRequiredString(body.sessionId, 'sessionId');
  const todos = normalizeDevTodoItems(body.todos);
  const { setSessionTodos, getSessionTodos } = await import('../../main/agent/todoParser');
  setSessionTodos(sessionId, todos);
  return { sessionId, todos: getSessionTodos(sessionId) };
}

async function readDevTodos(sessionId: unknown): Promise<{ sessionId: string; todos: TodoItem[] }> {
  const resolvedSessionId = readRequiredString(sessionId, 'sessionId');
  const { getSessionTodos } = await import('../../main/agent/todoParser');
  return { sessionId: resolvedSessionId, todos: getSessionTodos(resolvedSessionId) };
}

async function seedDevCompactState(body: DevCompactStateSeedRequest): Promise<{
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
    import('../../main/services/infra/sessionManager'),
    import('../../main/services/core/databaseService'),
    import('../../main/context/compressionState'),
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

async function readDevCompactState(sessionId: unknown): Promise<{
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
    import('../../main/services/infra/sessionManager'),
    import('../../main/services/core/databaseService'),
    import('../../main/context/compressionState'),
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

async function readDevReplayState(sessionId: unknown): Promise<{
  sessionId: string;
  replayKey: string | null;
  dataSource: string | null;
  turnCount: number;
  telemetryCompleteness: unknown;
}> {
  const resolvedSessionId = readRequiredString(sessionId, 'sessionId');
  const { extractStructuredReplay } = await import('../../main/evaluation/replayService');
  const replay = await extractStructuredReplay(resolvedSessionId);

  return {
    sessionId: resolvedSessionId,
    replayKey: replay?.traceIdentity?.replayKey ?? null,
    dataSource: replay?.dataSource ?? null,
    turnCount: replay?.summary?.totalTurns ?? 0,
    telemetryCompleteness: replay?.summary?.telemetryCompleteness ?? null,
  };
}

// ── Router factory ────────────────────────────────────────────────────────

interface DevRouterDeps {
  pendingDevPermissions: Map<string, PendingDevPermissionRequest>;
  activeAgentLoops: Map<string, ActiveAgentLoop>;
  logger: WebRouteLogger;
}

export function createDevRouter(deps: DevRouterDeps): Router {
  const router = Router();
  const { pendingDevPermissions, activeAgentLoops, logger } = deps;

  router.use('/dev/cancellable-tool', createDevCancellableToolSmokeRouter({
    isEnabled: isDevApiEnabled,
    logger,
  }));
  router.use('/dev/agent-loop-stub', createDevAgentLoopStubSmokeRouter({
    activeAgentLoops,
    isEnabled: isDevApiEnabled,
    logger,
  }));
  router.use('/dev/agent-team-smoke', createDevAgentTeamSmokeRouter({ isEnabled: isDevApiEnabled, logger }));

  // ── GET /api/workspace/file ─────────────────────────────────────────
  router.get('/workspace/file', async (req: Request, res: Response) => {
    const requestedPath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;

    if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
      res.status(400).json({ error: 'Missing path query parameter' });
      return;
    }

    const resolvedPath = path.resolve(requestedPath);
    if (!isWorkspaceFileAllowed(resolvedPath)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(resolvedPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      throw error;
    }

    if (!stats.isFile()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.setHeader('Content-Type', getContentType(resolvedPath));
    res.setHeader('Content-Length', String(stats.size));

    const stream = fs.createReadStream(resolvedPath);
    stream.on('error', (error) => {
      logger.error(`Failed to read workspace file: ${resolvedPath}`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read file' });
        return;
      }
      res.destroy(error);
    });
    stream.pipe(res);
  });

  // ── POST /api/dev/exec-tool ─────────────────────────────────────────
  router.post('/dev/exec-tool', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const response = await executeDevTool(pendingDevPermissions, readObjectBody(req.body as unknown));
      res.json(response);
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      const message = formatError(error);
      logger.error('Dev exec-tool request failed', error);
      res.status(status).json({
        success: false,
        error: message,
        code: error instanceof DevApiError ? error.code : undefined,
      });
    }
  });

  // ── POST /api/dev/smoke/office ──────────────────────────────────────
  router.post('/dev/smoke/office', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const { project, sessionId } = readOfficeSmokeBody(req.body as unknown);

      const results = [];
      for (const step of OFFICE_SMOKE_STEPS) {
        const response = await executeDevTool(pendingDevPermissions, {
          tool: step.tool,
          params: step.params,
          project,
          sessionId,
        });
        const evaluation = evaluateOfficeSmokeStep(step, response);
        results.push({
          id: step.id,
          tool: step.tool,
          params: step.params,
          success: response.success,
          passed: evaluation.passed,
          detail: evaluation.detail,
          output: response.output,
          error: response.error,
          result: response.result,
        });
      }

      res.json({
        ok: results.every((result) => result.passed),
        project: path.resolve(project),
        sessionId,
        timestamp: Date.now(),
        steps: results,
      });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      const message = formatError(error);
      logger.error('Dev office smoke request failed', error);
      res.status(status).json({
        ok: false,
        error: message,
      });
    }
  });

  // ── POST /api/dev/emit-swarm-event (E2E test hook) ──────────────────
  // 仅 CODE_AGENT_E2E=1 启用。Playwright e2e 用它从外部注入 SwarmEvent,
  // 走完整生产路径: EventBus publish → swarm.ipc bridge → deliverSwarmEvent
  // → BrowserWindow.webContents.send → broadcastToRenderer → SSE
  // → EventSource → httpTransport → swarmStore → DOM。
  router.post('/dev/emit-swarm-event', (req: Request, res: Response) => {
    if (process.env.CODE_AGENT_E2E !== '1') {
      res.status(404).json({ error: 'E2E hook disabled' });
      return;
    }

    const event = req.body as SwarmEvent | undefined;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      res.status(400).json({ error: 'Body must be a SwarmEvent with a string type' });
      return;
    }

    // swarm.ipc 的 bridge 在 webServer.setupAllIpcHandlers 中已装好。
    // busType 去掉 'swarm:' 前缀避免双重命名（与 swarmEventPublisher.publish 一致）。
    const busType = event.type.startsWith('swarm:') ? event.type.slice(6) : event.type;
    getEventBus().publish('swarm', busType, event, { bridgeToRenderer: false });
    res.json({ ok: true });
  });

  // ── POST /api/dev/emit-agent-events (E2E test hook) ─────────────────
  // 仅显式 dev API / E2E 模式启用。Playwright 用它注入 agent:event / agent:event:batch,
  // 验证全局 SSE → httpTransport → ipcService → useAgent → DOM 的真实 renderer 链路。
  router.post('/dev/emit-agent-events', (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    const events = normalizeDevAgentEvents(req.body);
    if (!events) {
      res.status(400).json({
        error: 'Body must be an AgentEvent, { event }, { events }, or an AgentEvent array.',
      });
      return;
    }

    if (events.length === 1) {
      broadcastSSE(IPC_CHANNELS.AGENT_EVENT, events[0]);
    } else {
      broadcastSSE(IPC_CHANNELS.AGENT_EVENT_BATCH, events);
    }
    res.json({ ok: true, count: events.length });
  });

  // ── POST /api/dev/emit-workflow-events (E2E test hook，P3a) ──────────
  // 仅 CODE_AGENT_E2E=1 启用。Playwright 注入 ScriptRunEvent[]，走完整生产路径:
  // EventBus publish('workflow') → 通用 EventBridge → webContents.send('workflow:event')
  // → broadcastSSE → EventSource → httpTransport → App.tsx 订阅 → workflowStore
  // → WorkflowInlineMonitor DOM。验证进度树事件链 + UI 实挂。
  router.post('/dev/emit-workflow-events', (req: Request, res: Response) => {
    if (process.env.CODE_AGENT_E2E !== '1') {
      res.status(404).json({ error: 'E2E hook disabled' });
      return;
    }

    const body = req.body as { events?: ScriptRunEvent[] } | ScriptRunEvent[] | ScriptRunEvent | undefined;
    const events: ScriptRunEvent[] = Array.isArray(body)
      ? body
      : body && 'events' in body && Array.isArray(body.events)
        ? body.events
        : body && typeof (body as ScriptRunEvent).type === 'string'
          ? [body as ScriptRunEvent]
          : [];
    if (events.length === 0) {
      res.status(400).json({ error: 'Body must be a ScriptRunEvent, { events }, or a ScriptRunEvent array' });
      return;
    }

    // 与 workflow.ts emit 一致：publish 到 'workflow' domain（bridgeToRenderer:false），
    // workflow.ipc 专用 bridge 转发到 'workflow:event'。
    for (const event of events) {
      getEventBus().publish('workflow', event.type, event, { sessionId: event.runId, bridgeToRenderer: false });
    }
    res.json({ ok: true, count: events.length });
  });

  // ── POST /api/dev/emit-workflow-launch (E2E test hook，P3b) ──────────
  // 仅 CODE_AGENT_E2E=1。注入 WorkflowLaunchEvent，走 'workflow' domain（type 前缀 launch:）
  // → workflow.ipc bridge 按前缀路由到 'workflow:launch:event' → WorkflowLaunchCard DOM。
  router.post('/dev/emit-workflow-launch', (req: Request, res: Response) => {
    if (process.env.CODE_AGENT_E2E !== '1') {
      res.status(404).json({ error: 'E2E hook disabled' });
      return;
    }
    const event = req.body as { type?: string; request?: unknown } | undefined;
    if (!event || typeof event.type !== 'string' || !event.request) {
      res.status(400).json({ error: 'Body must be a WorkflowLaunchEvent { type, request }' });
      return;
    }
    getEventBus().publish('workflow', `launch:${event.type}`, event, { bridgeToRenderer: false });
    res.json({ ok: true });
  });

  // ── POST /api/dev/telemetry/seed-turn ───────────────────────────────
  // 给端到端 smoke 造一条已完成 telemetry session/turn，避免为验证反馈链路真实打模型。
  router.post('/dev/telemetry/seed-turn', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await seedCompletedTelemetryTurn(req.body as DevTelemetrySeedTurnRequest);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev telemetry seed-turn request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── POST /api/dev/telemetry/upload ──────────────────────────────────
  router.post('/dev/telemetry/upload', async (_req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const { getTelemetryUploaderService } = await import('../../main/telemetry/telemetryUploaderService');
      const uploaded = await getTelemetryUploaderService().upload();
      res.json({ ok: true, uploaded });
    } catch (error) {
      logger.error('Dev telemetry upload request failed', error);
      res.status(500).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── POST /api/dev/todos/seed ────────────────────────────────────────
  // E2E/dev-only hook for restart recovery smoke. Uses the real todoParser
  // persistence path instead of writing SQLite directly.
  router.post('/dev/todos/seed', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await seedDevTodos(req.body as DevTodoSeedRequest);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev todos seed request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/todos ──────────────────────────────────────────────
  router.get('/dev/todos', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await readDevTodos(req.query.sessionId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev todos read request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── POST /api/dev/compact-state/seed ─────────────────────────────────
  // E2E/dev-only hook for restart recovery smoke. It seeds the post-compact
  // durable state through SessionManager and the runtime-state repository.
  router.post('/dev/compact-state/seed', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await seedDevCompactState(req.body as DevCompactStateSeedRequest);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev compact-state seed request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/compact-state ───────────────────────────────────────
  router.get('/dev/compact-state', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await readDevCompactState(req.query.sessionId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev compact-state read request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/replay-state ───────────────────────────────────────
  router.get('/dev/replay-state', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await readDevReplayState(req.query.sessionId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev replay-state read request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/telemetry/cloud-feedback ───────────────────────────
  router.get('/dev/telemetry/cloud-feedback', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const sessionId = readRequiredString(req.query.sessionId, 'sessionId');
      const turnId = readRequiredString(req.query.turnId, 'turnId');
      const result = await findCloudTelemetryFeedback(sessionId, turnId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev telemetry cloud-feedback request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/telemetry/cloud-trace ──────────────────────────────
  router.get('/dev/telemetry/cloud-trace', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const sessionId = readRequiredString(req.query.sessionId, 'sessionId');
      const turnId = readRequiredString(req.query.turnId, 'turnId');
      const result = await findCloudTelemetryTrace(sessionId, turnId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev telemetry cloud-trace request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  return router;
}
