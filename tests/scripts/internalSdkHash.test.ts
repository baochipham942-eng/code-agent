import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('internal SDK contract hash gate', () => {
  it('matches the exports in the checked-in host SDK table', () => {
    const result = spawnSync('npx', ['tsx', 'scripts/internal-sdk-hash.ts', '--check'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
    });

    expect(`${result.stdout}${result.stderr}`).toContain('[internal-sdk-hash] ok');
    expect(result.status).toBe(0);
  }, 20_000);
});
