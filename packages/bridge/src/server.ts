import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  BridgeConfig,
  BridgeToolRequest,
  BridgeToolResponse,
  HealthResponse,
  ToolContext,
  ToolDefinition,
} from './types';
import { PermissionManager } from './security/permissionManager';
import { Updater } from './updater';
import { ensureSandboxDir } from './security/sandbox';

interface CreateServerOptions {
  config: BridgeConfig;
  token: string;
  version: string;
  tools: Map<string, ToolDefinition>;
  onConfigUpdate: (config: Partial<BridgeConfig>) => Promise<BridgeConfig>;
}

interface BridgeRunBinding {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly cwd: string;
}

interface BridgeRunContextBindingsOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface StoredBridgeRunBinding {
  context: BridgeRunBinding;
  expiresAt: number;
}

const DEFAULT_BRIDGE_RUN_BINDING_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_BRIDGE_RUN_BINDING_MAX_ENTRIES = 1_024;

/**
 * Pins canonical Bridge filesystem context to a run without creating an
 * unbounded process-global registry. Entries use a sliding TTL, LRU capacity,
 * and are cleared when their owning Bridge server closes.
 */
export class BridgeRunContextBindings {
  private readonly bindings = new Map<string, StoredBridgeRunBinding>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: BridgeRunContextBindingsOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_BRIDGE_RUN_BINDING_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_BRIDGE_RUN_BINDING_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Bridge run binding ttlMs must be positive');
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error('Bridge run binding maxEntries must be a positive integer');
    }
  }

  get size(): number {
    this.pruneExpired(this.now());
    return this.bindings.size;
  }

  bind(context: BridgeRunBinding): BridgeRunBinding {
    const now = this.now();
    this.pruneExpired(now);
    const existing = this.bindings.get(context.runId);
    if (existing) {
      const changedFields = (['sessionId', 'workspace', 'cwd'] as const)
        .filter((field) => existing.context[field] !== context[field]);
      if (changedFields.length > 0) {
        throw new Error(
          `Bridge run context mismatch for ${context.runId}: immutable ${changedFields.join(', ')} changed`,
        );
      }
      this.bindings.delete(context.runId);
      this.bindings.set(context.runId, {
        context: existing.context,
        expiresAt: now + this.ttlMs,
      });
      return existing.context;
    }

    while (this.bindings.size >= this.maxEntries) {
      const leastRecentlyUsedRunId = this.bindings.keys().next().value as string | undefined;
      if (!leastRecentlyUsedRunId) break;
      this.bindings.delete(leastRecentlyUsedRunId);
    }
    const canonicalContext = Object.freeze({ ...context });
    this.bindings.set(context.runId, {
      context: canonicalContext,
      expiresAt: now + this.ttlMs,
    });
    return canonicalContext;
  }

  clear(): void {
    this.bindings.clear();
  }

  private pruneExpired(now: number): void {
    for (const [runId, binding] of this.bindings) {
      if (binding.expiresAt <= now) this.bindings.delete(runId);
    }
  }
}

function isAllowedOrigin(origin?: string): boolean {
  if (!origin) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function requireRequestField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Bridge request is missing ${field}`);
  }
  return value.trim();
}

export async function bindBridgeRunToolContext(
  request: BridgeToolRequest,
  config: BridgeConfig,
  wsBroadcast: ToolContext['wsBroadcast'],
  abortSignal: AbortSignal,
  bindings?: BridgeRunContextBindings,
): Promise<{ params: Record<string, unknown>; context: ToolContext }> {
  const runFields = [request.runId, request.sessionId, request.workspace, request.cwd];
  const presentRunFields = runFields.filter(
    (value) => typeof value === 'string' && value.trim().length > 0,
  ).length;
  if (presentRunFields > 0 && presentRunFields < runFields.length) {
    throw new Error('Bridge run context must include runId, sessionId, workspace, and cwd together');
  }

  const hasRunContext = presentRunFields === runFields.length;
  const runId = hasRunContext
    ? requireRequestField(request.runId, 'runId')
    : `legacy-run-${request.requestId}`;
  const sessionId = hasRunContext
    ? requireRequestField(request.sessionId, 'sessionId')
    : `legacy-session-${request.requestId}`;
  if (runId === sessionId) {
    throw new Error('Bridge runId must be distinct from sessionId');
  }
  if (!hasRunContext) {
    // Preserve pre-Run Bridge calls: non-filesystem tools (for example
    // system_info) must still work when a previously configured directory was
    // moved or deleted. Individual file/shell tools keep enforcing their own
    // sandbox and existence checks.
    const workspace = path.resolve(
      requireRequestField(config.workingDirectories[0], 'configured working directory'),
    );
    const requestedCwd = typeof request.params?.cwd === 'string' && request.params.cwd.trim()
      ? request.params.cwd
      : workspace;
    const cwd = path.isAbsolute(requestedCwd)
      ? path.resolve(requestedCwd)
      : path.resolve(workspace, requestedCwd);
    return {
      params: { ...(request.params ?? {}) },
      context: {
        config,
        runId,
        sessionId,
        workspace,
        cwd,
        abortSignal,
        wsBroadcast,
      },
    };
  }

  const requestedWorkspace = requireRequestField(request.workspace, 'workspace');
  const workspace = await ensureSandboxDir(requestedWorkspace, config.workingDirectories);
  const requestedCwd = requireRequestField(request.cwd, 'cwd');
  const cwd = await ensureSandboxDir(
    requestedCwd,
    [workspace],
    workspace,
  );
  const canonicalContext = bindings?.bind({ runId, sessionId, workspace, cwd })
    ?? { runId, sessionId, workspace, cwd };

  return {
    params: { ...(request.params ?? {}), cwd: canonicalContext.cwd },
    context: {
      config: { ...config, workingDirectories: [canonicalContext.workspace] },
      ...canonicalContext,
      abortSignal,
      wsBroadcast,
    },
  };
}

function createRequestAbortController(req: express.Request, res: express.Response): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const abortOnClose = (): void => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', abortOnClose);
  return {
    controller,
    dispose: () => {
      req.off('aborted', abort);
      res.off('close', abortOnClose);
    },
  };
}

export async function createBridgeServer(options: CreateServerOptions) {
  let config = options.config;
  const permissionManager = new PermissionManager(config);
  const runContextBindings = new BridgeRunContextBindings();
  const updater = new Updater(options.version);
  await updater.checkForUpdates(true);
  setInterval(() => void updater.checkForUpdates(), 24 * 60 * 60 * 1000).unref();

  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.path === '/health') {
      next();
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${options.token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();
  const broadcast = (event: string, payload: Record<string, unknown>) => {
    const message = JSON.stringify({ event, ...payload });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  };

  wsServer.on('connection', (socket, request) => {
    const authHeader = request.headers.authorization;
    const search = new URL(request.url ?? '/ws', 'http://127.0.0.1');
    const queryToken = search.searchParams.get('token');
    if (authHeader !== `Bearer ${options.token}` && queryToken !== options.token) {
      socket.close(1008, 'Unauthorized');
      return;
    }
    clients.add(socket);
    socket.send(
      JSON.stringify({
        event: 'connected',
        pendingConfirmations: permissionManager.listPending(),
      })
    );
    socket.on('close', () => clients.delete(socket));
  });

  app.get('/health', (_req, res) => {
    const base: HealthResponse = {
      status: 'ok',
      version: options.version,
      uptime: process.uptime(),
      workingDirectories: config.workingDirectories,
      toolCount: options.tools.size,
    };
    res.json(updater.attachHealth(base));
  });

  app.get('/tools/list', (_req, res) => {
    res.json(
      [...options.tools.values()].map((tool) => ({
        name: tool.name,
        permissionLevel: tool.permissionLevel,
        description: tool.description,
      }))
    );
  });

  app.post('/tools/invoke', async (req, res) => {
    const body = req.body as BridgeToolRequest;
    const tool = options.tools.get(body.tool);
    if (!tool) {
      res.status(404).json({ requestId: body.requestId, success: false, error: `Unknown tool: ${body.tool}` });
      return;
    }

    const requestAbort = createRequestAbortController(req, res);
    try {
      const bound = await bindBridgeRunToolContext(
        body,
        config,
        broadcast,
        requestAbort.controller.signal,
        runContextBindings,
      );
      if (permissionManager.needsConfirmation(tool)) {
        const pending = permissionManager.createPending(body, tool);
        broadcast('confirmation_required', { ...pending });
        res.json({
          requestId: body.requestId,
          success: false,
          requiresConfirmation: true,
          confirmationPrompt: pending.prompt,
        } satisfies BridgeToolResponse);
        return;
      }
      const output = await tool.run(bound.params, bound.context);
      if (!requestAbort.controller.signal.aborted && !res.destroyed) {
        res.json({ requestId: body.requestId, success: true, output } satisfies BridgeToolResponse);
      }
    } catch (error) {
      if (!res.destroyed) {
        res.status(requestAbort.controller.signal.aborted ? 499 : 400).json({
          requestId: body.requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies BridgeToolResponse);
      }
    } finally {
      requestAbort.dispose();
    }
  });

  app.post('/tools/confirm', async (req, res) => {
    const { requestId, approved } = req.body as { requestId: string; approved: boolean };
    const pending = permissionManager.consumePending(requestId);
    if (!pending) {
      res.status(404).json({ requestId, success: false, error: 'Pending confirmation not found' });
      return;
    }
    if (!approved) {
      res.json({ requestId, success: false, error: 'Request rejected by user' } satisfies BridgeToolResponse);
      return;
    }
    const tool = options.tools.get(pending.request.tool);
    if (!tool) {
      res.status(404).json({ requestId, success: false, error: 'Tool no longer available' });
      return;
    }
    const requestAbort = createRequestAbortController(req, res);
    try {
      const bound = await bindBridgeRunToolContext(
        pending.request,
        config,
        broadcast,
        requestAbort.controller.signal,
        runContextBindings,
      );
      const output = await tool.run(bound.params, bound.context);
      if (!requestAbort.controller.signal.aborted && !res.destroyed) {
        res.json({ requestId, success: true, output } satisfies BridgeToolResponse);
      }
    } catch (error) {
      if (!res.destroyed) {
        res.status(requestAbort.controller.signal.aborted ? 499 : 400).json({
          requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies BridgeToolResponse);
      }
    } finally {
      requestAbort.dispose();
    }
  });

  app.get('/config', (_req, res) => {
    res.json(config);
  });

  app.put('/config', async (req, res) => {
    config = await options.onConfigUpdate(req.body as Partial<BridgeConfig>);
    permissionManager.setConfig(config);
    res.json(config);
  });

  return {
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(config.port, '127.0.0.1', () => resolve());
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        runContextBindings.clear();
        wsServer.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
