// ============================================================================
// Web Server - 独立 HTTP API 服务器（无 Electron 依赖）
// ============================================================================
//
// 使 renderer 可以在浏览器中运行，无需 Electron。
// 通过 mock ipcMain 来复用所有现有 IPC handler 逻辑。
//
// 启动方式:
//   node dist/web/webServer.cjs
//   或 dev 模式: npm run dev:web
//
// ============================================================================

// ⚠️ webEnvInit 必须是第一个 import — 设置 CODE_AGENT_CLI_MODE 防止 keytar SIGSEGV
import './webEnvInit';

// electron mock 通过 esbuild --alias:electron=./src/web/electronMock.ts 注入
import { handlers, ipcMain as mockIpcMain, BrowserWindow } from './electronMock';

import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID, timingSafeEqual } from 'crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { setupAllIpcHandlers, type IpcDependencies } from '../main/ipc';
import { createLogger } from '../main/services/infra/logger';
import { isLocalTool, mapToolName } from '../shared/localTools';
import type { ExecuteOptions } from '../main/tools/toolExecutor';

const logger = createLogger('WebServer');

// ============================================================================
// SSE 客户端管理
// ============================================================================

const sseClients = new Set<Response>();

// 活跃 AgentLoop 实例追踪（用于 cancel）
const activeAgentLoops = new Map<string, { cancel(): void }>();

// ── 会话消息缓存（Web 模式下 DB 不可用，用内存缓存维持多轮上下文）──
interface CachedToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}
interface CachedMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolCalls?: CachedToolCall[];
  thinking?: string;
}
const sessionMessages = new Map<string, CachedMessage[]>();
const SESSION_CACHE_MAX = 50; // 最多缓存 50 个会话

// ── 内存会话存储（better-sqlite3 native module 不可用时的降级方案）──
interface InMemorySession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  isArchived?: boolean;
  archivedAt?: number;
  messageCount: number;
}
const inMemorySessions = new Map<string, InMemorySession>();
let dbAvailable = false; // 在 initializeServices 中设置

// ── Local Tool Bridge: 待处理的本地工具调用 ──
// key = toolCallId, value = { resolve, reject, sseResponse }
interface PendingLocalToolCall {
  resolve: (result: { success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingLocalToolCalls = new Map<string, PendingLocalToolCall>();
const LOCAL_TOOL_TIMEOUT_MS = 120_000; // 2 分钟超时
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const UPLOAD_ROOT_DIR = path.join(os.tmpdir(), 'code-agent-uploads');
// ============================================================================
// Security: Auth Token, CORS Restriction, Rate Limiting
// ============================================================================

/** Server auth token — generated on startup, printed to stdout for Tauri/frontend */
const SERVER_AUTH_TOKEN = randomUUID();

/** Allowed CORS origins */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
  'https://tauri.localhost',
]);

/** Rate limit config: route pattern -> { max requests, window in ms } */
const RATE_LIMITS: Array<{ pattern: string | RegExp; max: number; windowMs: number }> = [
  { pattern: '/api/run', max: 10, windowMs: 60_000 },
  { pattern: '/api/upload/temp', max: 20, windowMs: 60_000 },
  { pattern: /^\/api\//, max: 100, windowMs: 60_000 },
];

/** In-memory rate limit store: key -> timestamps */
const rateLimitStore = new Map<string, number[]>();

function getRateLimitKey(ip: string, pattern: string | RegExp): string {
  return `${ip}:${String(pattern)}`;
}

function checkRateLimit(ip: string, routePath: string): { allowed: boolean; retryAfterMs?: number } {
  for (const rule of RATE_LIMITS) {
    const matches = typeof rule.pattern === 'string'
      ? routePath === rule.pattern
      : rule.pattern.test(routePath);
    if (!matches) continue;

    const key = getRateLimitKey(ip, rule.pattern);
    const now = Date.now();
    const timestamps = rateLimitStore.get(key) || [];
    const valid = timestamps.filter((t) => now - t < rule.windowMs);

    if (valid.length >= rule.max) {
      const oldestValid = valid[0];
      const retryAfterMs = rule.windowMs - (now - oldestValid);
      return { allowed: false, retryAfterMs };
    }

    valid.push(now);
    rateLimitStore.set(key, valid);
    return { allowed: true };
  }
  return { allowed: true };
}

/** Constant-time token comparison to prevent timing attacks */
function verifyToken(provided: string): boolean {
  const expected = Buffer.from(SERVER_AUTH_TOKEN, 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// Periodic cleanup of stale rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitStore) {
    const valid = timestamps.filter((t) => now - t < 120_000);
    if (valid.length === 0) {
      rateLimitStore.delete(key);
    } else {
      rateLimitStore.set(key, valid);
    }
  }
}, 5 * 60_000).unref();


/**
 * 向所有 SSE 客户端推送事件
 */
export function broadcastSSE(channel: string, args: unknown): void {
  const data = JSON.stringify({ channel, args });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

function ensureUploadRootDir(): void {
  fs.mkdirSync(UPLOAD_ROOT_DIR, { recursive: true });
}

function cleanupUploadDirs(): void {
  try {
    if (!fs.existsSync(UPLOAD_ROOT_DIR)) return;
    for (const entry of fs.readdirSync(UPLOAD_ROOT_DIR)) {
      fs.rmSync(path.join(UPLOAD_ROOT_DIR, entry), { recursive: true, force: true });
    }
  } catch (error) {
    logger.warn('Failed to cleanup upload temp directories', error);
  }
}

function sanitizePathSegment(segment: string): string {
  const cleaned = segment
    .replace(/[/\\]/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'file';
}

function sanitizeRelativePath(relativePath?: string): string[] {
  if (!relativePath) return [];
  return relativePath
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map(sanitizePathSegment);
}

async function readRequestBuffer(req: Request, maxSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxSize) {
        reject(new Error(`File exceeds ${Math.floor(maxSize / (1024 * 1024))}MB limit`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Upload aborted')));
  });
}

function parseMultipartUpload(body: Buffer, boundary: string): {
  filename: string;
  data: Buffer;
  fields: Record<string, string>;
} {
  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const fields: Record<string, string> = {};
  let filePart: { filename: string; data: Buffer } | null = null;
  let cursor = body.indexOf(delimiter);

  while (cursor !== -1) {
    cursor += delimiter.length;
    if (body.slice(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    if (body.slice(cursor, cursor + 2).equals(Buffer.from('\r\n'))) cursor += 2;

    const nextBoundary = body.indexOf(delimiter, cursor);
    if (nextBoundary === -1) break;

    const part = body.slice(cursor, nextBoundary - 2);
    const headerEnd = part.indexOf(headerSeparator);
    if (headerEnd === -1) {
      cursor = nextBoundary;
      continue;
    }

    const rawHeaders = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + headerSeparator.length);
    const disposition = rawHeaders
      .split('\r\n')
      .find((line) => line.toLowerCase().startsWith('content-disposition:'));

    if (!disposition) {
      cursor = nextBoundary;
      continue;
    }

    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    const fieldName = nameMatch?.[1];
    if (!fieldName) {
      cursor = nextBoundary;
      continue;
    }

    if (filenameMatch) {
      filePart = { filename: filenameMatch[1], data: content };
    } else {
      fields[fieldName] = content.toString('utf8');
    }

    cursor = nextBoundary;
  }

  if (!filePart) {
    throw new Error('Missing file field');
  }

  return { ...filePart, fields };
}

async function handleTempUpload(req: Request, res: Response): Promise<void> {
  const contentType = req.header('content-type') || '';
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!contentType.toLowerCase().startsWith('multipart/form-data') || !boundaryMatch) {
    res.status(400).json({ error: 'Expected multipart/form-data' });
    return;
  }

  const body = await readRequestBuffer(req, MAX_UPLOAD_SIZE);
  const boundary = boundaryMatch[1].trim().replace(/^"|"$/g, '');
  const { filename, data, fields } = parseMultipartUpload(body, boundary);
  const relativeSegments = sanitizeRelativePath(fields.relativePath);
  const safeFileName = sanitizePathSegment(path.basename(filename));
  const safeSegments = relativeSegments.length > 0
    ? [...relativeSegments.slice(0, -1), sanitizePathSegment(relativeSegments[relativeSegments.length - 1])]
    : [safeFileName];
  const uploadDir = path.join(UPLOAD_ROOT_DIR, randomUUID());
  const destinationPath = path.join(uploadDir, ...safeSegments);
  const resolvedUploadDir = path.resolve(uploadDir);
  const resolvedDestination = path.resolve(destinationPath);

  if (!resolvedDestination.startsWith(`${resolvedUploadDir}${path.sep}`)) {
    res.status(400).json({ error: 'Invalid upload path' });
    return;
  }

  fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true });
  fs.writeFileSync(resolvedDestination, data);
  res.json({ path: resolvedDestination });
}

// ============================================================================
// 服务初始化
// ============================================================================

/**
 * 初始化后端服务（数据库、配置等）
 * 直接使用 main 服务（与 IPC handler 内部 import 一致）
 */
async function initializeServices(): Promise<void> {
  // 设置环境
  process.env.CODE_AGENT_CLI_MODE = 'true';
  process.env.CODE_AGENT_WEB_MODE = 'true';

  // 加载 .env 文件（确保 API Key 等环境变量可用）
  try {
    const dotenv = await import("dotenv");
    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      logger.info(`.env loaded from ${envPath}`);
    }
  } catch (e) {
    logger.warn(".env loading failed:", (e as Error).message);
  }

  // 设置数据目录（electronMock 的 app.getPath('userData') 也读这个变量）
  const dataDir = path.join(os.homedir(), '.code-agent');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  cleanupUploadDirs();
  ensureUploadRootDir();

  // 1. 初始化 ConfigService（main 模块的单例，IPC handler 通过 getConfigService() 获取）
  const { initConfigService } = await import('../main/services/core/configService');
  const configService = initConfigService();
  await configService.initialize();
  logger.info('ConfigService initialized');

  // 2. 初始化 Supabase（auth 等服务依赖）
  try {
    const { initSupabase } = await import('../main/services/infra/supabaseService');
    const { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } = await import('../shared/constants');
    const settings = configService.getSettings() as Record<string, any>;
    const supabaseUrl = process.env.SUPABASE_URL || settings.supabase?.url || DEFAULT_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || settings.supabase?.anonKey || DEFAULT_SUPABASE_ANON_KEY;
    initSupabase(supabaseUrl, supabaseAnonKey);
    logger.info('Supabase initialized');
  } catch (error) {
    logger.warn('Supabase not available:', (error as Error).message);
  }

  // 3. 初始化 AuthService（依赖 Supabase，恢复登录态）
  try {
    const { getAuthService } = await import('../main/services/auth/authService');
    await getAuthService().initialize();
    logger.info('AuthService initialized');
  } catch (error) {
    logger.warn('AuthService not available:', (error as Error).message);
  }

  // 4. 初始化 Database（main 模块的单例，SessionManager 等依赖）
  try {
    const { initDatabase } = await import('../main/services/core/databaseService');
    await initDatabase();
    dbAvailable = true;
    logger.info('Database initialized');
  } catch (error) {
    if (error instanceof Error) {
      logger.warn('Database not available (using in-memory sessions):', error.message);
      logger.warn('Database init stack:', error.stack);
    } else {
      logger.warn('Database not available (using in-memory sessions):', String(error));
    }
  }

  // 5. 初始化 MemoryService（session handler 的 handleCreate 会调用 getMemoryService）
  try {
    const { initMemoryService } = await import('../main/memory/memoryService');
    initMemoryService({
      maxRecentMessages: 10,
      toolCacheTTL: 5 * 60 * 1000,
      maxSessionMessages: 100,
      maxRAGResults: 5,
      ragTokenLimit: 2000,
    });
    logger.info('MemoryService initialized');
  } catch (error) {
    logger.warn('MemoryService not available:', (error as Error).message);
  }

  logger.info('Backend services initialized');
}

/**
 * 注册所有 IPC handler 到 mock ipcMain
 */
// Web 模式的全局 BrowserWindow 实例（webContents.send → broadcastSSE）
const webModeWindow = new BrowserWindow();

function registerHandlers(): void {
  let currentSessionId: string | null = null;

  const deps: IpcDependencies = {
    getMainWindow: () => webModeWindow as any,
    getAppService: () => null, // Web mode uses HTTP API, not AppService
    getConfigService: () => {
      try {
        const { getConfigService } = require('../main/services/core/configService');
        return getConfigService();
      } catch {
        return null;
      }
    },
    getPlanningService: () => null,
    getTaskManager: () => null,
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: (id: string) => {
      currentSessionId = id;
    },
  };

  // setupAllIpcHandlers 会同时处理:
  // 1. 接受 ipcMain 参数的 handler — 注册到我们传入的 mockIpcMain
  // 2. 直接 import { ipcMain } from 'electron' 的 handler — 注册到 electronMock 的 ipcMain
  // 由于 installElectronMock() 已将 'electron' 模块替换为 mock，两种方式最终都注册到同一个 handlers Map
  setupAllIpcHandlers(mockIpcMain as any, deps);

  // Override domain:session handler — session.ipc.ts requires AppService which is null in web mode.
  // Re-route to SessionManager (same logic as the REST /api/sessions endpoints).
  handlers.set('domain:session', async (_event: unknown, request: { action: string; payload?: any }) => {
    const { action, payload } = request;
    try {
      let sm: Awaited<ReturnType<typeof import('../main/services/infra/sessionManager').getSessionManager>> | null = null;
      if (dbAvailable) {
        try {
          const { getSessionManager } = await import('../main/services/infra/sessionManager');
          sm = getSessionManager();
        } catch { /* DB not available */ }
      }
      if (!sm) {
        return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'SessionManager not available' } };
      }
      let data: unknown;
      switch (action) {
        case 'list':
          data = await sm.listSessions(payload as { includeArchived?: boolean } | undefined);
          break;
        case 'create':
          data = await sm.createSession({
            title: payload?.title || 'New Session',
            generationId: 'gen8',
            modelConfig: {
              provider: 'moonshot',
              model: 'kimi-k2.5',
              temperature: 0.7,
              maxTokens: 8192,
            },
          });
          break;
        case 'load':
          data = await sm.restoreSession(payload?.sessionId);
          break;
        case 'delete':
          await sm.deleteSession(payload?.sessionId);
          data = null;
          break;
        case 'getMessages':
          data = await sm.getMessages(payload?.sessionId);
          break;
        case 'export':
          data = await sm.exportSession(payload?.sessionId);
          break;
        case 'update':
          await sm.updateSession(payload?.sessionId, payload?.updates || {});
          data = null;
          break;
        case 'archive':
          data = await sm.archiveSession(payload?.sessionId);
          break;
        case 'unarchive':
          data = await sm.unarchiveSession(payload?.sessionId);
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown session action: ${action}` } };
      }
      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  logger.info(`Registered ${handlers.size} IPC handlers`);
}

function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function isWorkspaceFileAllowed(targetPath: string): boolean {
  const allowedRoots = [path.resolve(process.cwd()), path.resolve(os.tmpdir())];
  return allowedRoots.some((root) => isPathWithinBase(targetPath, root));
}

function getContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.ts':
      return 'text/plain; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

// ============================================================================
// Express 应用
// ============================================================================

function createApp(): express.Express {
  const app = express();

  // CORS — restrict to known origins
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    // If no origin header (e.g. same-origin, curl), don't set the header at all
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Rate limiting
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const result = checkRateLimit(ip, req.path);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.ceil((result.retryAfterMs || 60_000) / 1000)));
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }
    next();
  });

  // Auth — Bearer token required for all /api/* except /api/health
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // Health endpoint is exempt from auth (used for liveness probes)
    if (req.path === '/health') {
      next();
      return;
    }
    // Accept token from Authorization header or query param (for SSE EventSource)
    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;
    let token: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (queryToken) {
      token = queryToken;
    }
    if (!token) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    if (!verifyToken(token)) {
      res.status(403).json({ error: 'Invalid auth token' });
      return;
    }
    next();
  });

  // JSON body parser
  app.use(express.json({ limit: '50mb', strict: false }));

  // ── Health ──────────────────────────────────────────────────────────
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      mode: 'web-standalone',
      timestamp: Date.now(),
      handlers: handlers.size,
    });
  });

  // ── SSE Events ─────────────────────────────────────────────────────
  app.get('/api/events', (_req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"channel":"connected","args":{}}\n\n');

    sseClients.add(res);

    _req.on('close', () => {
      sseClients.delete(res);
    });
  });

  app.post('/api/upload/temp', async (req: Request, res: Response) => {
    try {
      await handleTempUpload(req, res);
    } catch (error) {
      logger.error('Temporary upload failed', error);
      const message = formatError(error);
      const status = message.includes('50MB limit')
        ? 413
        : (message === 'Missing file field' || message === 'Upload aborted' ? 400 : 500);
      res.status(status).json({ error: message });
    }
  });

  app.get('/api/workspace/file', async (req: Request, res: Response) => {
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

  // ── Agent Run (SSE streaming) ──────────────────────────────────────
  app.post('/api/run', async (req: Request, res: Response) => {
    const { prompt, project, model, provider, generation } = req.body;

    if (!prompt) {
      res.status(400).json({ error: 'Missing prompt' });
      return;
    }

    // SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const taskId = `task-${Date.now()}`;
    // 使用请求中的 sessionId，或生成一个临时的（web 模式兼容）
    const sessionId = req.body.sessionId || `web-session-${Date.now()}`;
    sendSSE(res, 'task_start', { taskId, prompt, sessionId });

    try {
      const { createCLIAgent } = await import('../cli/adapter');
      const { createAgentLoop } = await import('../cli/bootstrap');

      const agent = await createCLIAgent({
        project: project || process.cwd(),
        gen: generation,
        model,
        provider,
        json: true,
      });

      const config = agent.getConfig();

      // Bug 4 fix: 注入 Web 模式上下文，避免 Agent 默认以 CLI 模式自居
      if (!config.systemPrompt) {
        config.systemPrompt = 'You are running in Web UI mode (browser-based interface), not CLI/terminal mode. Users interact with you through a web chat interface with rich rendering support (markdown, code blocks, images). Respond accordingly.';
      }

      // Fix: CLI config maps 'anthropic' but provider is 'claude'
      // Ensure apiKey is populated from env if missing
      if (!config.modelConfig.apiKey) {
        const providerEnvMap: Record<string, string> = {
          claude: 'ANTHROPIC_API_KEY',
          openai: 'OPENAI_API_KEY',
          deepseek: 'DEEPSEEK_API_KEY',
          gemini: 'GEMINI_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          groq: 'GROQ_API_KEY',
          moonshot: 'MOONSHOT_API_KEY',
        };
        const envKey = providerEnvMap[config.modelConfig.provider];
        if (envKey && process.env[envKey]) {
          config.modelConfig.apiKey = process.env[envKey];
        }
      }

      // ── 构建消息历史（多轮上下文）──
      const userContent: unknown[] = [{ type: 'text', text: prompt }];
      if (req.body.attachments?.length) {
        for (const att of req.body.attachments) {
          if (att.category === 'image' && att.data) {
            userContent.push({
              type: 'image',
              source: { type: 'base64', media_type: att.mimeType || 'image/png', data: att.data },
            });
          }
        }
      }

      const msgId = `msg-${Date.now()}`;
      const userMsg: CachedMessage = {
        id: msgId,
        role: 'user' as const,
        content: prompt,
        timestamp: Date.now(),
      };

      // 加载历史消息 + 当前用户消息
      // 只传 role/content/timestamp 给 agentLoop，toolCalls/thinking 仅用于持久化
      const history = (sessionMessages.get(sessionId) || []).map(({ id, role, content, timestamp }) => ({
        id, role: role as 'user' | 'assistant', content, timestamp,
      }));
      const messages = [...history, userMsg] as import('../shared/types').Message[];

      // ── Tool Executor 选择 ──
      // webServer 本身是 Node.js 进程，默认直接用 originalExecutor 执行本地工具。
      // 仅当 BRIDGE_MODE=true（远程部署）时才走 Bridge 代理路径。
      const useBridge = process.env.BRIDGE_MODE === 'true';
      const { getToolExecutor } = await import('../cli/bootstrap');
      const originalExecutor = getToolExecutor();

      let bridgeToolExecutor = originalExecutor ? {
        execute: originalExecutor.execute.bind(originalExecutor),
        setWorkingDirectory: originalExecutor.setWorkingDirectory?.bind(originalExecutor),
        setAuditEnabled: originalExecutor.setAuditEnabled?.bind(originalExecutor),
      } : undefined;

      if (useBridge && originalExecutor) {
        // 远程部署模式：本地工具通过 Bridge 代理到用户机器执行
        const localToolProxy = {
          execute: async (toolName: string, params: Record<string, unknown>, _options: ExecuteOptions) => {
            if (!isLocalTool(toolName)) return null;

            const bridgeTool = mapToolName(toolName);
            const toolCallId = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            sendSSE(res, 'tool_call_local', {
              toolCallId,
              tool: bridgeTool,
              originalTool: toolName,
              params,
              permissionLevel: 'L1',
              sessionId,
            });

            return new Promise<{ success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }>((resolve) => {
              const timer = setTimeout(() => {
                pendingLocalToolCalls.delete(toolCallId);
                resolve({
                  success: false,
                  error: `Local tool '${toolName}' timed out after ${LOCAL_TOOL_TIMEOUT_MS / 1000}s waiting for Bridge response`,
                });
              }, LOCAL_TOOL_TIMEOUT_MS);

              pendingLocalToolCalls.set(toolCallId, { resolve, reject: () => { clearTimeout(timer); }, timer });
            });
          },
        };

        bridgeToolExecutor = {
          execute: async (toolName: string, params: Record<string, unknown>, options: ExecuteOptions) => {
            const proxyResult = await localToolProxy.execute(toolName, params, options);
            if (proxyResult === null) return originalExecutor.execute(toolName, params, options);
            // Bridge 连接失败时降级到本地执行
            if (!proxyResult.success && proxyResult.error?.includes('Bridge is not connected')) {
              logger.warn(`[BridgeProxy] Bridge down, falling back to local executor for: ${toolName}`);
              return originalExecutor.execute(toolName, params, options);
            }
            return proxyResult;
          },
          setWorkingDirectory: originalExecutor.setWorkingDirectory?.bind(originalExecutor),
          setAuditEnabled: originalExecutor.setAuditEnabled?.bind(originalExecutor),
        };
      }

      // 收集助手回复（文本 + 工具调用 + 思考过程）
      let assistantText = '';
      let assistantThinking = '';
      let consecutiveToolFailures = 0;
      const assistantToolCalls: CachedToolCall[] = [];
      const toolResultMessages: CachedMessage[] = [];

      const agentLoop = createAgentLoop(config, (event) => {
        // 附带 sessionId 确保前端会话隔离。
        // event.data 可能是对象或数组（如 todo_update 的 TodoItem[]），
        // 数组不能 spread 进对象，需要区分处理。
        const eventData = Array.isArray(event.data)
          ? { items: event.data, sessionId }
          : event.data ? { ...event.data, sessionId } : { sessionId };
        sendSSE(res, event.type, eventData);

        // 收集 stream_chunk 中的文本
        if (event.type === 'stream_chunk' && event.data?.content) {
          assistantText += event.data.content;
        }
        // 收集 reasoning/thinking
        if (event.type === 'stream_reasoning' && event.data?.content) {
          assistantThinking += event.data.content;
        }
        // 收集工具调用开始
        if (event.type === 'tool_call_start' && event.data) {
          assistantToolCalls.push({
            id: event.data.id || `tool-${assistantToolCalls.length}`,
            name: event.data.name || 'unknown',
          });
        }
        // 收集工具调用结果 + 连续失败检测
        if (event.type === 'tool_call_end' && event.data) {
          const output = event.data.success
            ? String(event.data.output || '').substring(0, 500)
            : `Error: ${event.data.error || 'unknown'}`;
          toolResultMessages.push({
            id: `toolres-${Date.now()}-${toolResultMessages.length}`,
            role: 'tool',
            content: output,
            timestamp: Date.now(),
          });
          // 工具失败时通知前端
          if (!event.data.success) {
            consecutiveToolFailures++;
            if (consecutiveToolFailures >= 2) {
              sendSSE(res, 'error', {
                data: { message: `工具连续 ${consecutiveToolFailures} 次失败: ${event.data.error || 'unknown'}`, level: 'warning' },
                sessionId,
              });
            }
          } else {
            consecutiveToolFailures = 0;
          }
        }
      }, messages, undefined, undefined, bridgeToolExecutor);

      // 存储当前 agentLoop 引用，供 cancel 使用
      activeAgentLoops.set(sessionId, agentLoop);

      await agentLoop.run(prompt);

      // ── 缓存会话消息（维持多轮上下文）──
      // 无论 assistantText 是否为空都要缓存 userMsg，否则工具-only 轮次会丢失上下文
      const assistantMsgId = `msg-${Date.now()}-a`;
      const cached = [...(sessionMessages.get(sessionId) || []), userMsg];
      if (assistantText || assistantToolCalls.length > 0) {
        cached.push({
          id: assistantMsgId,
          role: 'assistant',
          content: assistantText,
          timestamp: Date.now(),
          toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
          thinking: assistantThinking || undefined,
        });
        // 注意：toolResultMessages 不存入 sessionMessages，避免 role:'tool' 消息
        // 被传入 createAgentLoop 导致类型不匹配。工具结果只存到 DB/Supabase。
      }
      sessionMessages.set(sessionId, cached);

      // LRU 清理：超过上限时移除最旧的会话
      if (sessionMessages.size > SESSION_CACHE_MAX) {
        const oldestKey = sessionMessages.keys().next().value;
        if (oldestKey) sessionMessages.delete(oldestKey);
      }

      // ── 更新内存会话元数据 ──
      {
        const title = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
        const existing = inMemorySessions.get(sessionId);
        if (existing) {
          existing.updatedAt = Date.now();
          existing.messageCount = (sessionMessages.get(sessionId) || []).length;
          if (history.length === 0) existing.title = title;
        } else {
          inMemorySessions.set(sessionId, {
            id: sessionId,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: (sessionMessages.get(sessionId) || []).length,
          });
        }
      }

      // ── 持久化到数据库（优先走 SM 保持缓存一致）──
      if (dbAvailable) {
        try {
          const sm = await tryGetSessionManager();
          if (sm) {
            // 通过 SM 写入，同时更新 DB 和 sessionCache
            await sm.addMessageToSession(sessionId, {
              id: msgId,
              role: 'user',
              content: prompt,
              timestamp: userMsg.timestamp,
            } as import('../shared/types').Message);
            if (assistantText || assistantToolCalls.length > 0) {
              await sm.addMessageToSession(sessionId, {
                id: assistantMsgId,
                role: 'assistant',
                content: assistantText,
                timestamp: Date.now(),
                toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                thinking: assistantThinking || undefined,
              } as import('../shared/types').Message);
            }
          } else {
            // SM 不可用时降级为直写 DB
            const { getDatabase } = await import('../main/services/core/databaseService');
            const db = getDatabase();
            const existingSession = db.getSession(sessionId);
            if (!existingSession) {
              const { DEFAULT_PROVIDER, DEFAULT_MODELS } = await import('../shared/constants');
              db.createSessionWithId(sessionId, {
                title: prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt,
                generationId: 'gen8',
                modelConfig: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.chat },
              });
            }
            db.addMessage(sessionId, {
              id: msgId,
              role: 'user',
              content: prompt,
              timestamp: userMsg.timestamp,
            } as import('../shared/types').Message);
            if (assistantText || assistantToolCalls.length > 0) {
              db.addMessage(sessionId, {
                id: assistantMsgId,
                role: 'assistant',
                content: assistantText,
                timestamp: Date.now(),
                toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                thinking: assistantThinking || undefined,
              } as import('../shared/types').Message);
            }
          }
          // 更新会话标题/时间戳
          const { getDatabase: getDb } = await import('../main/services/core/databaseService');
          const db = getDb();
          if (history.length === 0) {
            const title = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
            db.updateSession(sessionId, { title, updatedAt: Date.now() });
          } else {
            db.updateSession(sessionId, { updatedAt: Date.now() });
          }
        } catch (dbErr) {
          logger.warn('Failed to persist messages to DB:', (dbErr as Error).message);
        }
      }

      // ── 持久化到 Supabase（Web 模式云端同步）──
      try {
        const sb = await getSupabaseForSession();
        if (sb) {
          const { DEFAULT_PROVIDER, DEFAULT_MODELS } = await import('../shared/constants');
          const title = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
          // Upsert session
          await sb.supabase.from('sessions').upsert({
            id: sessionId,
            user_id: sb.userId,
            title,
            generation_id: 'gen8',
            model_provider: DEFAULT_PROVIDER,
            model_name: DEFAULT_MODELS.chat,
            created_at: Date.now(),
            updated_at: Date.now(),
            source_device_id: 'web',
          }, { onConflict: 'id' });
          // Insert user message
          await sb.supabase.from('messages').insert({
            id: msgId,
            session_id: sessionId,
            user_id: sb.userId,
            role: 'user',
            content: prompt,
            timestamp: userMsg.timestamp,
            updated_at: Date.now(),
            source_device_id: 'web',
          });
          // Insert assistant message
          if (assistantText || assistantToolCalls.length > 0) {
            await sb.supabase.from('messages').insert({
              id: assistantMsgId,
              session_id: sessionId,
              user_id: sb.userId,
              role: 'assistant',
              content: assistantText,
              tool_calls: assistantToolCalls.length > 0 ? JSON.stringify(assistantToolCalls) : null,
              thinking: assistantThinking || null,
              timestamp: Date.now(),
              updated_at: Date.now(),
              source_device_id: 'web',
            });
          }
          // 更新会话标题（第一轮消息时）
          if (history.length === 0) {
            await sb.supabase.from('sessions').update({ title, updated_at: Date.now() }).eq('id', sessionId);
          }
        }
      } catch (sbErr) {
        logger.warn('Failed to persist messages to Supabase:', (sbErr as Error).message);
      }

      // 通知前端更新会话标题（第一轮消息时）
      if (history.length === 0) {
        const title = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
        broadcastSSE('session:updated', { sessionId, updates: { title } });
      }

      // 发送 agent_complete（useAgent 依赖此事件清除处理状态）
      sendSSE(res, 'agent_complete', { sessionId });
    } catch (error) {
      sendSSE(res, 'error', {
        message: error instanceof Error ? error.message : 'Unknown error',
        sessionId,
      });
    } finally {
      activeAgentLoops.delete(sessionId);
      res.end();
    }
  });

  // ── Cancel ─────────────────────────────────────────────────────────
  app.post('/api/cancel', (req: Request, res: Response) => {
    const sessionId = req.body?.sessionId;
    if (sessionId && activeAgentLoops.has(sessionId)) {
      activeAgentLoops.get(sessionId)!.cancel();
      activeAgentLoops.delete(sessionId);
      res.json({ message: 'Cancelled', sessionId });
    } else if (activeAgentLoops.size > 0) {
      // 没指定 sessionId 时取消最后一个
      const lastKey = [...activeAgentLoops.keys()].pop()!;
      activeAgentLoops.get(lastKey)!.cancel();
      activeAgentLoops.delete(lastKey);
      res.json({ message: 'Cancelled', sessionId: lastKey });
    } else {
      res.json({ message: 'No active agent to cancel' });
    }
  });

  // ── Tool Result (Local Bridge 前端回传工具执行结果) ────────────────
  app.post('/api/tool-result', (req: Request, res: Response) => {
    const { toolCallId, success, output, error, metadata } = req.body;
    if (!toolCallId) {
      res.status(400).json({ error: 'Missing toolCallId' });
      return;
    }
    const pending = pendingLocalToolCalls.get(toolCallId);
    if (!pending) {
      res.status(404).json({ error: `No pending tool call: ${toolCallId}` });
      return;
    }
    clearTimeout(pending.timer);
    pendingLocalToolCalls.delete(toolCallId);
    pending.resolve({ success: !!success, output, error, metadata });
    res.json({ message: 'Tool result received', toolCallId });
  });

  // ── Sessions ────────────────────────────────────────────────────────
  // Web 模式下 better-sqlite3 native module 不可用，AppService 为 null。
  // 使用 DB 优先 + 内存降级 的双轨策略。

  /**
   * 获取 SessionManager（仅在 DB 可用时）
   * @returns SessionManager 或 null（DB 不可用时）
   */
  async function tryGetSessionManager() {
    if (!dbAvailable) return null;
    try {
      const { getSessionManager } = await import('../main/services/infra/sessionManager');
      return getSessionManager();
    } catch {
      return null;
    }
  }

  /**
   * 获取 Supabase client + user_id（用于 Web 模式云端持久化）
   * @returns { supabase, userId } 或 null（Supabase 不可用时）
   */
  async function getSupabaseForSession(): Promise<{ supabase: any; userId: string } | null> {
    try {
      const { getSupabase, isSupabaseInitialized } = await import('../main/services/infra/supabaseService');
      if (!isSupabaseInitialized()) return null;
      const { getAuthService } = await import('../main/services/auth/authService');
      const user = getAuthService().getCurrentUser();
      if (!user?.id) return null;
      return { supabase: getSupabase(), userId: user.id };
    } catch {
      return null;
    }
  }

  app.get('/api/sessions', async (_req: Request, res: Response) => {
    try {
      const sm = await tryGetSessionManager();
      if (sm) {
        const includeArchived = _req.query.includeArchived === 'true';
        const sessions = await sm.listSessions({ includeArchived });
        res.json({ success: true, data: sessions });
        return;
      }
      // Supabase 降级：从云端读取会话列表
      const sb = await getSupabaseForSession();
      if (sb) {
        const { data, error } = await sb.supabase
          .from('sessions')
          .select('*')
          .eq('user_id', sb.userId)
          .eq('is_deleted', false)
          .order('updated_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data: data || [] });
        return;
      }
      // 内存降级（最后兜底）：返回内存中的会话列表
      const includeArchived = _req.query.includeArchived === 'true';
      const sessions = [...inMemorySessions.values()]
        .filter(s => includeArchived || !s.isArchived)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      res.json({ success: true, data: sessions });
    } catch (error) {
      logger.error('GET /api/sessions failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  app.post('/api/sessions', async (req: Request, res: Response) => {
    try {
      const sm = await tryGetSessionManager();
      if (sm) {
        const { DEFAULT_PROVIDER, DEFAULT_MODELS, MODEL_MAX_TOKENS } = await import('../shared/constants');
        const title = req.body?.title || 'New Session';
        const session = await sm.createSession({
          title,
          generationId: 'gen8',
          modelConfig: {
            provider: DEFAULT_PROVIDER,
            model: DEFAULT_MODELS.chat,
            temperature: 0.7,
            maxTokens: MODEL_MAX_TOKENS.DEFAULT,
          },
        });
        sm.setCurrentSession(session.id);
        res.json({ success: true, data: session });
        return;
      }
      // Supabase 降级：创建云端会话
      const sb = await getSupabaseForSession();
      if (sb) {
        const now = Date.now();
        const sessionId = `session_${now}_${Math.random().toString(36).slice(2, 8)}`;
        const { DEFAULT_PROVIDER, DEFAULT_MODELS } = await import('../shared/constants');
        const newSession = {
          id: sessionId,
          user_id: sb.userId,
          title: req.body?.title || 'New Session',
          generation_id: 'gen8',
          model_provider: DEFAULT_PROVIDER,
          model_name: DEFAULT_MODELS.chat,
          created_at: now,
          updated_at: now,
          source_device_id: 'web',
        };
        const { data, error } = await sb.supabase.from('sessions').insert(newSession).select().single();
        if (error) throw error;
        res.json({ success: true, data });
        return;
      }
      // 内存降级（最后兜底）：创建内存会话
      const now = Date.now();
      const session: InMemorySession = {
        id: `session_${now}_${Math.random().toString(36).slice(2, 8)}`,
        title: req.body?.title || 'New Session',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      };
      inMemorySessions.set(session.id, session);
      res.json({ success: true, data: session });
    } catch (error) {
      logger.error('POST /api/sessions failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  app.get('/api/sessions/:id', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        const session = await sm.restoreSession(sessionId);
        if (session) {
          // DB 路径找到了会话但消息可能为空 — 用内存缓存补充
          if (session.messages.length === 0 && sessionMessages.has(sessionId)) {
            const memMessages = (sessionMessages.get(sessionId) || []).map(m => ({
              ...m,
              toolCalls: (m as CachedMessage & { toolCalls?: CachedToolCall[] }).toolCalls || [],
            }));
            if (memMessages.length > 0) {
              logger.info('GET /api/sessions/:id — DB messages empty, falling back to in-memory cache', { sessionId, memCount: memMessages.length });
              session.messages = memMessages as import('../shared/types').Message[];
            }
          }
          res.json({ success: true, data: session });
          return;
        }
        // SM 找不到会话 — 不要直接返回 NOT_FOUND，继续尝试内存/Supabase 降级
        logger.info('GET /api/sessions/:id — SM returned null, trying fallback', { sessionId });
      }
      // Supabase 降级：从云端读取会话 + 消息
      const sb = await getSupabaseForSession();
      if (sb) {
        const { data: sessionData, error: sessionErr } = await sb.supabase
          .from('sessions')
          .select('*')
          .eq('id', sessionId)
          .eq('user_id', sb.userId)
          .eq('is_deleted', false)
          .single();
        if (sessionErr || !sessionData) {
          res.json({ success: false, error: { code: 'NOT_FOUND', message: `Session ${sessionId} not found` } });
          return;
        }
        const { data: msgData } = await sb.supabase
          .from('messages')
          .select('*')
          .eq('session_id', sessionId)
          .eq('is_deleted', false)
          .order('timestamp', { ascending: true });
        const messages = (msgData || []).map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          toolCalls: m.tool_calls || [],
        }));
        res.json({ success: true, data: { ...sessionData, messages, todos: [] } });
        return;
      }
      // 内存降级（最后兜底）：返回内存会话 + 缓存的消息
      const session = inMemorySessions.get(sessionId);
      if (!session) {
        res.json({ success: false, error: { code: 'NOT_FOUND', message: `Session ${sessionId} not found` } });
        return;
      }
      const messages = (sessionMessages.get(sessionId) || []).map(m => ({
        ...m,
        // 保留已缓存的 toolCalls，不覆盖为空数组（否则 tool-only 助手消息会被前端过滤掉）
        toolCalls: (m as CachedMessage & { toolCalls?: CachedToolCall[] }).toolCalls || [],
      }));
      res.json({ success: true, data: { ...session, messages, todos: [] } });
    } catch (error) {
      logger.error('GET /api/sessions/:id failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  app.get('/api/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const messages = await sm.getMessages(sessionId, limit);
        res.json({ success: true, data: messages });
        return;
      }
      // Supabase 降级：从云端读取消息
      const sb = await getSupabaseForSession();
      if (sb) {
        let query = sb.supabase
          .from('messages')
          .select('*')
          .eq('session_id', sessionId)
          .eq('is_deleted', false)
          .order('timestamp', { ascending: true });
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        if (limit) query = query.limit(limit);
        const { data, error } = await query;
        if (error) throw error;
        const messages = (data || []).map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          toolCalls: m.tool_calls || [],
        }));
        res.json({ success: true, data: messages });
        return;
      }
      // 内存降级（最后兜底）
      const messages = (sessionMessages.get(sessionId) || []).map(m => ({
        ...m,
        toolCalls: [],
      }));
      res.json({ success: true, data: messages });
    } catch (error) {
      logger.error('GET /api/sessions/:id/messages failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  app.delete('/api/sessions/:id', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        await sm.deleteSession(sessionId);
      } else {
        // Supabase 降级：软删除（设置 is_deleted = true）
        const sb = await getSupabaseForSession();
        if (sb) {
          const now = Date.now();
          await sb.supabase.from('sessions').update({ is_deleted: true, updated_at: now }).eq('id', sessionId).eq('user_id', sb.userId);
          await sb.supabase.from('messages').update({ is_deleted: true, updated_at: now }).eq('session_id', sessionId).eq('user_id', sb.userId);
        }
      }
      inMemorySessions.delete(sessionId);
      sessionMessages.delete(sessionId);
      res.json({ success: true, data: null });
    } catch (error) {
      logger.error('DELETE /api/sessions/:id failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  app.post('/api/sessions/:id/archive', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        const result = await sm.archiveSession(sessionId);
        res.json({ success: true, data: result });
        return;
      }
      // Supabase 降级：无 is_archived 列，直接返回成功
      const sb = await getSupabaseForSession();
      if (sb) {
        res.json({ success: true, data: null });
        return;
      }
      // 内存降级（最后兜底）
      const session = inMemorySessions.get(sessionId);
      if (session) {
        session.isArchived = true;
        session.archivedAt = Date.now();
      }
      res.json({ success: true, data: session || null });
    } catch (error) {
      logger.error('POST /api/sessions/:id/archive failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  app.post('/api/sessions/:id/unarchive', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id as string;
      const sm = await tryGetSessionManager();
      if (sm) {
        const result = await sm.unarchiveSession(sessionId);
        res.json({ success: true, data: result });
        return;
      }
      // Supabase 降级：无 is_archived 列，直接返回成功
      const sb = await getSupabaseForSession();
      if (sb) {
        res.json({ success: true, data: null });
        return;
      }
      // 内存降级（最后兜底）
      const session = inMemorySessions.get(sessionId);
      if (session) {
        session.isArchived = false;
        session.archivedAt = undefined;
      }
      res.json({ success: true, data: session || null });
    } catch (error) {
      logger.error('POST /api/sessions/:id/unarchive failed:', error);
      res.json({ success: false, error: { code: 'DB_ERROR', message: formatError(error) } });
    }
  });

  // ── Settings ───────────────────────────────────────────────────────
  app.get('/api/settings', async (_req: Request, res: Response) => {
    try {
      const handler = handlers.get('domain:settings');
      if (handler) {
        const result = await handler(null, { action: 'get', payload: undefined });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Settings handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.put('/api/settings', async (req: Request, res: Response) => {
    try {
      const handler = handlers.get('domain:settings');
      if (handler) {
        const result = await handler(null, { action: 'set', payload: { settings: req.body } });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Settings handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  // ── File extraction & Speech routes ──────────────────────────────

  app.post('/api/extract/pdf', async (req, res) => {
    try {
      const { filePath } = req.body ?? {};
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ error: 'Missing or invalid filePath' });
        return;
      }
      if (filePath.includes('..')) {
        res.status(403).json({ error: 'Path traversal not allowed' });
        return;
      }
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: 'File not found: ' + filePath });
        return;
      }

      const handler = handlers.get('extract-pdf-text');
      if (handler) {
        const result = await handler(null, resolved);
        res.json(result);
      } else {
        res.status(501).json({ error: 'extract-pdf-text handler not registered' });
      }
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.post('/api/extract/excel', async (req, res) => {
    try {
      const { filePath } = req.body ?? {};
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ error: 'Missing or invalid filePath' });
        return;
      }
      if (filePath.includes('..')) {
        res.status(403).json({ error: 'Path traversal not allowed' });
        return;
      }
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: 'File not found: ' + filePath });
        return;
      }

      const handler = handlers.get('extract-excel-text');
      if (handler) {
        const result = await handler(null, resolved);
        res.json(result);
      } else {
        res.status(501).json({ error: 'extract-excel-text handler not registered' });
      }
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.post('/api/speech/transcribe', async (req, res) => {
    try {
      const { audioData, mimeType } = req.body ?? {};
      if (!audioData || typeof audioData !== 'string') {
        res.status(400).json({ error: 'Missing or invalid audioData (base64 string)' });
        return;
      }
      if (!mimeType || typeof mimeType !== 'string') {
        res.status(400).json({ error: 'Missing or invalid mimeType' });
        return;
      }

      const handler = handlers.get('speech:transcribe');
      if (handler) {
        const result = await handler(null, { audioData, mimeType });
        res.json(result);
      } else {
        res.status(501).json({ error: 'speech:transcribe handler not registered' });
      }
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  // ── Domain Router (universal) ──────────────────────────────────────
  // Matches what httpTransport.ts's createHttpDomainAPI() calls:
  //   POST /api/domain/:domain/:action
  app.post('/api/domain/:domain/:action', async (req: Request, res: Response) => {
    const domain = String(req.params.domain);
    const action = String(req.params.action);
    const { payload, requestId } = req.body;

    // 查找 handler — IPC handler 注册时使用的 channel 名
    // 有些用 IPC_DOMAINS.XXX (如 'domain:session', 'domain:agent')
    // 有些用 IPC_CHANNELS.XXX (如 'session:list', 'settings:get')
    const handler = handlers.get(domain) || handlers.get(`domain:${domain}`);

    if (handler) {
      try {
        const result = await handler(null, { action, payload, requestId });
        res.json(result);
      } catch (error) {
        logger.error(`Domain handler error: ${domain}:${action}`, error);
        res.status(500).json({
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: formatError(error),
          },
        });
      }
      return;
    }

    // 尝试 "domain:action" 格式的直接通道匹配
    const directChannel = `${domain}:${action}`;
    const directHandler = handlers.get(directChannel);

    if (directHandler) {
      try {
        const result = await directHandler(null, payload);
        res.json(result);
      } catch (error) {
        logger.error(`Direct handler error: ${directChannel}`, error);
        res.status(500).json({
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: formatError(error),
          },
        });
      }
      return;
    }

    logger.warn(`No handler for domain: ${domain}, action: ${action}`);
    logger.warn(`Available handlers: ${[...handlers.keys()].join(', ')}`);
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `No handler for domain:${domain} action:${action}`,
      },
    });
  });

  // ── Fallback for unmapped IPC channels ─────────────────────────────
  // httpTransport.ts's channelToEndpoint() maps some channels to
  // generic paths like /api/memory/search-code
  app.all('/api/:channel/{*rest}', async (req: Request, res: Response) => {
    // Reconstruct channel name: /api/memory/search-code -> memory:search-code
    const pathParts = req.path.replace('/api/', '').split('/');
    const channel = pathParts.join(':');

    const handler = handlers.get(channel);
    if (handler) {
      try {
        const body = req.method === 'GET' ? req.query : req.body;
        // Spread array bodies as positional args to match Electron IPC convention:
        // ipcMain.handle(ch, (event, arg1, arg2, ...)) expects separate arguments
        const result = Array.isArray(body)
          ? await handler(null, ...body)
          : await handler(null, body);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: formatError(error) });
      }
      return;
    }

    res.status(404).json({ error: `Unknown channel: ${channel}` });
  });

  // ── Static file serving (production) ─────────────────────────────
  const staticDir = path.join(process.cwd(), 'dist', 'renderer');
  app.use(express.static(staticDir, {
    // Don't serve index.html via static middleware — we inject the auth token below
    index: false,
  }));

  // SPA fallback — serve index.html with injected auth token
  // This ensures only clients that load the page from this server can call APIs.
  const indexPath = path.join(staticDir, 'index.html');
  let cachedIndexHtml: string | null = null;

  app.get('/{*path}', (_req: Request, res: Response) => {
    try {
      if (!cachedIndexHtml) {
        cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8');
      }
      // Inject auth token into HTML so httpTransport can attach it to API requests
      const injectedHtml = cachedIndexHtml.replace(
        '<head>',
        `<head><script>window.__CODE_AGENT_TOKEN__="${SERVER_AUTH_TOKEN}";</script>`
      );
      res.type('html').send(injectedHtml);
    } catch {
      res.status(404).send('index.html not found');
    }
  });

  return app;
}

// ============================================================================
// Helpers
// ============================================================================

function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const port = parseInt(process.env.WEB_PORT || '8080', 10);
  const host = process.env.WEB_HOST || '127.0.0.1';

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Code Agent — Web Standalone Mode       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  // 1. 初始化后端服务
  console.log('[1/3] Initializing backend services...');
  await initializeServices();

  // 2. 注册 IPC handler
  console.log('[2/3] Registering IPC handlers...');
  registerHandlers();

  // 3. 启动 HTTP 服务
  console.log('[3/3] Starting HTTP server...');
  const app = createApp();

  const server = http.createServer(app);

  server.listen(port, host, () => {
    console.log();
    // Machine-readable startup JSON (Tauri main.rs parses this)
    console.log(JSON.stringify({ port, token: SERVER_AUTH_TOKEN }));
    console.log();
    console.log(`  API server:  http://${host}:${port}`);
    console.log(`  Health:      http://${host}:${port}/api/health`);
    console.log(`  SSE Events:  http://${host}:${port}/api/events`);
    console.log(`  Auth token:  ${SERVER_AUTH_TOKEN.slice(0, 8)}...`);
    console.log();
    console.log(`  Registered handlers: ${handlers.size}`);
    console.log(`  Channels: ${[...handlers.keys()].slice(0, 10).join(', ')}...`);
    console.log();
    console.log('  Start Vite dev server separately:');
    console.log('    npm run dev:renderer');
    console.log();
  });

  // 优雅退出
  const shutdown = () => {
    console.log('\nShutting down...');
    cleanupUploadDirs();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start web server:', err);
  process.exit(1);
});
