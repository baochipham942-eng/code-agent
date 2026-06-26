// ============================================================================
// Blob — unified local artifact/blob inspection
// ============================================================================

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { createFileArtifact } from '../../artifacts/artifactMeta';
import { blobSchema as schema } from './blob.schema';

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;

function expandTilde(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function resolveInputPath(inputPath: string, workingDir: string): string {
  const expanded = expandTilde(inputPath);
  return path.isAbsolute(expanded) ? expanded : path.join(workingDir, expanded);
}

async function readSlice(filePath: string, offset: number, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean; sizeBytes: number }> {
  const stats = await fs.stat(filePath);
  const safeOffset = Math.max(0, offset);
  const safeMax = Math.min(Math.max(maxBytes, 1), MAX_BYTES);
  const bytesToRead = Math.min(safeMax, Math.max(0, stats.size - safeOffset));
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, safeOffset);
    return {
      buffer: buffer.subarray(0, bytesRead),
      truncated: safeOffset + bytesRead < stats.size,
      sizeBytes: stats.size,
    };
  } finally {
    await handle.close();
  }
}

class BlobHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const action = args.action;
    const rawPath = args.file_path;
    if (action !== 'stat' && action !== 'read_text' && action !== 'read_base64') {
      return { ok: false, error: 'action must be stat, read_text, or read_base64', code: 'INVALID_ARGS' };
    }
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return { ok: false, error: 'file_path is required and must be a string', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const filePath = resolveInputPath(rawPath, ctx.workingDir);
    onProgress?.({ stage: 'starting', detail: `Blob ${action} ${path.basename(filePath)}` });

    try {
      const artifact = await createFileArtifact(filePath, schema.name, ctx);
      if (action === 'stat') {
        onProgress?.({ stage: 'completing', percent: 100 });
        return {
          ok: true,
          output: JSON.stringify(artifact, null, 2),
          meta: { artifact },
        };
      }

      const offset = Number(args.offset ?? 0);
      const maxBytes = Number(args.max_bytes ?? DEFAULT_MAX_BYTES);
      const slice = await readSlice(filePath, offset, maxBytes);
      const output = action === 'read_base64'
        ? slice.buffer.toString('base64')
        : slice.buffer.toString('utf8');

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: [
          `Blob ${action}: ${filePath}`,
          `Bytes: ${slice.buffer.length}/${slice.sizeBytes}${slice.truncated ? ' (truncated)' : ''}`,
          '',
          output,
        ].join('\n'),
        meta: {
          artifact,
          offset,
          bytesRead: slice.buffer.length,
          truncated: slice.truncated,
          encoding: action === 'read_base64' ? 'base64' : 'utf8',
        },
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: false, error: `File not found: ${filePath}`, code: 'ENOENT' };
      }
      return { ok: false, error: e.message || 'Blob read failed', code: 'FS_ERROR' };
    }
  }
}

export const blobModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new BlobHandler();
  },
};
