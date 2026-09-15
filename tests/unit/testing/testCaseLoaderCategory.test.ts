import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTestSuite } from '../../../src/host/testing/testCaseLoader';

async function writeSuite(category: string | null): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'case-loader-category-'));
  const file = path.join(dir, 'suite.yaml');
  await fs.writeFile(file, [
    'name: category-suite',
    'cases:',
    '  - id: category-case',
    '    type: task',
    ...(category === null ? [] : [`    category: ${category}`]),
    '    prompt: hi',
    '    expect:',
    '      response_contains: [ok]',
    '',
  ].join('\n'));
  return file;
}

describe('test case loader category contract（N-EVAL-CASEBANK-CATEGORY-FILL）', () => {
  it('非契约 category 拒收，报错带文件与题 id', async () => {
    const file = await writeSuite('formula');
    await expect(loadTestSuite(file)).rejects.toThrow(
      new RegExp(`category-case.*formula.*${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('契约四值与未填照常加载', async () => {
    for (const category of ['basic_tool', 'task_completion', 'error_recovery', 'edge_case', null]) {
      const suite = await loadTestSuite(await writeSuite(category));
      expect(suite.cases[0].category).toBe(category ?? undefined);
    }
  });

  it('真题库全部 category 在契约内（防回流）', async () => {
    const root = path.resolve(__dirname, '../../../.claude/test-cases');
    const dirs = ['', 'artifact-runnable', 'goal-contract', 'memory', 'user-simulator'];
    let loaded = 0;
    for (const dir of dirs) {
      for (const name of await fs.readdir(path.join(root, dir))) {
        if (!name.endsWith('.yaml')) continue;
        const suite = await loadTestSuite(path.join(root, dir, name), { requireHardened: false });
        loaded += suite.cases.length;
      }
    }
    expect(loaded).toBeGreaterThan(0);
  });
});
