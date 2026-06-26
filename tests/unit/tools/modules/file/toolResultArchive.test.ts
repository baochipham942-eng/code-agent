import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/host/protocol/tools';

const testRoot = path.join(os.tmpdir(), `neo-tool-result-archive-test-${process.pid}`);

vi.mock('../../../../../src/host/config/configPaths', async () => {
  const osMod = await import('os');
  const pathMod = await import('path');
  return {
    getUserConfigDir: () => pathMod.join(osMod.tmpdir(), `neo-tool-result-archive-test-${process.pid}`),
  };
});

import { toolResultArchiveModule } from '../../../../../src/host/tools/modules/file/toolResultArchive';
import { spillToolResultArchive } from '../../../../../src/host/utils/toolResultSpill';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

describe('toolResultArchiveModule', () => {
  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('has read-only schema metadata', () => {
    expect(toolResultArchiveModule.schema.name).toBe('read_tool_result_archive');
    expect(toolResultArchiveModule.schema.readOnly).toBe(true);
    expect(toolResultArchiveModule.schema.allowInPlanMode).toBe(true);
    expect(toolResultArchiveModule.schema.permissionLevel).toBe('read');
    expect(toolResultArchiveModule.schema.inputSchema.required).toContain('artifact_id');
  });

  it('rejects missing artifact_id', async () => {
    const handler = await toolResultArchiveModule.createHandler();
    const result = await handler.execute({}, makeCtx(), allowAll);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('returns PERMISSION_DENIED when canUseTool denies', async () => {
    const handler = await toolResultArchiveModule.createHandler();
    const result = await handler.execute(
      { artifact_id: 'tool_result:test-session:Bash:call:hash' },
      makeCtx(),
      denyAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('reads archived tool output by artifact id with line pagination', async () => {
    const content = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n');
    const archive = spillToolResultArchive({
      content,
      toolName: 'Bash',
      sessionId: 'test-session',
      toolCallId: 'call-1',
      sourceMessageId: 'msg-1',
      reason: 'unit-test',
    });
    expect(archive).not.toBeNull();

    const handler = await toolResultArchiveModule.createHandler();
    const result = await handler.execute(
      { artifact_id: archive!.archiveRef.artifactId, offset: 5, limit: 3 },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain(`Archive: ${archive!.archiveRef.artifactId}`);
      expect(result.output).toContain('Tool: Bash');
      expect(result.output).toContain('Reason: unit-test');
      expect(result.output).toContain('Source: msg-1');
      expect(result.output).toContain('Lines: 5-7 of 20');
      expect(result.output).toContain('5\tline-5');
      expect(result.output).toContain('7\tline-7');
      expect(result.output).not.toContain('line-8');
      expect(result.output).toContain('more lines');
      expect(result.meta?.archiveRef).toMatchObject({
        artifactId: archive!.archiveRef.artifactId,
        sourceMessageId: 'msg-1',
      });
      expect(result.meta?.artifact).toMatchObject({
        kind: 'process-output',
        sourceTool: 'read_tool_result_archive',
      });
    }
  });

  it('returns ARCHIVE_NOT_FOUND for unknown artifacts', async () => {
    const handler = await toolResultArchiveModule.createHandler();
    const result = await handler.execute(
      { artifact_id: 'tool_result:test-session:Bash:missing:000000000000' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ARCHIVE_NOT_FOUND');
  });

  it('reports an empty page when offset is beyond the archived output', async () => {
    const archive = spillToolResultArchive({
      content: 'line-1\nline-2',
      toolName: 'Bash',
      sessionId: 'test-session',
      toolCallId: 'call-empty-page',
    });
    expect(archive).not.toBeNull();

    const handler = await toolResultArchiveModule.createHandler();
    const result = await handler.execute(
      { artifact_id: archive!.archiveRef.artifactId, offset: 10, limit: 3 },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Lines: none; offset 10 is beyond 2 lines');
      expect(result.output).not.toContain('more lines');
    }
  });

  it('returns ARCHIVE_INVALID when archived content fails hash validation', async () => {
    const archive = spillToolResultArchive({
      content: 'original content',
      toolName: 'Bash',
      sessionId: 'test-session',
      toolCallId: 'call-invalid',
    });
    expect(archive).not.toBeNull();
    fs.writeFileSync(archive!.filePath, 'tampered content', 'utf-8');

    const handler = await toolResultArchiveModule.createHandler();
    const result = await handler.execute(
      { artifact_id: archive!.archiveRef.artifactId },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ARCHIVE_INVALID');
  });
});
