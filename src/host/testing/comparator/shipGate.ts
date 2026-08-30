import { SIGN_TEST_ALPHA } from './signTest';

export const BASELINE_DENOMINATOR_VERSION = 4;
const SHIP_GATE_MARGIN_PP = 3;
const SHIP_GATE_N_MIN = 30;
const SHIP_GATE_RULE_VERSION = 1;

const ONE_SIDED_95_Z = 1.645;

export type ShipGateState =
  | 'candidate_better'
  | 'non_inferior'
  | 'candidate_worse'
  | 'insufficient';

type HardGateKey = 'false_allow' | 'false_block' | 'approval_bypass';
type HardGateStatus = 'pass' | 'fail' | 'not_measured';

export interface HardGateItem {
  key: HardGateKey;
  status: HardGateStatus;
  count?: number;
  caseIds?: string[];
}

interface ShipGateHardGate {
  passed: boolean;
  items: HardGateItem[];
}

export interface ShipGateCalibre {
  k: number;
  aggregationRuleVersion: number;
  promptVersion: string;
}

export interface ShipGateVerdict {
  state: ShipGateState;
  delta: number;
  nMin: number;
  decisivePairs: number;
  pValue: number;
  passRateDiff: number;
  ciLowerBound: number;
  hardGate: ShipGateHardGate;
  calibre: ShipGateCalibre;
  reasons: string[];
}

export interface DecideShipVerdictInput {
  decisivePairs: number;
  candidateWins: number;
  baselineWins: number;
  ties: number;
  excludedPairs: number;
  pValue: number;
  pairCells: { b: number; c: number; n: number };
  completed: boolean;
  hardGate: ShipGateHardGate;
  calibre: ShipGateCalibre;
}

/**
 * Agresti-Min corrected Wald lower bound for a paired binary difference.
 * The observed difference remains (b-c)/n; the variance uses b+.5, c+.5, n+1.
 */
function pairedPassRateLowerBound(input: {
  candidateOnlyPass: number;
  baselineOnlyPass: number;
  n: number;
}): number {
  const { candidateOnlyPass: b, baselineOnlyPass: c, n } = input;
  if (n <= 0) return 0;
  const correctedB = b + 0.5;
  const correctedC = c + 0.5;
  const correctedN = n + 1;
  const difference = (b - c) / n;
  const varianceNumerator = correctedB + correctedC
    - ((correctedB - correctedC) ** 2) / correctedN;
  const standardError = Math.sqrt(Math.max(0, varianceNumerator)) / correctedN;
  return difference - ONE_SIDED_95_Z * standardError;
}

function shipGateRuleFingerprint(): string {
  return [
    `v=${SHIP_GATE_RULE_VERSION}`,
    `denominator=${BASELINE_DENOMINATOR_VERSION}`,
    `margin=${SHIP_GATE_MARGIN_PP}`,
    `nMin=${SHIP_GATE_N_MIN}`,
    `alpha=${SIGN_TEST_ALPHA}`,
    `z=${ONE_SIDED_95_Z}`,
  ].join(';');
}

const EXPECTED_RULE_FINGERPRINTS: Record<number, string> = {
  1: 'v=1;denominator=4;margin=3;nMin=30;alpha=0.05;z=1.645',
};

export function assertShipGateRuleVersion(): void {
  const expected = EXPECTED_RULE_FINGERPRINTS[SHIP_GATE_RULE_VERSION];
  const actual = shipGateRuleFingerprint();
  if (expected !== actual) {
    throw new Error(
      `[ship-gate-rule] 判据已变但 SHIP_GATE_RULE_VERSION 未正确 bump：${actual}`,
    );
  }
}

export function decideShipVerdict(input: DecideShipVerdictInput): ShipGateVerdict {
  assertShipGateRuleVersion();
  const { b, c, n } = input.pairCells;
  const passRateDiff = n > 0 ? (b - c) / n : 0;
  const ciLowerBound = pairedPassRateLowerBound({
    candidateOnlyPass: b,
    baselineOnlyPass: c,
    n,
  });
  const failingItems = input.hardGate.items.filter((item) => item.status === 'fail');
  const hardGate = {
    passed: failingItems.length === 0,
    items: input.hardGate.items,
  };
  const base = {
    delta: SHIP_GATE_MARGIN_PP,
    nMin: SHIP_GATE_N_MIN,
    decisivePairs: input.decisivePairs,
    pValue: input.pValue,
    passRateDiff,
    ciLowerBound,
    hardGate,
    calibre: input.calibre,
  };

  if (!input.completed) {
    return { ...base, state: 'insufficient', reasons: ['not_completed'] };
  }
  if (failingItems.length > 0) {
    return {
      ...base,
      state: 'candidate_worse',
      reasons: failingItems.map((item) => `hard_gate:${item.key}`),
    };
  }
  if (input.decisivePairs < SHIP_GATE_N_MIN) {
    return { ...base, state: 'insufficient', reasons: ['n_below_min'] };
  }
  if (input.pValue <= SIGN_TEST_ALPHA && input.candidateWins > input.baselineWins) {
    return { ...base, state: 'candidate_better', reasons: ['p_significant_candidate'] };
  }
  if (input.pValue <= SIGN_TEST_ALPHA && input.baselineWins > input.candidateWins) {
    return { ...base, state: 'candidate_worse', reasons: ['p_significant_baseline'] };
  }
  if (ciLowerBound >= -SHIP_GATE_MARGIN_PP / 100) {
    return {
      ...base,
      state: 'non_inferior',
      reasons: [`ci_within_margin:${SHIP_GATE_MARGIN_PP}pp`],
    };
  }
  return { ...base, state: 'candidate_worse', reasons: ['ci_below_margin'] };
}
