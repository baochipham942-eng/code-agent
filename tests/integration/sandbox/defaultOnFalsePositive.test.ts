// ============================================================================
// Default-on false-positive probe: wrap common cowork commands in the real jail.
// Skip when seatbelt/bwrap is missing. A failure here is a mis-kill, not a flake.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { wrapCommandForSandbox, getSandboxManager } from '@host/sandbox';

function run(
  command: string,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const sandboxReady = (process.platform === 'darwin' || process.platform === 'linux')
  && getSandboxManager().isAvailable();
const suite = sandboxReady ? describe : describe.skip;

suite('OS sandbox default-on false-positive probe', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-defaulton-'));
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'sandbox-defaulton-probe',
      version: '1.0.0',
      private: true,
    }));
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'ok\n');
  });

  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('legitimate cowork commands succeed inside the jail', async () => {
    const cases: Array<{ command: string; check: (result: { code: number | null; stdout: string; stderr: string }) => void }> = [
      {
        command: 'echo hello-sandbox',
        check: (result) => {
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toContain('hello-sandbox');
        },
      },
      {
        command: 'pwd',
        check: (result) => {
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toContain(projectDir);
        },
      },
      {
        command: 'node -v',
        check: (result) => {
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toMatch(/v\d+\./);
        },
      },
      {
        command: 'cat notes.txt',
        check: (result) => {
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toContain('ok');
        },
      },
      {
        command: 'printf x > in-project.txt',
        check: (result) => {
          expect(result.code, result.stderr).toBe(0);
          expect(fs.existsSync(path.join(projectDir, 'in-project.txt'))).toBe(true);
        },
      },
    ];
    for (const item of cases) {
      const wrapped = wrapCommandForSandbox(item.command, {
        workingDirectory: projectDir,
        allowNetwork: false,
      });
      const result = await run(wrapped.command, projectDir);
      wrapped.cleanup();
      item.check(result);
    }
  });

  it('npm pack still works via temp userconfig (N-SANDBOX-NPM-HOME)', async () => {
    const wrapped = wrapCommandForSandbox(
      'npm config get userconfig && npm pack --dry-run',
      { workingDirectory: projectDir, allowNetwork: false },
    );
    const result = await run(wrapped.command, projectDir);
    wrapped.cleanup();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/neo-npm-[^/]+\/npmrc/);
    expect(result.stdout).toContain('sandbox-defaulton-probe-1.0.0.tgz');
  });
});
