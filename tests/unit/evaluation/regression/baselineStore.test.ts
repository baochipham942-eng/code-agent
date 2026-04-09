// ============================================================================
// Regression Baseline Store Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  readBaseline,
  writeBaseline,
} from '../../../../src/main/evaluation/regression/baselineStore';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';

describe('baselineStore', () => {
  it('returns null when baseline file does not exist', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-baseline-'));
    const file = path.join(tmpDir, 'baseline.json');
    const baseline = await readBaseline(file);
    expect(baseline).toBeNull();
    await fs.rm(tmpDir, { recursive: true });
  });

  it('round-trips a baseline', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-baseline-'));
    const file = path.join(tmpDir, 'baseline.json');
    const baseline = {
      passRate: 0.9,
      passed: 9,
      totalCases: 10,
      capturedAt: '2026-04-09T00:00:00Z',
      commit: 'abc123',
    };
    await writeBaseline(file, baseline);
    const loaded = await readBaseline(file);
    expect(loaded).toEqual(baseline);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('throws on corrupt baseline file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-baseline-'));
    const file = path.join(tmpDir, 'baseline.json');
    await fs.writeFile(file, 'not valid json');
    await expect(readBaseline(file)).rejects.toThrow();
    await fs.rm(tmpDir, { recursive: true });
  });
});
