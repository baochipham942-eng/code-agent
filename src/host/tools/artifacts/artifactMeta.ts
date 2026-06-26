// ============================================================================
// Unified tool artifact metadata helpers
// ============================================================================

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ToolContext } from '../../protocol/tools';
import type { ToolArtifact, ToolArtifactKind } from '../../../shared/contract/artifactBlob';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.jsx', '.ts', '.tsx',
  '.mjs', '.cjs', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.yaml',
  '.yml', '.csv', '.tsv', '.log', '.sql', '.sh', '.zsh', '.bash', '.py', '.rb',
  '.go', '.rs', '.java', '.kt', '.swift', '.php', '.c', '.cc', '.cpp', '.h',
  '.hpp', '.toml', '.ini', '.env',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

const DEFAULT_PREVIEW_CHARS = 500;
const MAX_HASH_BYTES = 64 * 1024 * 1024;

function makeArtifactId(input: string): string {
  return `artifact_${createHash('sha1').update(input).digest('hex').slice(0, 16)}`;
}

export function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream');
}

export function inferArtifactKind(filePath: string, mimeType = inferMimeType(filePath)): ToolArtifactKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'spreadsheet';
  if (
    mimeType.includes('pdf')
    || mimeType.includes('wordprocessing')
    || mimeType.includes('presentation')
    || mimeType === 'application/msword'
  ) {
    return 'document';
  }
  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('yaml')) {
    return 'text';
  }
  return 'binary';
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readTextPreview(filePath: string, maxChars: number): Promise<string | undefined> {
  try {
    const handle = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.max(maxChars * 2, 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function createFileArtifact(
  filePath: string,
  sourceTool: string,
  ctx?: Pick<ToolContext, 'sessionId'>,
  overrides: Partial<ToolArtifact> = {},
): Promise<ToolArtifact> {
  const resolvedPath = path.resolve(filePath);
  const mimeType = overrides.mimeType ?? inferMimeType(resolvedPath);
  const kind = overrides.kind ?? inferArtifactKind(resolvedPath, mimeType);
  const stat = await fsp.stat(resolvedPath).catch(() => null);
  const sizeBytes = overrides.sizeBytes ?? stat?.size;
  const hashSkipped = Boolean(stat && stat.size > MAX_HASH_BYTES && !overrides.sha256);
  const sha256 = overrides.sha256 ?? (
    stat && stat.size <= MAX_HASH_BYTES
      ? await sha256File(resolvedPath).catch(() => undefined)
      : undefined
  );
  const preview = overrides.preview ?? (
    kind === 'text' || kind === 'process-log'
      ? await readTextPreview(resolvedPath, DEFAULT_PREVIEW_CHARS)
      : undefined
  );
  const idBasis = `${sourceTool}:${resolvedPath}:${sha256 ?? stat?.mtimeMs ?? Date.now()}`;

  return {
    artifactId: overrides.artifactId ?? makeArtifactId(idBasis),
    kind,
    sourceTool,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    sessionId: overrides.sessionId ?? ctx?.sessionId,
    name: overrides.name ?? path.basename(resolvedPath),
    path: resolvedPath,
    mimeType,
    sizeBytes,
    sha256,
    preview,
    metadata: {
      ...(overrides.metadata ?? {}),
      ...(hashSkipped ? { hashSkipped: true, maxHashBytes: MAX_HASH_BYTES } : {}),
    },
    url: overrides.url,
    contentLength: overrides.contentLength,
  };
}

export function createVirtualArtifact(input: {
  sourceTool: string;
  kind: ToolArtifactKind;
  sessionId?: string;
  name?: string;
  url?: string;
  mimeType?: string;
  contentLength?: number;
  preview?: string;
  metadata?: Record<string, unknown>;
}): ToolArtifact {
  const idBasis = `${input.sourceTool}:${input.kind}:${input.url ?? input.name ?? ''}:${input.contentLength ?? ''}:${input.preview ?? ''}`;
  return {
    artifactId: makeArtifactId(idBasis),
    kind: input.kind,
    sourceTool: input.sourceTool,
    createdAt: new Date().toISOString(),
    sessionId: input.sessionId,
    name: input.name,
    url: input.url,
    mimeType: input.mimeType,
    contentLength: input.contentLength,
    preview: input.preview,
    metadata: input.metadata,
  };
}
