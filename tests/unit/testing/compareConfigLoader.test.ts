import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCompareConfig } from '../../../src/host/testing/comparator/configLoader';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadCompareConfig harness', () => {
  it('parses nested compressionPipeline and scaffoldProfile booleans', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-config-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'candidate.yaml');
    await writeFile(file, [
      'name: candidate',
      'harness:',
      '  compressionPipeline: false',
      '  scaffoldProfile: true',
      '',
    ].join('\n'));

    await expect(loadCompareConfig(file)).resolves.toMatchObject({
      name: 'candidate',
      harness: {
        compressionPipeline: false,
        scaffoldProfile: true,
      },
    });
  });
});
