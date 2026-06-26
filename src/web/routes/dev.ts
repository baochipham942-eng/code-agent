// ============================================================================
// Dev API Routes — dev/exec-tool, dev/smoke/office, workspace/file
// ============================================================================

import path from 'path';
import fs from 'fs';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentEvent, PermissionRequest, PermissionResponse } from '../../shared/contract';
import { generatePermissionRequestId } from '../../shared/utils/id';
import { IPC_CHANNELS } from '../../shared/ipc';
import { sseClients, broadcastSSE } from '../helpers/sse';
import { formatError } from '../helpers/utils';
import { isWorkspaceFileAllowed, getContentType } from '../helpers/upload';
import { getEventBus } from '../../host/services/eventing/bus';
import type { SwarmEvent } from '../../shared/contract/swarm';
import type { ScriptRunEvent } from '../../shared/contract/scriptRun';
import type { WebRouteLogger } from './routeTypes';
import { createDevCancellableToolSmokeRouter } from './devCancellableToolSmoke';
import { createDevAgentLoopStubSmokeRouter } from './devAgentLoopStubSmoke';
import { createDevAgentTeamSmokeRouter } from './devAgentTeamSmoke';
import { registerDevTelemetrySeedRoutes } from './devTelemetrySeedRoutes';
import { DevApiError } from './devSeedHelpers';
import type { ActiveAgentLoop } from './agent';
import { getBackgroundTaskManager } from '../../host/session/backgroundTaskManager';
import { notificationService } from '../../host/services/infra/notificationService';

export {
  DevApiError,
  findCloudTelemetryFeedback,
  findCloudTelemetryTrace,
  normalizeDevCompactStateSeed,
  normalizeDevTodoItems,
  readDevCompactState,
  readDevReplayState,
  readDevTodos,
  readRequiredString,
  seedCompletedTelemetryTurn,
  seedDevCompactState,
  seedDevTodos,
} from './devSeedHelpers';
export type {
  DevCompactStateSeedRequest,
  DevTelemetrySeedTurnRequest,
  DevTodoSeedRequest,
  NormalizedDevCompactStateSeed,
} from './devSeedHelpers';

// ── Types ─────────────────────────────────────────────────────────────────

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

let devRealApprovalToolExecutor: import('../../host/tools/toolExecutor').ToolExecutor | null = null;

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
  request: import('../../host/tools/types').PermissionRequestData,
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
    const { ToolExecutor } = await import('../../host/tools/toolExecutor');

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

  // ── Background task controls for app-host long-task acceptance ──────
  router.post('/dev/background-task/complete', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const body = readObjectBody(req.body as unknown);
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : '';
      if (!sessionId) {
        res.status(400).json({ ok: false, error: 'sessionId is required.' });
        return;
      }
      const message = typeof body.message === 'string' && body.message.trim()
        ? body.message.trim()
        : undefined;

      await getBackgroundTaskManager().markCompleted(sessionId, message);
      res.json({ ok: true, sessionId });
    } catch (error) {
      logger.error('Dev background task complete failed', error);
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  router.get('/dev/notifications', (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;
    res.json({ ok: true, notifications: notificationService.getRecentNotifications() });
  });

  router.delete('/dev/notifications', (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;
    notificationService.clearRecentNotifications();
    res.json({ ok: true });
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

  registerDevTelemetrySeedRoutes(router, { logger, ensureDevApiEnabled });

  return router;
}
