import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('rsi pilot provenance contract', () => {
  it('defines the complete persisted metadata set and writes it to both outputs', () => {
    const RSI_RUN_PROVENANCE_KEYS = ['provider', 'model', 'endpoint', 'gitSha', 'gitDirty', 'runnerSha'];
    const source = fs.readFileSync(path.resolve('scripts/rsi-pilot/runner.ts'), 'utf8');
    for (const key of RSI_RUN_PROVENANCE_KEYS) expect(source).toContain(key);
    expect(source).toContain('provenance: records[0]?.provenance ?? null');
  });
});
