import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ToolCall } from '../../../src/shared/contract';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import {
  clearSearchCandidateIndexForTest,
  getSearchToReadPreflightBlock,
  recordSearchCandidatesFromResult,
} from '../../../src/host/agent/runtime/toolPreflightGuards';

function makeCtx(workingDirectory: string): RuntimeContext {
  return {
    sessionId: 'test-session',
    agentId: 'main',
    workingDirectory,
  } as RuntimeContext;
}

function toolCall(name: string, filePath: string): Pick<ToolCall, 'name' | 'arguments'> {
  return {
    name,
    arguments: { file_path: filePath },
  };
}

describe('toolPreflightGuards search-to-read', () => {
  let tmpDir: string;
  let targetPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-to-read-'));
    targetPath = path.join(tmpDir, 'target.ts');
    await fs.writeFile(targetPath, 'export const value = 1;\n', 'utf8');
    fileReadTracker.clear();
    clearSearchCandidateIndexForTest();
  });

  afterEach(async () => {
    fileReadTracker.clear();
    clearSearchCandidateIndexForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('blocks Edit when a file only appeared in search results and has not been read', () => {
    const ctx = makeCtx(tmpDir);
    recordSearchCandidatesFromResult(
      ctx,
      { name: 'Glob' },
      {
        success: true,
        metadata: {
          searchPath: tmpDir,
          matches: ['target.ts'],
        },
      },
    );

    const block = getSearchToReadPreflightBlock(ctx, toolCall('Edit', targetPath));

    expect(block).toMatchObject({
      code: 'READ_REQUIRED_AFTER_SEARCH',
      metadata: {
        blocked: true,
        path: targetPath,
        sourceTool: 'Glob',
      },
    });
  });

  it('allows mutation after the exact file has been read', async () => {
    const ctx = makeCtx(tmpDir);
    recordSearchCandidatesFromResult(
      ctx,
      { name: 'Grep' },
      {
        success: true,
        metadata: {
          searchPath: tmpDir,
          matches: [{ file: targetPath, line: 1, text: 'value' }],
        },
      },
    );
    await fileReadTracker.recordReadWithStats(targetPath);

    expect(getSearchToReadPreflightBlock(ctx, toolCall('MultiEdit', targetPath))).toBeNull();
  });

  it('blocks overwrite Write but leaves new files unconstrained', () => {
    const ctx = makeCtx(tmpDir);
    recordSearchCandidatesFromResult(
      ctx,
      { name: 'ListDirectory' },
      {
        success: true,
        metadata: {
          searchPath: tmpDir,
          entries: [{ path: targetPath, isDirectory: false }],
        },
      },
    );

    expect(getSearchToReadPreflightBlock(ctx, toolCall('Write', targetPath))?.code)
      .toBe('READ_REQUIRED_AFTER_SEARCH');
    expect(getSearchToReadPreflightBlock(ctx, toolCall('Write', path.join(tmpDir, 'new.ts'))))
      .toBeNull();
  });
});
