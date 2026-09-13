import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configs = [
  'knip.json',
  'knip.production-exports.json',
  'knip.production.json',
  'knip.production-strict.json',
] as const;

describe('knip 扫描范围含 packages/mobile', () => {
  it.each(configs)('%s 的入口是 main.tsx、project 含 src', (file) => {
    const config = JSON.parse(readFileSync(file, 'utf8')) as { entry: string[]; project: string[] };
    expect(config.entry).toContain('packages/mobile/src/main.tsx');
    expect(config.project).toContain('packages/mobile/src/**/*.{ts,tsx}');
  });
});
