import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configs = [
  'knip.json',
  'knip.production-exports.json',
  'knip.production.json',
  'knip.production-strict.json',
] as const;

describe('knip 扫描范围含 packages/mobile', () => {
  it.each(configs)('%s 的 entry 和 project 都含 packages/mobile', (file) => {
    const config = JSON.parse(readFileSync(file, 'utf8')) as { entry: string[]; project: string[] };
    expect(config.entry.some(pattern => pattern.includes('packages/mobile'))).toBe(true);
    expect(config.project.some(pattern => pattern.includes('packages/mobile'))).toBe(true);
  });
});
