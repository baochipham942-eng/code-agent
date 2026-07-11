import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { ToolExecutionResult } from '../../host/tools/types';
import { formatError } from '../helpers/utils';
import type { WebRouteLogger } from './routeTypes';

type DevCancellableToolName = 'Bash' | 'http_request';

interface DevCancellableToolEntry {
  id: string;
  tool: DevCancellableToolName;
  sessionId: string;
  workingDirectory: string;
  controller: AbortController;
  startedAt: number;
  cancelledAt?: number;
  settledAt?: number;
  toolExecutionBegins: number;
  result?: ToolExecutionResult;
  error?: string;
  markerDir: string;
  startedMarkerPath: string;
  terminatedMarkerPath: string;
  scriptPath: string;
  requestStartedMarkerPath: string;
  requestClosedMarkerPath: string;
  url?: string;
  httpServer?: http.Server;
  promise: Promise<void>;
}

interface DevCancellableToolSmokeDeps {
  isEnabled: () => boolean;
  logger: WebRouteLogger;
}

const activeCancellableTools = new Map<string, DevCancellableToolEntry>();

function readObjectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function readOptionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readToolName(value: unknown): DevCancellableToolName {
  const tool = readOptionalString(value, 'Bash');
  if (tool !== 'Bash' && tool !== 'http_request') {
    throw new Error('Only Bash and http_request are supported by the default cancellable tool smoke.');
  }
  return tool;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

async function waitForSettlement(entry: DevCancellableToolEntry, timeoutMs: number): Promise<boolean> {
  if (entry.settledAt) return true;
  await Promise.race([
    entry.promise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return Boolean(entry.settledAt);
}

async function buildLongRunningBashCommand(
  scriptPath: string,
  startedMarkerPath: string,
  terminatedMarkerPath: string,
): Promise<string> {
  const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(startedMarkerPath)}, String(process.pid));
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(terminatedMarkerPath)}, 'SIGTERM');
  setTimeout(() => process.exit(0), 50);
});
setInterval(() => {}, 1000);
`;
  await fs.writeFile(scriptPath, script, 'utf8');
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
}

async function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to start local HTTP delay server.'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeHttpServer(server?: http.Server): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function createDelayServer(
  requestStartedMarkerPath: string,
  requestClosedMarkerPath: string,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    void fs.writeFile(requestStartedMarkerPath, req.url || '/');
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('delayed response');
    }, 20_000);
    res.on('close', () => {
      clearTimeout(timer);
      if (!finished) {
        void fs.writeFile(requestClosedMarkerPath, 'client_closed');
      }
    });
  });
  const port = await listen(server, '::ffff:127.0.0.1');
  return {
    server,
    url: `http://[::ffff:7f00:1]:${port}/delay`,
  };
}

async function startCancellableTool(body: unknown): Promise<DevCancellableToolEntry> {
  const record = readObjectBody(body);
  const tool = readToolName(record.tool);
  const sessionId = readOptionalString(record.sessionId, `dev-cancel-smoke-${Date.now()}`);
  const workingDirectory = path.resolve(readOptionalString(record.workingDirectory, process.cwd()));
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-tool-cancel-'));
  const startedMarkerPath = path.join(markerDir, 'started');
  const terminatedMarkerPath = path.join(markerDir, 'terminated');
  const scriptPath = path.join(markerDir, 'long-running.js');
  const requestStartedMarkerPath = path.join(markerDir, 'request-started');
  const requestClosedMarkerPath = path.join(markerDir, 'request-closed');
  const controller = new AbortController();
  const id = randomUUID();

  const [{ initializeCLIServices, getToolExecutor }] = await Promise.all([
    import('../../cli/bootstrap'),
  ]);
  await initializeCLIServices();
  const executor = getToolExecutor();
  if (!executor) {
    throw new Error('ToolExecutor is not available.');
  }
  executor.setWorkingDirectory(workingDirectory);

  const entry: DevCancellableToolEntry = {
    id,
    tool,
    sessionId,
    workingDirectory,
    controller,
    startedAt: Date.now(),
    markerDir,
    startedMarkerPath,
    terminatedMarkerPath,
    scriptPath,
    requestStartedMarkerPath,
    requestClosedMarkerPath,
    toolExecutionBegins: 0,
    promise: Promise.resolve(),
  };

  const params = tool === 'Bash'
    ? {
        command: await buildLongRunningBashCommand(scriptPath, startedMarkerPath, terminatedMarkerPath),
        timeout: 20_000,
        description: 'dev cancellable tool smoke long-running bash',
      }
    : await (async () => {
        const { server, url } = await createDelayServer(requestStartedMarkerPath, requestClosedMarkerPath);
        entry.httpServer = server;
        entry.url = url;
        return {
          url,
          method: 'GET',
          timeout: 20_000,
        };
      })();

  entry.toolExecutionBegins += 1;
  entry.promise = executor.execute(tool, params, {
    sessionId,
    abortSignal: controller.signal,
  }).then((result) => {
    entry.result = result;
  }).catch((error: unknown) => {
    entry.error = formatError(error);
  }).finally(() => {
    entry.settledAt = Date.now();
    void closeHttpServer(entry.httpServer);
  });
  activeCancellableTools.set(id, entry);

  const started = await waitFor(async () => {
    const markerPath = tool === 'Bash' ? startedMarkerPath : requestStartedMarkerPath;
    if (await fileExists(markerPath)) return true;
    if (entry.settledAt) {
      throw new Error(`Cancellable ${tool} tool settled before startup marker: ${JSON.stringify(await describeEntry(entry))}`);
    }
    return false;
  }, 5_000);
  if (!started) {
    throw new Error(`Timed out waiting for the cancellable ${tool} tool to start: ${JSON.stringify(await describeEntry(entry))}`);
  }

  return entry;
}

async function describeEntry(entry: DevCancellableToolEntry): Promise<Record<string, unknown>> {
  const startedPid = await readFileIfExists(entry.startedMarkerPath);
  const terminatedSignal = await readFileIfExists(entry.terminatedMarkerPath);
  const requestStarted = await readFileIfExists(entry.requestStartedMarkerPath);
  const requestClosed = await readFileIfExists(entry.requestClosedMarkerPath);
  return {
    id: entry.id,
    tool: entry.tool,
    sessionId: entry.sessionId,
    workingDirectory: entry.workingDirectory,
    startedAt: entry.startedAt,
    cancelledAt: entry.cancelledAt,
    settledAt: entry.settledAt,
    elapsedMs: (entry.settledAt ?? Date.now()) - entry.startedAt,
    cancelToSettledMs: entry.cancelledAt && entry.settledAt
      ? entry.settledAt - entry.cancelledAt
      : null,
    startedPid: startedPid?.trim() || null,
    terminatedSignal: terminatedSignal?.trim() || null,
    requestStarted: requestStarted?.trim() || null,
    requestClosed: requestClosed?.trim() || null,
    url: entry.url,
    settled: Boolean(entry.settledAt),
    toolExecutionBegins: entry.toolExecutionBegins,
    result: entry.result,
    error: entry.error,
  };
}

async function cleanupEntry(id: string): Promise<boolean> {
  const entry = activeCancellableTools.get(id);
  if (!entry) return false;
  entry.controller.abort('cleanup');
  await waitForSettlement(entry, 1_000).catch(() => false);
  await closeHttpServer(entry.httpServer);
  await fs.rm(entry.markerDir, { recursive: true, force: true });
  activeCancellableTools.delete(id);
  return true;
}

export function createDevCancellableToolSmokeRouter(deps: DevCancellableToolSmokeDeps): Router {
  const router = Router();
  const { isEnabled, logger } = deps;

  const ensureEnabled = (res: Response): boolean => {
    if (isEnabled()) return true;
    res.status(404).json({ error: 'Dev API is not available in production mode.' });
    return false;
  };

  router.post('/start', async (req: Request, res: Response) => {
    if (!ensureEnabled(res)) return;
    try {
      const entry = await startCancellableTool(req.body);
      res.json({ ok: true, ...(await describeEntry(entry)) });
    } catch (error) {
      logger.error('Dev cancellable tool start failed', error);
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  router.post('/:id/cancel', async (req: Request, res: Response) => {
    if (!ensureEnabled(res)) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const entry = activeCancellableTools.get(id);
    if (!entry) {
      res.status(404).json({ ok: false, error: 'Cancellable tool run not found.' });
      return;
    }
    entry.cancelledAt = Date.now();
    entry.controller.abort('dev_cancel_smoke');
    await waitForSettlement(entry, 5_000);
    res.json({ ok: true, ...(await describeEntry(entry)) });
  });

  router.get('/:id', async (req: Request, res: Response) => {
    if (!ensureEnabled(res)) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const entry = activeCancellableTools.get(id);
    if (!entry) {
      res.status(404).json({ ok: false, error: 'Cancellable tool run not found.' });
      return;
    }
    res.json({ ok: true, ...(await describeEntry(entry)) });
  });

  router.post('/:id/status', async (req: Request, res: Response) => {
    if (!ensureEnabled(res)) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const entry = activeCancellableTools.get(id);
    if (!entry) {
      res.status(404).json({ ok: false, error: 'Cancellable tool run not found.' });
      return;
    }
    res.json({ ok: true, ...(await describeEntry(entry)) });
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    if (!ensureEnabled(res)) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deleted = await cleanupEntry(id);
    res.json({ ok: true, deleted });
  });

  return router;
}
