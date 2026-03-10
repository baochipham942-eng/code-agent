import express from 'express';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { BridgeConfig, BridgeToolRequest, BridgeToolResponse, HealthResponse, ToolDefinition } from './types';
import { PermissionManager } from './security/permissionManager';
import { Updater } from './updater';

interface CreateServerOptions {
  config: BridgeConfig;
  token: string;
  version: string;
  tools: Map<string, ToolDefinition>;
  onConfigUpdate: (config: Partial<BridgeConfig>) => Promise<BridgeConfig>;
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

export async function createBridgeServer(options: CreateServerOptions) {
  let config = options.config;
  const permissionManager = new PermissionManager(config);
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

    if (permissionManager.needsConfirmation(tool)) {
      const pending = permissionManager.createPending(body, tool);
      broadcast('confirmation_required', pending);
      const response: BridgeToolResponse = {
        requestId: body.requestId,
        success: false,
        requiresConfirmation: true,
        confirmationPrompt: pending.prompt,
      };
      res.json(response);
      return;
    }

    try {
      const output = await tool.run(body.params ?? {}, { config, wsBroadcast: broadcast });
      res.json({ requestId: body.requestId, success: true, output } satisfies BridgeToolResponse);
    } catch (error) {
      res.status(400).json({
        requestId: body.requestId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies BridgeToolResponse);
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
    try {
      const output = await tool.run(pending.request.params ?? {}, { config, wsBroadcast: broadcast });
      res.json({ requestId, success: true, output } satisfies BridgeToolResponse);
    } catch (error) {
      res.status(400).json({
        requestId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies BridgeToolResponse);
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
        wsServer.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
