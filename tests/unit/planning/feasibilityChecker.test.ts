import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  FeasibilityChecker,
  createFeasibilityChecker,
  type EnhancedTaskStep,
  type Precondition,
} from '../../../src/host/planning/feasibilityChecker';
import type { TaskPlan, TaskPhase } from '../../../src/host/planning/types';

let workingDirectory: string;

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'feasibility-'));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true });
});

const phase = (steps: string[]): TaskPhase => ({
  id: 'p1',
  title: 'Phase',
  status: 'pending',
  steps: steps.map((content, i) => ({
    id: `s${i}`,
    content,
    status: 'pending',
  })),
});

const plan = (phases: TaskPhase[]): TaskPlan => ({
  id: 'plan1',
  title: 'Plan',
  objective: 'obj',
  phases,
  createdAt: 0,
  updatedAt: 0,
  metadata: { totalSteps: 0, completedSteps: 0, blockedSteps: 0 },
});

const enhancedStep = (preconditions: Precondition[]): EnhancedTaskStep => ({
  id: 's',
  content: 'step',
  status: 'pending',
  preconditions,
  postconditions: [],
  affectedFiles: [],
  requiredTools: [],
});

describe('FeasibilityChecker.checkStep — precondition types', () => {
  it('file_exists passes for an existing file and blocks a missing required one', async () => {
    await fs.writeFile(path.join(workingDirectory, 'present.txt'), 'x');
    const checker = new FeasibilityChecker(workingDirectory);

    const ok = await checker.checkStep(
      enhancedStep([
        { type: 'file_exists', description: '', target: 'present.txt', required: true },
      ])
    );
    expect(ok.feasible).toBe(true);
    expect(ok.score).toBe(100);
    expect(ok.checks[0].message).toContain('文件存在');

    const bad = await checker.checkStep(
      enhancedStep([
        { type: 'file_exists', description: '', target: 'missing.txt', required: true },
      ])
    );
    expect(bad.feasible).toBe(false);
    expect(bad.blockers).toHaveLength(1);
    expect(bad.blockers[0].severity).toBe('blocker');
    expect(bad.suggestions).toContain('创建文件: missing.txt');
  });

  it('file_not_exists is the inverse of file_exists', async () => {
    await fs.writeFile(path.join(workingDirectory, 'here.txt'), 'x');
    const checker = new FeasibilityChecker(workingDirectory);

    const conflict = await checker.checkStep(
      enhancedStep([
        { type: 'file_not_exists', description: '', target: 'here.txt', required: true },
      ])
    );
    expect(conflict.feasible).toBe(false);

    const clear = await checker.checkStep(
      enhancedStep([
        { type: 'file_not_exists', description: '', target: 'absent.txt', required: true },
      ])
    );
    expect(clear.feasible).toBe(true);
  });

  it('directory_exists distinguishes directories from files', async () => {
    await fs.mkdir(path.join(workingDirectory, 'sub'));
    await fs.writeFile(path.join(workingDirectory, 'file.txt'), 'x');
    const checker = new FeasibilityChecker(workingDirectory);

    expect(
      (await checker.checkStep(
        enhancedStep([{ type: 'directory_exists', description: '', target: 'sub', required: true }])
      )).feasible
    ).toBe(true);

    // A file is not a directory.
    expect(
      (await checker.checkStep(
        enhancedStep([
          { type: 'directory_exists', description: '', target: 'file.txt', required: true },
        ])
      )).feasible
    ).toBe(false);
  });

  it('dependency_installed checks node_modules', async () => {
    await fs.mkdir(path.join(workingDirectory, 'node_modules', 'left-pad'), { recursive: true });
    const checker = new FeasibilityChecker(workingDirectory);

    expect(
      (await checker.checkStep(
        enhancedStep([
          { type: 'dependency_installed', description: '', target: 'left-pad', required: true },
        ])
      )).feasible
    ).toBe(true);

    const missing = await checker.checkStep(
      enhancedStep([
        { type: 'dependency_installed', description: '', target: 'no-such-pkg', required: true },
      ])
    );
    expect(missing.feasible).toBe(false);
    expect(missing.suggestions).toContain('安装依赖: npm install no-such-pkg');
  });

  it('env_var_set reads process.env', async () => {
    const checker = new FeasibilityChecker(workingDirectory);
    const varName = 'FEASIBILITY_TEST_VAR';
    const original = process.env[varName]; // preserve any pre-existing value
    try {
      delete process.env[varName];
      expect(
        (await checker.checkStep(
          enhancedStep([{ type: 'env_var_set', description: '', target: varName, required: true }])
        )).feasible
      ).toBe(false);

      process.env[varName] = '1';
      expect(
        (await checker.checkStep(
          enhancedStep([{ type: 'env_var_set', description: '', target: varName, required: true }])
        )).feasible
      ).toBe(true);
    } finally {
      if (original === undefined) delete process.env[varName];
      else process.env[varName] = original;
    }
  });

  it('tool_available checks the configured tool list', async () => {
    const checker = new FeasibilityChecker(workingDirectory, ['rg']);
    expect(
      (await checker.checkStep(
        enhancedStep([{ type: 'tool_available', description: '', target: 'rg', required: true }])
      )).feasible
    ).toBe(true);

    const blocked = await checker.checkStep(
      enhancedStep([{ type: 'tool_available', description: '', target: 'fzf', required: true }])
    );
    expect(blocked.feasible).toBe(false);
    expect(blocked.suggestions).toContain('确保工具可用: fzf');
  });

  it('permission_granted checks write access', async () => {
    await fs.writeFile(path.join(workingDirectory, 'writable.txt'), 'x');
    const checker = new FeasibilityChecker(workingDirectory);
    expect(
      (await checker.checkStep(
        enhancedStep([
          { type: 'permission_granted', description: '', target: 'writable.txt', required: true },
        ])
      )).feasible
    ).toBe(true);
  });

  it('custom preconditions always pass', async () => {
    const checker = new FeasibilityChecker(workingDirectory);
    const res = await checker.checkStep(
      enhancedStep([
        { type: 'custom', description: 'manual check', target: '', required: true },
      ])
    );
    expect(res.feasible).toBe(true);
    expect(res.checks[0].message).toContain('自定义条件');
  });

  it('non-required failures are warnings (not blockers), keeping the plan feasible', async () => {
    const checker = new FeasibilityChecker(workingDirectory);
    const res = await checker.checkStep(
      enhancedStep([
        { type: 'file_exists', description: '', target: 'missing.txt', required: false },
      ])
    );
    expect(res.feasible).toBe(true);
    expect(res.warnings).toHaveLength(1);
    expect(res.score).toBe(0);
  });

  it('empty preconditions yield a perfect score', async () => {
    const checker = new FeasibilityChecker(workingDirectory);
    const res = await checker.checkStep(enhancedStep([]));
    expect(res.score).toBe(100);
    expect(res.feasible).toBe(true);
  });
});

describe('FeasibilityChecker.checkPlan — precondition extraction', () => {
  it('extracts file_exists preconditions from 修改/编辑 step text', async () => {
    await fs.writeFile(path.join(workingDirectory, 'app.ts'), 'x');
    const checker = new FeasibilityChecker(workingDirectory);
    const result = await checker.checkPlan(plan([phase(['修改 `app.ts` 增加日志'])]));

    const fileChecks = result.checks.filter((c) => c.precondition.type === 'file_exists');
    expect(fileChecks.some((c) => c.precondition.target === 'app.ts')).toBe(true);
    expect(result.feasible).toBe(true);
  });

  it('extracts dependency preconditions as non-required warnings', async () => {
    const checker = new FeasibilityChecker(workingDirectory);
    const result = await checker.checkPlan(plan([phase(['安装 `lodash` 然后使用'])]));
    const depChecks = result.checks.filter((c) => c.precondition.type === 'dependency_installed');
    expect(depChecks.length).toBeGreaterThan(0);
    expect(depChecks.every((c) => c.precondition.required === false)).toBe(true);
  });

  it('deduplicates identical preconditions across steps', async () => {
    await fs.writeFile(path.join(workingDirectory, 'shared.ts'), 'x');
    const checker = new FeasibilityChecker(workingDirectory);
    const result = await checker.checkPlan(
      plan([phase(['修改 `shared.ts`', '编辑 `shared.ts` 再次'])])
    );
    const sharedChecks = result.checks.filter(
      (c) => c.precondition.type === 'file_exists' && c.precondition.target === 'shared.ts'
    );
    expect(sharedChecks).toHaveLength(1);
  });

  it('an empty plan is trivially feasible with score 100', async () => {
    const checker = new FeasibilityChecker(workingDirectory);
    const result = await checker.checkPlan(plan([]));
    expect(result.feasible).toBe(true);
    expect(result.score).toBe(100);
    expect(result.checks).toEqual([]);
  });
});

describe('FeasibilityChecker misc', () => {
  it('setAvailableTools updates the tool list used for checks', async () => {
    const checker = new FeasibilityChecker(workingDirectory);
    const before = await checker.checkStep(
      enhancedStep([{ type: 'tool_available', description: '', target: 'jq', required: true }])
    );
    expect(before.feasible).toBe(false);

    checker.setAvailableTools(['jq']);
    const after = await checker.checkStep(
      enhancedStep([{ type: 'tool_available', description: '', target: 'jq', required: true }])
    );
    expect(after.feasible).toBe(true);
  });

  it('createFeasibilityChecker returns a working instance', async () => {
    const checker = createFeasibilityChecker(workingDirectory, ['rg']);
    expect(checker).toBeInstanceOf(FeasibilityChecker);
    const res = await checker.checkStep(
      enhancedStep([{ type: 'tool_available', description: '', target: 'rg', required: true }])
    );
    expect(res.feasible).toBe(true);
  });
});
