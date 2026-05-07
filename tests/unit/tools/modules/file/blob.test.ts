import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/main/protocol/tools';
import { blobModule } from '../../../../../src/main/tools/modules/file/blob';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: 'blob-test-session',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('blobModule', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blob-tool-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns unified artifact metadata for stat', async () => {
    const file = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(file, 'hello blob', 'utf8');
    const handler = await blobModule.createHandler();

    const result = await handler.execute({ action: 'stat', file_path: file }, makeCtx(tmpDir), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'text',
        sourceTool: 'Blob',
        path: file,
        mimeType: 'text/plain',
        sizeBytes: 10,
      });
      expect(result.output).toContain('"sha256"');
    }
  });

  it('reads a binary slice as base64 without losing artifact metadata', async () => {
    const file = path.join(tmpDir, 'sample.bin');
    await fs.writeFile(file, Buffer.from([0, 1, 2, 3, 4, 5]));
    const handler = await blobModule.createHandler();

    const result = await handler.execute(
      { action: 'read_base64', file_path: 'sample.bin', max_bytes: 4 },
      makeCtx(tmpDir),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('AAECAw==');
      expect(result.meta?.bytesRead).toBe(4);
      expect(result.meta?.truncated).toBe(true);
      expect(result.meta?.artifact).toMatchObject({ kind: 'binary', sourceTool: 'Blob' });
    }
  });
});
