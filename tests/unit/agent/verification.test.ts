import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const mockRunVerifyGate = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/agent/goalVerifyGate', () => ({
  runVerifyGate: (...args: unknown[]) => mockRunVerifyGate(...args),
}));

import {
  buildVerificationPlan,
  classifyVerificationFailure,
  runVerificationPlan,
} from '../../../src/main/agent/verification';

function writeRepoFile(root: string, file: string, content = ''): void {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content || '// test\n', 'utf-8');
}

describe('verification plan and runner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'verification-plan-'));
    writeRepoFile(root, 'package.json', JSON.stringify({
      scripts: {
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
      },
    }));
    mockRunVerifyGate.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds a goal verify command plus related test selector evidence', () => {
    writeRepoFile(root, 'tests/unit/agent/runtime/goalCompletionGate.test.ts');

    const plan = buildVerificationPlan({
      cwd: root,
      goal: 'verify runtime goal completion',
      verifyCommand: 'npm run typecheck',
      changedFiles: ['src/main/agent/runtime/goalCompletionGate.ts'],
    });

    expect(plan.required).toMatchObject([{
      id: 'goal-contract:verifyCommand',
      command: 'npm run typecheck',
      required: true,
    }]);
    expect(plan.optional.some((command) =>
      command.id === 'related-tests:v0'
      && command.command.includes('tests/unit/agent/runtime/goalCompletionGate.test.ts'),
    )).toBe(true);
    expect(plan.optional.some((command) => command.id === 'package-script:typecheck')).toBe(false);
  });

  it('writes readable skippedChecks when no related test selector exists', () => {
    const plan = buildVerificationPlan({
      cwd: root,
      changedFiles: ['src/unknown/runtime.ts'],
      packageScripts: ['test'],
    });

    expect(plan.skippedChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'goal-contract:verifyCommand',
          reason: expect.stringContaining('no verifyCommand'),
        }),
        expect.objectContaining({
          id: 'targeted-test:src/unknown/runtime.ts',
          reason: expect.stringContaining('No related-test selector rule'),
        }),
      ]),
    );
  });

  it('runs the verification command and emits EvidenceRef-backed command results', async () => {
    mockRunVerifyGate.mockResolvedValue({
      pass: true,
      exitCode: 0,
      output: 'ok',
      timedOut: false,
      command: 'npx vitest run tests/unit/foo.test.ts',
      cwd: root,
      durationMs: 42,
      stdoutTail: 'ok',
      stderrTail: '',
    });
    const plan = buildVerificationPlan({
      cwd: root,
      verifyCommand: 'npx vitest run tests/unit/foo.test.ts',
      changedFiles: [],
      packageScripts: [],
    });

    const evidence = await runVerificationPlan(plan);

    expect(evidence.status).toBe('passed');
    expect(evidence.commandResults[0]).toMatchObject({
      command: 'npx vitest run tests/unit/foo.test.ts',
      durationMs: 42,
      stdoutTail: 'ok',
    });
    expect(evidence.evidenceRefs[0]).toMatchObject({
      kind: 'test',
      source: 'VerificationRunner',
      redactionStatus: 'clean',
    });
  });

  it('classifies local verification failures without replacing full output', () => {
    expect(classifyVerificationFailure('npm run typecheck', 'TS2322', false)).toBe('typecheck');
    expect(classifyVerificationFailure('npx vitest run foo.test.ts', 'Cannot find package vitest', false)).toBe('dependency_missing');
    expect(classifyVerificationFailure('npm test', 'waiting', true)).toBe('timeout');
  });
});
