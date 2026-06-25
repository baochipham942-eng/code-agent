// ============================================================================
// read_tool_result_archive — read archived large tool results by ArchiveRef
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import {
  findToolResultArchiveRef,
  readToolResultArchive,
} from '../../../utils/toolResultSpill';
import { toolResultArchiveSchema as schema } from './toolResultArchive.schema';

const DEFAULT_OFFSET = 1;
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;
const MAX_LINE_WIDTH = 2000;

function normalizePositiveInteger(value: unknown, fallback: number, max?: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  const bounded = Math.max(1, parsed);
  return max ? Math.min(bounded, max) : bounded;
}

function formatArchiveLines(
  content: string,
  offset: number,
  limit: number,
): { output: string; lineCount: number; totalLines: number } {
  const lines = content.split('\n');
  const startLine = Math.max(0, offset - 1);
  const endLine = Math.min(lines.length, startLine + limit);
  const selectedLines = lines.slice(startLine, endLine);
  const output = selectedLines
    .map((line, index) => {
      const lineNumber = startLine + index + 1;
      const lineText = line.length > MAX_LINE_WIDTH ? `${line.slice(0, MAX_LINE_WIDTH)}...` : line;
      return `${String(lineNumber).padStart(6, ' ')}\t${lineText}`;
    })
    .join('\n');

  return { output, lineCount: selectedLines.length, totalLines: lines.length };
}

class ToolResultArchiveHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const artifactId = args.artifact_id;
    if (typeof artifactId !== 'string' || artifactId.trim().length === 0) {
      return { ok: false, error: 'artifact_id is required and must be a string', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const offset = normalizePositiveInteger(args.offset, DEFAULT_OFFSET);
    const limit = normalizePositiveInteger(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    onProgress?.({ stage: 'starting', detail: `archive ${artifactId}` });

    const archiveRef = findToolResultArchiveRef(artifactId.trim(), ctx.sessionId);
    if (!archiveRef) {
      return {
        ok: false,
        error: `Tool result archive not found: ${artifactId}`,
        code: 'ARCHIVE_NOT_FOUND',
      };
    }

    const archive = readToolResultArchive(archiveRef);
    if (!archive) {
      return {
        ok: false,
        error: `Tool result archive failed validation: ${artifactId}`,
        code: 'ARCHIVE_INVALID',
      };
    }

    const formatted = formatArchiveLines(archive.content, offset, limit);
    const hasLines = formatted.lineCount > 0;
    const endLine = hasLines ? offset + formatted.lineCount - 1 : 0;
    const linesLabel = hasLines
      ? `${offset}-${endLine} of ${formatted.totalLines}`
      : `none; offset ${offset} is beyond ${formatted.totalLines} lines`;
    let output =
      `Archive: ${archiveRef.artifactId}\n` +
      `Tool: ${archiveRef.toolName}\n` +
      `Reason: ${archiveRef.reason}\n` +
      `Source: ${archiveRef.sourceMessageId || archiveRef.toolCallId || 'unknown'}\n` +
      `Bytes: ${archiveRef.bytes}\n` +
      `Lines: ${linesLabel}\n\n` +
      formatted.output;
    if (hasLines && endLine < formatted.totalLines) {
      output += `\n\n... (${formatted.totalLines - endLine} more lines)`;
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output,
      meta: {
        archiveRef,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'process-output',
          sessionId: ctx.sessionId,
          name: archiveRef.artifactId,
          mimeType: 'text/plain',
          contentLength: archive.content.length,
          preview: output.slice(0, 500),
          metadata: {
            artifactId: archiveRef.artifactId,
            toolName: archiveRef.toolName,
            reason: archiveRef.reason,
          },
        }),
      },
    };
  }
}

export const toolResultArchiveModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ToolResultArchiveHandler();
  },
};
