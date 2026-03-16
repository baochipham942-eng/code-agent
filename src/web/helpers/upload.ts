// ============================================================================
// File Upload Handling — temp upload, screenshot serving, workspace file access
// ============================================================================

import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
export const UPLOAD_ROOT_DIR = path.join(os.tmpdir(), 'code-agent-uploads');

export function ensureUploadRootDir(): void {
  fs.mkdirSync(UPLOAD_ROOT_DIR, { recursive: true });
}

export function cleanupUploadDirs(): void {
  try {
    if (!fs.existsSync(UPLOAD_ROOT_DIR)) return;
    for (const entry of fs.readdirSync(UPLOAD_ROOT_DIR)) {
      fs.rmSync(path.join(UPLOAD_ROOT_DIR, entry), { recursive: true, force: true });
    }
  } catch (error) {
    // Swallow — caller can log if needed
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

export async function handleTempUpload(req: Request, res: Response): Promise<void> {
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

// ── Screenshot proxy (serves local screenshot files via HTTP) ──────────────
export function handleScreenshot(req: Request, res: Response): void {
  const filePath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;

  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    res.status(400).json({ error: 'Missing path query parameter' });
    return;
  }

  const resolved = path.resolve(filePath);

  // Security: only serve image files from known screenshot directories
  const isScreenshotDir = resolved.includes('/native-desktop/screenshots/')
    || resolved.includes('/.code-agent/native-desktop/');
  const isImageExt = /\.(jpg|jpeg|png|webp|gif)$/i.test(resolved);

  if (!isScreenshotDir || !isImageExt) {
    res.status(403).json({ error: 'Access denied: not a screenshot path' });
    return;
  }

  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const ext = path.extname(resolved).toLowerCase().replace('.', '');
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif',
  };
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(resolved).pipe(res);
}

// ── Workspace file retrieval helpers ──────────────────────────────────────
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

export { isWorkspaceFileAllowed, getContentType };
