import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { makeEvidenceRef, type EvidenceKind, type EvidenceRef } from '../../shared/contract/evidence';
import { ChangeDetector } from '../testing/ci/changeDetector';
import { runVerifyGate } from './goalVerifyGate';

export type VerificationStatus = 'passed' | 'failed' | 'not_run';

export type VerificationFailureType =
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'env_missing'
  | 'dependency_missing'
  | 'timeout'
  | 'unverifiable';

export type VerificationCommandKind =
  | 'goal_contract'
  | 'targeted_test'
  | 'package_script';

export interface VerificationCommandSpec {
  id: string;
  command: string;
  cwd: string;
  required: boolean;
  kind: VerificationCommandKind;
  reason: string;
  source: string;
  timeoutMs?: number;
}

export interface VerificationSkippedCheck {
  id: string;
  kind: 'targeted_test' | 'package_script' | 'goal_contract';
  reason: string;
  files?: string[];
}

export interface VerificationPlan {
  cwd: string;
  goal: string;
  verifyCommand?: string;
  reviewCondition?: string;
  changedFiles: string[];
  packageScripts: string[];
  required: VerificationCommandSpec[];
  optional: VerificationCommandSpec[];
  skippedChecks: VerificationSkippedCheck[];
}

export interface BuildVerificationPlanInput {
  cwd: string;
  goal?: string;
  verifyCommand?: string;
  reviewCondition?: string;
  changedFiles?: string[];
  packageScripts?: string[];
}

export interface VerificationCommandResult {
  id: string;
  command: string;
  cwd: string;
  required: boolean;
  kind: VerificationCommandKind;
  reason: string;
  pass: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  output: string;
  evidenceRef: EvidenceRef;
}

export interface VerificationEvidence {
  status: VerificationStatus;
  failureType?: VerificationFailureType;
  summary: string;
  plan: VerificationPlan;
  commandResults: VerificationCommandResult[];
  skippedChecks: VerificationSkippedCheck[];
  evidenceRefs: EvidenceRef[];
}

export interface RunVerificationPlanOptions {
  includeOptional?: boolean;
}

const TEST_SCRIPT_NAMES = new Set(['test', 'test:all']);

function readPackageScripts(cwd: string): string[] {
  try {
    const raw = readFileSync(join(cwd, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return Object.keys(parsed.scripts || {}).sort();
  } catch {
    return [];
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeCommand(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function hasAnyScript(packageScripts: string[], names: Iterable<string>): boolean {
  const scripts = new Set(packageScripts);
  for (const name of names) {
    if (scripts.has(name)) return true;
  }
  return false;
}

function addExistingCandidate(
  cwd: string,
  file: string,
  candidates: Set<string>,
  checked: string[],
): void {
  checked.push(file);
  if (existsSync(join(cwd, file))) {
    candidates.add(file);
  }
}

function candidateTestsForFile(file: string): string[] {
  const basename = file.split('/').pop()?.replace(/\.(tsx?|jsx?)$/, '') || '';
  if (!basename) return [];

  if (/\.test\.(ts|tsx)$/.test(file) && file.startsWith('tests/')) {
    return [file];
  }

  if (file === 'src/shared/utils/browserComputerRedaction.ts') {
    return [
      'tests/unit/shared/browserComputerRedaction.largeText.test.ts',
      'tests/unit/agent/messageHistory.browserComputerRedaction.test.ts',
      'tests/unit/session/exportMarkdown.browserComputer.test.ts',
    ];
  }

  if (file === 'src/shared/contract/evidence.ts') {
    return ['tests/unit/shared/contract/evidence.test.ts'];
  }

  if (file === 'src/main/agent/verification.ts') {
    return ['tests/unit/agent/verification.test.ts'];
  }

  if (file.startsWith('src/main/agent/runtime/')) {
    return [
      `tests/unit/agent/runtime/${basename}.test.ts`,
      `tests/unit/agent/${basename}.test.ts`,
    ];
  }

  if (file.startsWith('src/main/agent/')) {
    return [`tests/unit/agent/${basename}.test.ts`];
  }

  if (file.startsWith('src/main/testing/ci/')) {
    return [`tests/unit/testing/${basename}.test.ts`];
  }

  if (file.startsWith('src/main/tools/vision/')) {
    return [
      `tests/unit/tools/vision/${basename}.test.ts`,
      `tests/unit/tools/modules/vision/${basename}.test.ts`,
    ];
  }

  if (
    file.startsWith('src/main/plugins/builtin/browserControl/')
    || file.startsWith('src/main/plugins/builtin/computerUse/')
  ) {
    return [`tests/unit/tools/modules/vision/${basename}.test.ts`];
  }

  return [];
}

export function selectRelatedTests(
  changedFiles: string[],
  cwd: string,
): { testFiles: string[]; skippedChecks: VerificationSkippedCheck[] } {
  const testFiles = new Set<string>();
  const skippedChecks: VerificationSkippedCheck[] = [];

  for (const file of changedFiles) {
    const candidates = candidateTestsForFile(file);
    if (candidates.length === 0) {
      skippedChecks.push({
        id: `targeted-test:${file}`,
        kind: 'targeted_test',
        reason: `No related-test selector rule for ${file}.`,
        files: [file],
      });
      continue;
    }

    const checked: string[] = [];
    for (const candidate of candidates) {
      addExistingCandidate(cwd, candidate, testFiles, checked);
    }
    if (!checked.some((candidate) => testFiles.has(candidate))) {
      skippedChecks.push({
        id: `targeted-test:${file}`,
        kind: 'targeted_test',
        reason: `Related-test selector checked ${checked.join(', ')} but no file exists.`,
        files: [file],
      });
    }
  }

  return {
    testFiles: [...testFiles].sort(),
    skippedChecks,
  };
}

export function buildVerificationPlan(input: BuildVerificationPlanInput): VerificationPlan {
  const cwd = input.cwd;
  const verifyCommand = normalizeCommand(input.verifyCommand);
  const packageScripts = input.packageScripts ?? readPackageScripts(cwd);
  const changedFiles = input.changedFiles ?? new ChangeDetector(cwd).getChangedFilesForVerification();
  const required: VerificationCommandSpec[] = [];
  const optional: VerificationCommandSpec[] = [];
  const skippedChecks: VerificationSkippedCheck[] = [];

  if (verifyCommand) {
    required.push({
      id: 'goal-contract:verifyCommand',
      command: verifyCommand,
      cwd,
      required: true,
      kind: 'goal_contract',
      reason: 'Goal contract verifyCommand.',
      source: 'goal_contract',
    });
  } else {
    skippedChecks.push({
      id: 'goal-contract:verifyCommand',
      kind: 'goal_contract',
      reason: 'Goal contract has no verifyCommand; verification status remains not_run unless another check is executed.',
    });
  }

  const selector = selectRelatedTests(changedFiles, cwd);
  skippedChecks.push(...selector.skippedChecks);
  if (selector.testFiles.length > 0 && hasAnyScript(packageScripts, TEST_SCRIPT_NAMES)) {
    optional.push({
      id: 'related-tests:v0',
      command: `npx vitest run ${selector.testFiles.map(shellQuote).join(' ')}`,
      cwd,
      required: false,
      kind: 'targeted_test',
      reason: `Related test selector v0 matched ${selector.testFiles.length} test file(s).`,
      source: 'git_diff_name_only',
    });
  } else if (changedFiles.length > 0 && selector.testFiles.length > 0) {
    skippedChecks.push({
      id: 'related-tests:v0',
      kind: 'targeted_test',
      reason: 'Related tests were found, but package.json has no test script.',
      files: selector.testFiles,
    });
  }

  if (packageScripts.includes('typecheck') && (!verifyCommand || !/\btypecheck\b|\btsc\b/.test(verifyCommand))) {
    optional.push({
      id: 'package-script:typecheck',
      command: 'npm run typecheck',
      cwd,
      required: false,
      kind: 'package_script',
      reason: 'package.json exposes typecheck and the goal verifyCommand does not already include it.',
      source: 'package_json_scripts',
    });
  }

  return {
    cwd,
    goal: input.goal || '',
    verifyCommand,
    reviewCondition: normalizeCommand(input.reviewCondition),
    changedFiles,
    packageScripts,
    required,
    optional,
    skippedChecks,
  };
}

function commandKind(command: string): EvidenceKind {
  if (/\b(vitest|jest|pytest|cargo test|go test|npm test|npm run test|pnpm test|yarn test)\b/.test(command)) {
    return 'test';
  }
  if (/\b(tsc|typecheck)\b/.test(command)) return 'typecheck';
  if (/\b(build|vite build|webpack|rollup)\b/.test(command)) return 'build';
  return 'tool';
}

export function classifyVerificationFailure(command: string, output: string, timedOut: boolean): VerificationFailureType {
  const text = `${command}\n${output}`.toLowerCase();
  if (timedOut) return 'timeout';
  if (/missing.*(env|environment)|env.*missing|required.*(api key|token)|api key.*(missing|required|not configured)|not configured/.test(text)) {
    return 'env_missing';
  }
  if (/cannot find (module|package)|module_not_found|command not found|not found:|no such file or directory|node_modules|playwright.*install/.test(text)) {
    return 'dependency_missing';
  }
  if (/\b(tsc|typecheck)\b/.test(text)) return 'typecheck';
  if (/\b(eslint|lint)\b/.test(text)) return 'lint';
  if (/\b(vitest|jest|pytest|cargo test|go test|npm test|pnpm test|yarn test|test failed)\b/.test(text)) return 'test';
  if (/\b(build|vite build|webpack|rollup)\b/.test(text)) return 'build';
  return 'unverifiable';
}

function summarizeVerificationFailure(result: VerificationCommandResult | undefined, failureType: VerificationFailureType | undefined): string {
  if (!result) return 'Verification failed without a command result.';
  const exit = result.exitCode === null ? 'null' : String(result.exitCode);
  return `${failureType || 'unverifiable'}: ${result.command} exited ${exit}${result.timedOut ? ' after timeout' : ''}.`;
}

function notRunEvidenceRef(skippedCheck: VerificationSkippedCheck): EvidenceRef {
  return makeEvidenceRef({
    kind: 'tool',
    ref: `verification:not_run:${skippedCheck.id}`,
    source: 'VerificationPlan',
    state: 'not_run',
    redactionStatus: 'clean',
    capturedAtMs: Date.now(),
  });
}

export function buildNotRunVerificationEvidence(plan: VerificationPlan): VerificationEvidence {
  const evidenceRefs = plan.skippedChecks.map((skipped) => notRunEvidenceRef(skipped));
  return {
    status: 'not_run',
    summary: 'No verification command was executed.',
    plan,
    commandResults: [],
    skippedChecks: plan.skippedChecks,
    evidenceRefs,
  };
}

export async function runVerificationPlan(
  plan: VerificationPlan,
  options: RunVerificationPlanOptions = {},
): Promise<VerificationEvidence> {
  const commands = [
    ...plan.required,
    ...(options.includeOptional ? plan.optional : []),
  ];

  if (commands.length === 0) {
    return buildNotRunVerificationEvidence(plan);
  }

  const commandResults: VerificationCommandResult[] = [];
  const evidenceRefs: EvidenceRef[] = [];

  for (const spec of commands) {
    const gate = await runVerifyGate(spec.command, spec.cwd, spec.timeoutMs);
    const evidenceRef = makeEvidenceRef({
      kind: commandKind(spec.command),
      ref: `${spec.cwd}$ ${spec.command}`,
      source: 'VerificationRunner',
      state: 'fresh',
      redactionStatus: 'clean',
      capturedAtMs: Date.now(),
    });
    evidenceRefs.push(evidenceRef);
    commandResults.push({
      id: spec.id,
      command: spec.command,
      cwd: spec.cwd,
      required: spec.required,
      kind: spec.kind,
      reason: spec.reason,
      pass: gate.pass,
      exitCode: gate.exitCode,
      durationMs: gate.durationMs,
      timedOut: gate.timedOut,
      stdoutTail: gate.stdoutTail,
      stderrTail: gate.stderrTail,
      output: gate.output,
      evidenceRef,
    });
  }

  const failed = commandResults.find((result) => !result.pass);
  const failureType = failed
    ? classifyVerificationFailure(failed.command, `${failed.output}\n${failed.stdoutTail}\n${failed.stderrTail}`, failed.timedOut)
    : undefined;

  return {
    status: failed ? 'failed' : 'passed',
    failureType,
    summary: failed
      ? summarizeVerificationFailure(failed, failureType)
      : `Verification passed (${commandResults.length} command${commandResults.length === 1 ? '' : 's'}).`,
    plan,
    commandResults,
    skippedChecks: plan.skippedChecks,
    evidenceRefs,
  };
}
