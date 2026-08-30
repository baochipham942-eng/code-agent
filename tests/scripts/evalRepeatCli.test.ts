import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EVAL_REPEAT_MAX } from '../../src/shared/contract/evaluation';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const evalScript = path.join(repoRoot, 'packages', 'internal', 'evaluation-center', 'scripts', 'eval-ci.ts');

describe('eval-ci --repeat', () => {
  it('rejects values above the bridge limit before starting a run', async () => {
    await expect(execFileAsync(
      process.execPath,
      [tsxCli, evalScript, '--repeat', String(EVAL_REPEAT_MAX + 1)],
      { cwd: repoRoot },
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`must be an integer from 1 to ${EVAL_REPEAT_MAX}`),
    });
  });
});
