import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertAcceptanceCanaryAbsent,
  listAcceptanceRegularFiles,
} from '../../../scripts/acceptance/surface-execution-canary-scan';

describe('Surface Execution acceptance canary scan', () => {
  it('scans nested persistence and log files instead of only top-level database files', () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-canary-scan-'));
    const logs = join(root, 'logs', 'nested');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(root, 'code-agent.db'), 'safe database bytes');
    writeFileSync(join(logs, 'host.log'), 'surface-secret-canary-nested-leak');

    expect(listAcceptanceRegularFiles(root)).toHaveLength(2);
    expect(() => assertAcceptanceCanaryAbsent(
      'surface-secret-canary-nested-leak',
      [root],
    )).toThrow(/Redaction canary leaked/);
  });

  it('fails closed instead of following symlinks outside the acceptance roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-canary-symlink-'));
    const external = mkdtempSync(join(tmpdir(), 'surface-canary-external-'));
    writeFileSync(join(external, 'outside.log'), 'safe');
    symlinkSync(external, join(root, 'logs'));

    expect(() => listAcceptanceRegularFiles(root)).toThrow(/symbolic link/);
  });
});
