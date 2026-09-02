import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
describe('版本化 eval slicing 资产门', () => {
  it('日常 npm eval 路径显式绑定 held-in', async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts.eval).toContain('--split held-in');
    expect(packageJson.scripts['eval:full']).toContain('--split held-in');
  });
});
