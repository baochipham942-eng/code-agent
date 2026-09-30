import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/run-dev-slot.sh');

function runDryRun(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [SCRIPT, ...args, '--dry-run'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

describe('run-dev-slot.sh --dry-run', () => {
  it('prints the foreground command for an open-only slot', () => {
    const output = runDryRun(['3', '--open-only'], { NEO_SLOT_BACKGROUND: '0' });

    expect(output.trim()).toBe('[run-dev-slot] would run: open "/Applications/Agent Neo Dev 3.app"');
  });

  it('prints the background command for the flag and environment forms', () => {
    const expected = '[run-dev-slot] would run: open -g -j "/Applications/Agent Neo Dev 3.app"';

    expect(runDryRun(['3', '--open-only', '--background'], { NEO_SLOT_BACKGROUND: '0' }).trim()).toBe(expected);
    expect(runDryRun(['3', '--open-only'], { NEO_SLOT_BACKGROUND: '1' }).trim()).toBe(expected);
    expect(runDryRun(['1', '--open-only', '--background'], { NEO_SLOT_BACKGROUND: '0' }).trim()).toBe(
      '[run-dev-slot] would run: open -g -j "/Applications/Agent Neo Dev.app"',
    );
  });

  it('keeps foreground launch as the default', () => {
    const output = runDryRun(['2', '--open-only'], { NEO_SLOT_BACKGROUND: '0' });

    expect(output).toContain('open "/Applications/Agent Neo Dev 2.app"');
    expect(output).not.toContain('-g');
    expect(output).not.toContain('-j');
  });

  it('reports both new flags in the usage line for invalid arguments', () => {
    let error: unknown;
    try {
      runDryRun(['--unknown']);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect((error as { status?: number }).status).toBe(1);
    expect(outputText((error as { stderr?: unknown }).stderr)).toMatch(
      /Usage: .*--background.*--dry-run/,
    );
  });

  it('does not invoke npm, node, or open during a dry run', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'run-dev-slot-'));
    const bin = path.join(root, 'bin');
    const marker = path.join(root, 'invoked');
    mkdirSync(bin);

    try {
      for (const command of ['npm', 'node', 'open']) {
        const stub = path.join(bin, command);
        writeFileSync(stub, '#!/bin/bash\nprintf \'%s\\n\' "$0" >> "$RUN_DEV_SLOT_MARKER"\n');
        chmodSync(stub, 0o755);
      }

      const output = runDryRun(['3'], {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUN_DEV_SLOT_MARKER: marker,
      });

      expect(output.trim()).toBe('[run-dev-slot] would run: open "/Applications/Agent Neo Dev 3.app"');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
