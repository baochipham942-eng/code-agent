import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeContentDigest, fileReadTracker } from '../../../../src/host/tools/fileReadTracker';
import { checkExternalModification } from '../../../../src/host/tools/utils/externalModificationDetector';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const canUseDevNull = process.platform !== 'win32' && !isRoot && existsSync('/dev/null');
const canUseFifo = process.platform !== 'win32' && !isRoot;

describe('checkExternalModification non-regular files', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-modification-non-regular-'));
    fileReadTracker.clear();
  });

  afterEach(async () => {
    fileReadTracker.clear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!canUseDevNull)('skips freshness checks for /dev/null', async () => {
    await fileReadTracker.recordReadWithStats('/dev/null');

    const result = await checkExternalModification('/dev/null');

    expect(result).toEqual({
      modified: false,
      message: 'Not a regular file; freshness check skipped',
    });
  });

  it.skipIf(!canUseFifo)('returns for a FIFO without opening it', { timeout: 2000 }, async () => {
    const fifo = path.join(tmpDir, 'freshness-check-fifo');
    execFileSync('mkfifo', [fifo]);
    const stats = await fs.stat(fifo);
    fileReadTracker.recordRead(fifo, stats.mtimeMs, stats.size, {
      digest: computeContentDigest(''),
    });

    const result = await checkExternalModification(fifo);

    expect(result).toEqual({
      modified: false,
      message: 'Not a regular file; freshness check skipped',
    });
  });

  it('still detects a regular file changed after read', async () => {
    const file = path.join(tmpDir, 'regular.txt');
    await fs.writeFile(file, 'before', 'utf-8');
    await fileReadTracker.recordReadWithStats(file);
    await fs.writeFile(file, 'after external modification', 'utf-8');

    const result = await checkExternalModification(file);

    expect(result.modified).toBe(true);
  });
});
