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
import { getResourceLockManager } from '../../../services/infra/resourceLockManager';
import { createFileArtifact } from '../../artifacts/artifactMeta';
import { confineEvalPath } from '../../file/pathUtils';
import { appendSchema as schema } from './append.schema';

const LOCK_HOLD_TIMEOUT_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 10_000;

function expandTilde(filePath: string): string {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function resolveInputPath(inputPath: string, workingDir: string): string {
  const expanded = expandTilde(inputPath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(workingDir, expanded);
}

class AppendHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const rawPath = args.file_path;
    const content = args.content;
    const final = args.final === true;

    if (typeof rawPath !== 'string' || !rawPath) {
      return {
        ok: false,
        error: 'file_path is required and must be a string',
        code: 'INVALID_ARGS',
      };
    }
    if (typeof content !== 'string') {
      return {
        ok: false,
        error: 'content is required and must be a string',
        code: 'INVALID_ARGS',
      };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return {
        ok: false,
        error: `permission denied: ${permit.reason}`,
        code: 'PERMISSION_DENIED',
      };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const filePath = resolveInputPath(rawPath, ctx.workingDir);
    const resolvedPath = confineEvalPath(path.resolve(filePath), ctx.workingDir);

    onProgress?.({ stage: 'starting', detail: `append ${path.basename(filePath)}` });

    const lockManager = getResourceLockManager();
    const holderId = ctx.sessionId || `append_${Date.now()}`;

    const lockResult = await lockManager.acquire(holderId, resolvedPath, 'exclusive', {
      type: 'file',
      timeout: LOCK_HOLD_TIMEOUT_MS,
      wait: true,
      waitTimeout: LOCK_WAIT_TIMEOUT_MS,
    });

    if (!lockResult.acquired) {
      return {
        ok: false,
        error: `Cannot acquire lock for ${filePath}: ${lockResult.reason}. File may be in use by another operation.`,
        code: 'FS_ERROR',
      };
    }

    try {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.appendFile(resolvedPath, content, 'utf-8');
      const stat = await fs.stat(resolvedPath);
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('Append done', {
        filePath: resolvedPath,
        appendedBytes: Buffer.byteLength(content, 'utf-8'),
        size: stat.size,
        final,
      });
      return {
        ok: true,
        output:
          `Appended file: ${resolvedPath} (${content.length} chars appended, ${stat.size} bytes total` +
          `${final ? ', final chunk' : ''})`,
        meta: {
          artifact: await createFileArtifact(resolvedPath, schema.name, ctx, {
            metadata: {
              final,
              appendedChars: content.length,
              appendedBytes: Buffer.byteLength(content, 'utf-8'),
            },
          }),
          outputPath: resolvedPath,
          final,
          contentLength: content.length,
          fileSize: stat.size,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message || 'Failed to append file',
        code: 'FS_ERROR',
      };
    } finally {
      lockManager.release(holderId, resolvedPath);
    }
  }
}

export const appendModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new AppendHandler();
  },
};
