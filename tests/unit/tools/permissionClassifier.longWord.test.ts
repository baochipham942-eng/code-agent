import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { PermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';

describe('over-long shell words must not abort path analysis', () => {
  let tmp: string;
  let realTmp: string;
  const long = 'a'.repeat(300);

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-longword-'));
    realTmp = await fs.realpath(tmp);
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const classify = (command: string) =>
    new PermissionClassifier().classify(
      'Bash',
      { command },
      { workingDirectory: tmp, permissionLevel: 'execute' },
    );

  it('resolveCanonicalRunPath treats ENAMETOOLONG like a missing path', () => {
    expect(resolveCanonicalRunPath(path.join(tmp, long))).toBe(path.join(realTmp, long));
  });

  it('multi-line osascript is not refused by path analysis', async () => {
    const script = [
      'set targetDate to current date',
      `tell application "Reminders" to make new reminder with properties {name:"${'x'.repeat(320)}", due date:targetDate}`,
    ].join('\n');
    const result = await classify(`osascript -e '${script}'`);
    expect(result.errorCode).not.toBe('PERMISSION_PATH_ANALYSIS_FAILED');
  });

  it('long word does not hide a credential suffix', async () => {
    const result = await classify(`cat ${long}/.env`);
    expect(result.decision).not.toBe('approve');
    expect(result.errorCode).not.toBe('PERMISSION_PATH_ANALYSIS_FAILED');
  });

  it('NUL byte words still fail closed', async () => {
    const result = await classify('cat "foo\0bar"');
    expect(result.errorCode).toBe('PERMISSION_PATH_ANALYSIS_FAILED');
  });

  it('whole-path ENAMETOOLONG (every component short) stays fail-closed past PATH_MAX', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-deeptree-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-outside-'));
    const startCwd = process.cwd();
    const segment = 'd'.repeat(100);
    try {
      // Build a real tree whose absolute path exceeds PATH_MAX using relative mkdir.
      process.chdir(root);
      for (let i = 0; i < 60; i += 1) {
        fsSync.mkdirSync(segment);
        process.chdir(segment);
      }
      fsSync.symlinkSync(outside, 'link');
      const deepAbs = path.join(await fs.realpath(root), ...Array(60).fill(segment));
      expect(deepAbs.length).toBeGreaterThan(4096);
      process.chdir(startCwd);
      expect(() => resolveCanonicalRunPath(path.join(deepAbs, 'link', 'f'))).toThrow(/ENAMETOOLONG/);
    } finally {
      process.chdir(startCwd);
      execFileSync('rm', ['-rf', root, outside]);
    }
  });
});
