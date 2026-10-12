import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const computePolicyHash = vi.hoisted(() => vi.fn((): string | undefined => 'fixed-policy-hash'));

vi.mock('../../../src/host/permissions/policyHash', () => ({
  computePolicyHash,
}));

import {
  DECISION_TABLE,
  readPolicyDecisionGolden,
  runPolicyDecisionTable,
} from './policyDecisionGolden';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const AUDIT_WRITE_SITES = [
  'src/host/permissions/policyHash.ts',
  'src/host/tools/toolExecutorDecisionTrace.ts',
  'src/host/tools/toolExecutor.ts',
];
const DECISION_MODULES = [
  'src/host/permissions/policyEngine.ts',
  'src/host/permissions/guardFabric.ts',
  'src/host/permissions/modes.ts',
];

function actionsOf(serialized: string): string[] {
  return JSON.parse(serialized).map((row: { output: { action: string } }) => row.output.action);
}

function assertDecisionsUnchanged(actual: string): void {
  const golden = readPolicyDecisionGolden();
  const goldenActions = actionsOf(golden);
  const actualActions = actionsOf(actual);
  expect(actualActions).toEqual(goldenActions);
  for (let index = 0; index < goldenActions.length; index += 1) {
    const action = goldenActions[index];
    if (action === 'deny' || action === 'prompt') {
      expect(actualActions[index]).not.toBe('allow');
    }
  }
  expect(actual).toBe(golden);
  expect(JSON.stringify(JSON.parse(actual))).toBe(JSON.stringify(JSON.parse(golden)));
}

describe('policy decision golden', () => {
  beforeEach(() => {
    computePolicyHash.mockReset();
    computePolicyHash.mockImplementation(() => 'fixed-policy-hash');
  });

  it('evaluate() outputs stay byte-identical to the pre-change golden', () => {
    assertDecisionsUnchanged(runPolicyDecisionTable());
  });

  it('the fixed table covers at least 12 inputs and allow, ask, and deny', () => {
    expect(DECISION_TABLE.length).toBeGreaterThanOrEqual(12);
    const actions = new Set(actionsOf(readPolicyDecisionGolden()));
    expect(actions.has('allow')).toBe(true);
    expect(actions.has('prompt')).toBe(true);
    expect(actions.has('deny')).toBe(true);
  });

  it('decisions stay identical when computePolicyHash throws', () => {
    computePolicyHash.mockImplementation(() => {
      throw new Error('policy hash failed');
    });
    assertDecisionsUnchanged(runPolicyDecisionTable());
  });

  it('decisions stay identical when computePolicyHash changes on every call', () => {
    let n = 0;
    computePolicyHash.mockImplementation(() => `hash-${n++}`);
    assertDecisionsUnchanged(runPolicyDecisionTable());
  });

  it('decisions stay identical when computePolicyHash returns undefined', () => {
    computePolicyHash.mockImplementation(() => undefined);
    assertDecisionsUnchanged(runPolicyDecisionTable());
  });

  it('computePolicyHash is referenced only from audit write sites and tests', () => {
    const output = execFileSync(
      'grep',
      ['-RIn', '--include=*.ts', '--include=*.tsx', '--include=*.mjs', 'computePolicyHash', 'src', 'tests'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const files = new Set(output.trim().split('\n').filter(Boolean).map((line) => line.split(':')[0]));
    for (const site of AUDIT_WRITE_SITES) expect(files.has(site)).toBe(true);
    for (const file of files) {
      if (file.startsWith('tests/')) continue;
      expect(AUDIT_WRITE_SITES).toContain(file);
    }
    for (const forbidden of DECISION_MODULES) expect(files.has(forbidden)).toBe(false);
  });
});
