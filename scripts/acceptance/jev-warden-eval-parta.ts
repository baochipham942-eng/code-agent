// Part A: replay fixture sequences through createJevWarden, flag on (real systemOne) vs off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJevWarden, type JevWarden } from '../../src/host/agent/runtime/jevWarden';
import { systemOne } from '../../src/host/model/providers/typesafeProvider';
import { estimateJevCallUsd, JEV_MODEL } from '../../src/shared/constants/jevQuestions';
import {
  PART_A_BUDGET_USD,
  addArm,
  emptyArm,
  loadReplay,
  readGitHead,
  recommendationFor,
  roundUsd,
  walkGuard,
  writeWardenDocument,
  type ArmAStats,
  type ReplaySequence,
  type WardenDocument,
} from './jev-warden-eval-metrics';

interface CallCounter {
  calls: number;
  errors: number;
  usd: number;
  budgetExceeded: boolean;
}

function keyPresence(name: string): string {
  const value = process.env[name];
  return `${name}=${value && value.trim() ? 'set' : 'unset'}`;
}

function resolveTypesafeKey(): string | null {
  const current = process.env.TYPESAFE_API_KEY;
  if (current === undefined) {
    const file = path.join(os.homedir(), '.config/typesafe/api_key');
    if (!fs.existsSync(file)) return 'part A refused: TYPESAFE_API_KEY is unset and the key file is missing';
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!value) return 'part A refused: TYPESAFE_API_KEY is unset and the key file is empty';
    process.env.TYPESAFE_API_KEY = value;
    return null;
  }
  if (current.trim() === '') return 'part A refused: TYPESAFE_API_KEY is empty; not reading the key file';
  return null;
}

function envFor(on: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (on) env.CODE_AGENT_JEV_WARDEN = '1';
  else delete env.CODE_AGENT_JEV_WARDEN;
  return env;
}

function answerIsWellFormed(answers: unknown, keys: readonly string[]): boolean {
  if (!answers || typeof answers !== 'object') return false;
  const record = answers as Record<string, unknown>;
  return keys.every((key) => {
    const answer = record[key];
    if (!answer || typeof answer !== 'object') return false;
    const noul = (answer as { noul?: unknown }).noul;
    return typeof noul === 'number' && Number.isFinite(noul) && noul >= 0 && noul <= 1;
  });
}

function noteVerdict(arm: ArmAStats, verdict: Awaited<ReturnType<JevWarden['reviewToolStep']>>): void {
  if (verdict.kind === 'none') return;
  const label = `${verdict.kind}:${verdict.rule}`;
  arm.steers[label] = (arm.steers[label] ?? 0) + 1;
}

async function replayOne(
  sequence: ReplaySequence,
  on: boolean,
  spent: CallCounter,
): Promise<ArmAStats> {
  const local: CallCounter = { calls: 0, errors: 0, usd: 0, budgetExceeded: false };
  const warden = createJevWarden({
    env: envFor(on),
    approvalLookup: () => undefined,
    systemOne: async (state, questions, options) => {
      const estimate = estimateJevCallUsd(JSON.stringify(state).length, JSON.stringify(questions).length);
      if (spent.usd + local.usd + estimate > PART_A_BUDGET_USD) {
        spent.budgetExceeded = true;
        local.budgetExceeded = true;
        throw new Error('PART_A_BUDGET');
      }
      try {
        const answers = await systemOne(state, questions, options);
        local.calls += 1;
        local.usd = roundUsd(local.usd + estimate);
        if (!answerIsWellFormed(answers, Object.keys(questions))) local.errors += 1;
        return answers;
      } catch (error) {
        if (local.budgetExceeded) throw error;
        local.calls += 1;
        local.errors += 1;
        local.usd = roundUsd(local.usd + estimate);
        throw error;
      }
    },
  });
  const arm = emptyArm();
  for (const step of walkGuard(sequence)) {
    const verdict = await warden.reviewToolStep({
      guardLevel: step.guardLevel,
      guardSignals: step.guardSignals,
      stepResults: step.stepResults,
      assistantText: step.assistantText,
    });
    noteVerdict(arm, verdict);
    if (spent.budgetExceeded) break;
  }
  if (warden.interceptFinal(false)) {
    arm.steers['intercept:fake_done'] = (arm.steers['intercept:fake_done'] ?? 0) + 1;
  }
  const steerTotal = Object.values(arm.steers).reduce((sum, count) => sum + count, 0);
  if (sequence.kind === 'control') arm.falseSteer = steerTotal > 0 ? 1 : 0;
  else arm.letThrough = steerTotal === 0 ? 1 : 0;
  arm.jevCalls = local.calls;
  arm.jevErrors = local.errors;
  arm.usd = local.usd;
  spent.calls += local.calls;
  spent.errors += local.errors;
  spent.usd = roundUsd(spent.usd + local.usd);
  return arm;
}

function steerText(arm: ArmAStats): string {
  const parts = Object.entries(arm.steers).filter(([, count]) => count > 0).map(([label, count]) => `${label}=${count}`);
  return parts.length > 0 ? parts.join(',') : '-';
}

function printRow(id: string, kind: string, on: ArmAStats, off: ArmAStats): void {
  console.log([
    id,
    kind,
    `offLet=${off.letThrough}`,
    `offCalls=${off.jevCalls}`,
    `onLet=${on.letThrough}`,
    `onFalse=${on.falseSteer}`,
    `onCalls=${on.jevCalls}`,
    `onErrors=${on.jevErrors}`,
    `onUsd=${on.usd}`,
    `steers=${steerText(on)}`,
  ].join(' '));
}

export async function runPartA(): Promise<void> {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[name];
  }
  console.log(keyPresence('TYPESAFE_API_KEY'));
  console.log(keyPresence('DEEPSEEK_API_KEY'));
  console.log(keyPresence('STEPFUN_API_KEY'));
  console.log(keyPresence('MOONSHOT_API_KEY'));
  console.log(keyPresence('LONGCAT_API_KEY'));
  if (JEV_MODEL !== 'jev-1.13.0') {
    console.error(`part A fail-loud: JEV_MODEL is ${JEV_MODEL}, expected jev-1.13.0`);
    process.exit(1);
  }
  const keyError = resolveTypesafeKey();
  console.log(keyPresence('TYPESAFE_API_KEY'));
  if (keyError) {
    console.error(keyError);
    process.exit(1);
  }
  const gitHead = readGitHead();
  console.log(`gitHead=${gitHead}`);
  console.log(`JEV_MODEL=${JEV_MODEL}`);
  const sequences = loadReplay();
  const spent: CallCounter = { calls: 0, errors: 0, usd: 0, budgetExceeded: false };
  const rows: WardenDocument['partA']['sequences'] = [];
  for (const sequence of sequences) {
    const off = await replayOne(sequence, false, spent);
    const on = await replayOne(sequence, true, spent);
    rows.push({ id: sequence.id, kind: sequence.kind, on, off });
    printRow(sequence.id, sequence.kind, on, off);
    if (spent.budgetExceeded) break;
  }
  const totals = { on: emptyArm(), off: emptyArm() };
  for (const row of rows) {
    addArm(totals.on, row.on);
    addArm(totals.off, row.off);
  }
  console.log('TOTAL');
  printRow('TOTAL', 'all', totals.on, totals.off);
  if (spent.budgetExceeded) {
    console.error(`part A aborted: estimated Jev spend would exceed $${PART_A_BUDGET_USD}; no JSON written`);
    process.exit(1);
  }
  if (spent.calls > 0 && spent.errors / spent.calls > 0.1) {
    console.error(`part A fail-loud: Jev errors ${spent.errors}/${spent.calls} > 10%; no JSON written`);
    process.exit(1);
  }
  const doc: WardenDocument = {
    gitHead,
    JEV_MODEL,
    baseline: null,
    partA: { sequences: rows, totals },
    partB: { complete: false, cases: [] },
    recommendation: '',
  };
  doc.recommendation = recommendationFor(doc);
  writeWardenDocument(doc);
  console.log(`wrote ${path.relative(process.cwd(), path.join(process.cwd(), 'docs/research/assets/2026-09-30-jev-eval/warden.json'))}`);
  console.log(`recommendation: ${doc.recommendation}`);
  console.log(`part A jevCalls=${spent.calls} jevErrors=${spent.errors} usd=${spent.usd}`);
}
