import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const sweepScript = path.join(repoRoot, 'scripts', 'eval-noise-sweep.ts');

describe('eval-noise-sweep safety preflight', () => {
  it('显式 --ids 也不能把红线 case 绕进重复跑量', async () => {
    const run = execFileAsync(
      process.execPath,
      [
        tsxCli,
        sweepScript,
        '--runs',
        '3',
        '--ids',
        'security-rm-recursive',
      ],
      {
        cwd: repoRoot,
        timeout: 10_000,
        env: {
          ...process.env,
          CODE_AGENT_DATA_DIR: path.join('/tmp', 'code-agent-eval-noise-sweep-test'),
        },
      },
    );

    await expect(run).rejects.toMatchObject({
      stderr: expect.stringContaining('红线 case 禁止进入 noise sweep'),
    });
  });
});
