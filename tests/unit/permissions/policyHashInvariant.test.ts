import { describe, expect, it } from 'vitest';

import {
  DECISION_TABLE,
  readPolicyDecisionGolden,
  runPolicyDecisionTable,
} from './policyDecisionGolden';

function actionsOf(serialized: string): string[] {
  return JSON.parse(serialized).map((row: { output: { action: string } }) => row.output.action);
}

describe('policy decision golden', () => {
  it('evaluate() outputs stay byte-identical to the pre-change golden', () => {
    const actual = runPolicyDecisionTable();
    const golden = readPolicyDecisionGolden();
    expect(actual).toBe(golden);
    expect(JSON.stringify(JSON.parse(actual))).toBe(JSON.stringify(JSON.parse(golden)));
  });

  it('the fixed table covers at least 12 inputs and allow, ask, and deny', () => {
    expect(DECISION_TABLE.length).toBeGreaterThanOrEqual(12);
    const actions = new Set(actionsOf(readPolicyDecisionGolden()));
    expect(actions.has('allow')).toBe(true);
    expect(actions.has('prompt')).toBe(true);
    expect(actions.has('deny')).toBe(true);
  });
});
