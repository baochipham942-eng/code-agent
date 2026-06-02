import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import agentEngineModelsHandler from './api/v1/agent-engine-models.js';
import capabilitiesHandler from './api/v1/capabilities.js';
import configHandler from './api/v1/config.js';
import controlPlaneHandler from './api/v1/control-plane.js';
import promptsHandler from './api/prompts.js';
import updateHandler from './api/update.js';
import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from './lib/controlPlaneEnvelope.js';

type ControlPlaneHandler = (
  req: ControlPlaneRequestLike,
  res: ControlPlaneResponseLike,
) => void | Promise<void>;

const publicRoot = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
const maxBodyBytes = 1024 * 1024;

const apiHandlers: Record<string, ControlPlaneHandler> = {
  '/api/update': updateHandler,
  '/api/prompts': promptsHandler,
  '/api/v1/control-plane': controlPlaneHandler,
  '/api/v1/capabilities': capabilitiesHandler,
  '/api/v1/agent-engine-models': agentEngineModelsHandler,
  '/api/v1/config': configHandler,
};

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

class NodeControlPlaneResponse implements ControlPlaneResponseLike {
  private ended = false;

  constructor(
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse,
  ) {}

  public get isEnded(): boolean {
    return this.ended || this.res.writableEnded;
  }

  setHeader(name: string, value: string): void {
    if (!this.res.headersSent) {
      this.res.setHeader(name, value);
    }
  }

  status(code: number): ControlPlaneResponseLike {
    this.res.statusCode = code;
    return this;
  }

  json(value: unknown): void {
    if (this.isEnded) {
      return;
    }
    const body = JSON.stringify(value) ?? 'null';
    if (!this.res.hasHeader('Content-Type')) {
      this.res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    if (this.req.method?.toUpperCase() !== 'HEAD') {
      this.res.setHeader('Content-Length', Buffer.byteLength(body));
      this.res.end(body);
    } else {
      this.res.end();
    }
    this.ended = true;
  }

  end(): void {
    if (this.isEnded) {
      return;
    }
    this.res.end();
    this.ended = true;
  }
}

function normalizeApiPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.replace(/\/+$/, '');
  }
  return pathname;
}

function buildQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0] ?? '';
  }
  return query;
}

function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const method = req.method?.toUpperCase() ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBodyBytes) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.byteLength === 0) {
        resolve(undefined);
        return;
      }

      const contentType = req.headers['content-type'] ?? '';
      const text = buffer.toString('utf8');
      if (Array.isArray(contentType) ? contentType.some((entry) => entry.includes('application/json')) : contentType.includes('application/json')) {
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
        }
        return;
      }

      resolve(text);
    });

    req.on('error', reject);
  });
}

function sendPlainError(req: IncomingMessage, res: ServerResponse, statusCode: number, message: string): void {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (req.method?.toUpperCase() === 'HEAD') {
    res.end();
    return;
  }
  res.end(message);
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  handler: ControlPlaneHandler,
): Promise<void> {
  const adapter = new NodeControlPlaneResponse(req, res);
  try {
    const body = await readRequestBody(req);
    await handler({
      method: req.method,
      query: buildQuery(url.searchParams),
      headers: req.headers,
      body,
    }, adapter);
    if (!adapter.isEnded) {
      adapter.end();
    }
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    sendPlainError(
      req,
      res,
      statusCode,
      error instanceof Error ? error.message : 'Internal server error.',
    );
  }
}

function resolvePublicPath(pathname: string): string | null {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPathname === '/'
    ? 'index.html'
    : decodedPathname.replace(/^\/+/, '');
  const resolvedPath = path.resolve(publicRoot, relativePath);
  if (!resolvedPath.startsWith(`${publicRoot}${path.sep}`) && resolvedPath !== publicRoot) {
    return null;
  }
  return resolvedPath;
}

async function handleStaticRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const method = req.method?.toUpperCase() ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendPlainError(req, res, 405, 'Method not allowed.');
    return;
  }

  const filePath = resolvePublicPath(pathname);
  if (!filePath) {
    sendPlainError(req, res, 400, 'Bad request.');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendPlainError(req, res, 404, 'Not found.');
      return;
    }

    const contentType = contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fileStat.size);
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(await readFile(filePath));
  } catch {
    sendPlainError(req, res, 404, 'Not found.');
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const host = req.headers.host ?? `127.0.0.1:${process.env.PORT ?? '3000'}`;
    const url = new URL(req.url ?? '/', `http://${host}`);
    const handler = apiHandlers[normalizeApiPath(url.pathname)];

    if (handler) {
      await handleApiRequest(req, res, url, handler);
      return;
    }

    await handleStaticRequest(req, res, url.pathname);
  })().catch((error) => {
    sendPlainError(
      req,
      res,
      500,
      error instanceof Error ? error.message : 'Internal server error.',
    );
  });
});

const port = Number(process.env.PORT ?? '3000');
server.listen(port, () => {
  console.log(`Agent Neo control plane listening on :${port}`);
});
