import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/model/quickModel', () => ({
  getQuickModelInfo: () => ({ provider: 'judge-provider', model: 'judge-model' }),
}));

import { buildRunStamp } from '../../../scripts/lib/eval-run-stamp';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('AI review run stamp', () => {
  it('T9：记录请求维集合，并把每维登记记录绑定为相同 sha', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-ai-stamp-'));
    const caseDir = path.join(root, 'cases');
    await mkdir(path.join(root, '.code-agent'), { recursive: true });
    await mkdir(caseDir, { recursive: true });
    const record = { standardVersion: 2, dimension: 'task_completed', pairs: 50, kappa: 0.7 };
    await writeFile(path.join(root, '.code-agent', 'judge-calibration.json'), JSON.stringify({
      'task_completed@judge-provider/judge-model': record,
    }));
    const expected = `sha256:${createHash('sha256').update(stableJson(record)).digest('hex')}`;
    const stamp = buildRunStamp({
      workingDir: root, testCaseDir: caseDir, mode: 'real', provider: 'tested', model: 'tested-model',
      split: 'held-in', judge: 'rules', aiReview: ['task_completed'], estimatedCases: 2,
      shape: { skills: [], memory: false, swarm: false, harness: null },
    });
    expect(stamp.scorers.aiReview).toEqual(['task_completed']);
    expect(stamp.scorers.aiReviewCalibration.task_completed).toBe(expected);
  });
});
