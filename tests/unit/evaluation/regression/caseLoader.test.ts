// ============================================================================
// Regression Case Loader Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { loadCase, loadAllCases } from '../../../../src/main/evaluation/regression/caseLoader';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';

describe('caseLoader', () => {
  it('parses a well-formed case file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-test-'));
    const file = path.join(tmpDir, 'reg-sample.md');
    await fs.writeFile(
      file,
      `---
id: reg-sample
source: test
tags: [foo, bar]
related_rules: [L2-001]
eval_command: "true"
---

## 场景
Sample scenario description

## 预期行为
Expected behavior description
`,
    );

    const loaded = await loadCase(file);
    expect(loaded.id).toBe('reg-sample');
    expect(loaded.tags).toEqual(['foo', 'bar']);
    expect(loaded.relatedRules).toEqual(['L2-001']);
    expect(loaded.evalCommand).toBe('true');
    expect(loaded.scenario).toContain('Sample scenario');
    expect(loaded.expectedBehavior).toContain('Expected behavior');

    await fs.rm(tmpDir, { recursive: true });
  });

  it('throws on missing eval_command', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-test-'));
    const file = path.join(tmpDir, 'reg-bad.md');
    await fs.writeFile(
      file,
      `---
id: reg-bad
source: test
tags: []
---
## 场景
x
`,
    );
    await expect(loadCase(file)).rejects.toThrow(/eval_command/);
    await fs.rm(tmpDir, { recursive: true });
  });

  it('loads all cases from a directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-test-'));
    for (const id of ['reg-001', 'reg-002']) {
      await fs.writeFile(
        path.join(tmpDir, `${id}.md`),
        `---
id: ${id}
source: test
tags: []
eval_command: "true"
---
## 场景
x
## 预期行为
y
`,
      );
    }
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# readme');

    const cases = await loadAllCases(tmpDir);
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.id).sort()).toEqual(['reg-001', 'reg-002']);
    await fs.rm(tmpDir, { recursive: true });
  });
});
