import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  exportInspectDataset,
  inspectTextCaseRejection,
} from '../../../scripts/inspect/export-cases';
import type { TestCase } from '../../../src/host/testing/types';

describe('YAML to Inspect Dataset exporter', () => {
  const roots: string[] = [];

  afterEach(async () => {
    delete process.env.NEO_EVAL_ANSWERS_DIR;
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('exports the fixed five cases in manifest order with original assertions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inspect-answer-side-'));
    roots.push(root);
    const caseDir = path.join(root, '.claude', 'test-cases');
    const source = '.claude/test-cases/inspect.yaml';
    const answerRoot = path.join(root, 'private-eval');
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.mkdir(caseDir, { recursive: true });
    await fs.mkdir(path.join(answerRoot, 'answers', '.claude', 'test-cases'), { recursive: true });
    process.env.NEO_EVAL_ANSWERS_DIR = answerRoot;
    const ids = [
      'bash-ls',
      'bash-pwd',
      'conv-understand-intent',
      'error-file-not-found',
      'prompt-smoke-read-package',
    ];
    await fs.writeFile(path.join(caseDir, 'inspect.yaml'), [
      'name: inspect',
      'cases:',
      ...ids.flatMap((id) => [
        `  - id: ${id}`,
        '    type: task',
        `    prompt: ${id}`,
      ]),
      '',
    ].join('\n'));
    await fs.writeFile(path.join(answerRoot, 'answers', ...source.split('/')), [
      'version: 1',
      `source: ${source}`,
      'cases:',
      '  - id: bash-ls',
      '    expectations:',
      '      - type: tool_called',
      '        params: { tool: bash }',
      '  - id: bash-pwd',
      '    expect: { response_contains: [pwd] }',
      '  - id: conv-understand-intent',
      '    expect: { response_contains: [intent] }',
      '  - id: error-file-not-found',
      '    expect: { error_handled: true }',
      '  - id: prompt-smoke-read-package',
      '    expect: { response_contains: [package.json] }',
      '',
    ].join('\n'));
    const records = await exportInspectDataset({
      caseDir,
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
