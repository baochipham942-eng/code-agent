import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exportInspectDataset,
  inspectTextCaseRejection,
} from '../../../scripts/inspect/export-cases';
import type { TestCase } from '../../../src/host/testing/types';

describe('YAML to Inspect Dataset exporter', () => {
  it('exports the fixed five cases in manifest order with original assertions', async () => {
    const ids = [
      'bash-ls',
      'bash-pwd',
      'conv-understand-intent',
      'error-file-not-found',
      'prompt-smoke-read-package',
    ];
    const records = await exportInspectDataset({
      caseDir: path.resolve('.claude/test-cases'),
      ids,
    });

    expect(records.map((record) => record.id)).toEqual(ids);
    expect(records[0].metadata.case.expectations?.map((item) => item.type)).toContain('tool_called');
    expect(records[3].metadata.case.expect.error_handled).toBe(true);
  });

  it('rejects cases that need mutable filesystem fixtures', () => {
    const testCase: TestCase = {
      id: 'write-case',
      type: 'task',
      description: 'write',
      prompt: 'write a file',
      expect: { files_created: ['out.txt'] },
    };

    expect(inspectTextCaseRejection(testCase)).toBe('has filesystem assertions');
  });
});
