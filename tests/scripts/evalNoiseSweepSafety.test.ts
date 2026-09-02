import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCasebankFixture } from '../utils/casebankFixture';

const execFileAsync = promisify(execFile);
const sourceRepoRoot = process.cwd();
const tsxCli = path.join(sourceRepoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const sweepScript = path.join(sourceRepoRoot, 'packages', 'internal', 'evaluation-center', 'scripts', 'eval-noise-sweep.ts');
let fixture: Awaited<ReturnType<typeof createCasebankFixture>>;

beforeAll(async () => {
  fixture = await createCasebankFixture();
});

afterAll(async () => {
  await fixture.cleanup();
});

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
        cwd: fixture.repoRoot,
        timeout: 10_000,
        env: {
          ...process.env,
          ...fixture.env,
          CODE_AGENT_DATA_DIR: path.join('/tmp', 'code-agent-eval-noise-sweep-test'),
          TSX_TSCONFIG_PATH: path.join(sourceRepoRoot, 'tsconfig.json'),
        },
      },
    );

    await expect(run).rejects.toMatchObject({
      stderr: expect.stringContaining('红线 case 禁止进入 noise sweep'),
    });
  });
});
