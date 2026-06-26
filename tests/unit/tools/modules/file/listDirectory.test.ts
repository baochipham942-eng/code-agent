import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/main/protocol/tools';

import { listDirectoryModule } from '../../../../../src/main/tools/modules/file/listDirectory';

function makeLogger(): Logger {
  return { debug: () => void 0, info: () => void 0, warn: () => void 0, error: () => void 0 };
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

describe('listDirectoryModule', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'list-directory-'));
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a', 'utf8');
    await fs.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'sub', 'b.ts'), 'const b = 1;', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('lists entries and returns structured metadata', async () => {
    const handler = await listDirectoryModule.createHandler();
    const result = await handler.execute(
      { path: tmpDir, recursive: true, max_depth: 2 },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('a.txt');
      expect(result.output).toContain('sub');
      expect(result.output).toContain('b.ts');
      expect(result.meta).toMatchObject({
        dirPath: tmpDir,
        recursive: true,
        maxDepth: 2,
        offset: 0,
        limit: 200,
        nextOffset: null,
        entryCount: 3,
        fileCount: 2,
        directoryCount: 1,
        entriesTruncated: false,
        artifact: expect.objectContaining({
          kind: 'text',
          sourceTool: 'ListDirectory',
        }),
      });
      expect(result.meta?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'a.txt', isDirectory: false, depth: 0 }),
          expect.objectContaining({ name: 'sub', isDirectory: true, depth: 0 }),
          expect.objectContaining({ name: 'b.ts', isDirectory: false, depth: 1 }),
        ]),
      );
    }
  });

  it('paginates entries and archives the full listing when there is another page', async () => {
    await fs.writeFile(path.join(tmpDir, 'c.txt'), 'c', 'utf8');

    const handler = await listDirectoryModule.createHandler();
    const result = await handler.execute(
      { path: tmpDir, recursive: true, max_depth: 2, sort: 'path', offset: 1, limit: 1 },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('nextOffset: 2');
      expect(result.output).toContain('[next-read]');
      expect(result.meta).toMatchObject({
        offset: 1,
        limit: 1,
        nextOffset: 2,
        entriesTruncated: true,
        archiveRef: expect.objectContaining({ reason: 'discovery-full-results' }),
      });
      expect(result.meta?.entries).toHaveLength(1);
    }
  });

  it('respects .gitignore entries by default and can opt out', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'ignored/\n', 'utf8');
    await fs.mkdir(path.join(tmpDir, 'ignored'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'ignored', 'hidden.txt'), 'hidden', 'utf8');

    const handler = await listDirectoryModule.createHandler();
    const respected = await handler.execute(
      { path: tmpDir, recursive: true, max_depth: 2 },
      makeCtx(),
      allowAll,
    );
    const ignored = await handler.execute(
      { path: tmpDir, recursive: true, max_depth: 2, respect_gitignore: false },
      makeCtx(),
      allowAll,
    );

    expect(respected.ok).toBe(true);
    if (respected.ok) expect(respected.output).not.toContain('hidden.txt');
    expect(ignored.ok).toBe(true);
    if (ignored.ok) expect(ignored.output).toContain('hidden.txt');
  });
});
