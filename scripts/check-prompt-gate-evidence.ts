#!/usr/bin/env npx tsx

import fs from 'node:fs';
import path from 'node:path';

import { RELEASE_EVIDENCE_PRODUCERS } from './lib/releaseEvidenceRegistry.ts';
import {
  assertAncestor,
  changedFiles,
  isPromptInputPath,
  loadPromptChangePaths,
  resolvePromptVersion,
} from './lib/promptGateScope.ts';

const PROMPT_EVIDENCE = (() => {
  const entry = RELEASE_EVIDENCE_PRODUCERS.find((candidate) => candidate.shape === 'prompt-gate');
  if (!entry) throw new Error('prompt-gate evidence producer is not registered');
  return entry;
})();

const REPAIR = `跑 npm run eval:prompt-gate 后提交 ${PROMPT_EVIDENCE.evidence}`;
const STEP_NAMES = ['staleScan', 'replayEval', 'realSmoke'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateEvidenceShape(value: unknown, errors: string[]): value is Record<string, unknown> {
  if (!isObject(value)) {
    errors.push('evidence root must be an object');
    return false;
  }
  const allowed = ['schemaVersion', 'generatedAt', 'gitHead', 'promptVersion', 'passed', 'steps'];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) errors.push(`evidence has unknown field(s): ${unknown.join(', ')}`);
  if (value.schemaVersion !== 1) errors.push('evidence has unknown schemaVersion');
  if (value.passed !== true) errors.push('evidence passed must be true');
  if (typeof value.generatedAt !== 'string' || Number.isNaN(new Date(value.generatedAt).valueOf())) {
    errors.push('evidence generatedAt is missing or invalid');
  }
  if (!isObject(value.steps)) {
    errors.push('evidence steps are missing');
    return true;
  }
  const unknownSteps = Object.keys(value.steps).filter((key) => !STEP_NAMES.includes(key as typeof STEP_NAMES[number]));
  if (unknownSteps.length > 0) errors.push(`evidence steps have unknown field(s): ${unknownSteps.join(', ')}`);
  for (const name of STEP_NAMES) {
    const step = value.steps[name];
    if (!isObject(step) || step.passed !== true || !Number.isInteger(step.count) || Number(step.count) < 0) {
      errors.push(`evidence step ${name} must have passed=true and a non-negative integer count`);
    }
  }
  return true;
}

export function checkPromptGateEvidence(root: string): string[] {
  const errors: string[] = [];
  const evidencePath = path.join(root, PROMPT_EVIDENCE.evidence);
  if (!fs.existsSync(evidencePath)) return [`missing evidence file: ${PROMPT_EVIDENCE.evidence}`];

  let evidence: unknown;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as unknown;
  } catch {
    return [`invalid JSON in evidence file: ${PROMPT_EVIDENCE.evidence}`];
  }
  if (!validateEvidenceShape(evidence, errors) || !isObject(evidence)) return errors;

  let scope: ReturnType<typeof loadPromptChangePaths>;
  try {
    scope = loadPromptChangePaths(root);
    const currentVersion = resolvePromptVersion(root, scope.versionFile);
    if (evidence.promptVersion !== currentVersion) {
      errors.push(`promptVersion mismatch: evidence=${String(evidence.promptVersion)} current=${currentVersion}`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'cannot read prompt change scope');
    return errors;
  }

  const gitHead = typeof evidence.gitHead === 'string' ? evidence.gitHead : '';
  if (!/^[0-9a-f]{40}$/i.test(gitHead)) {
    errors.push('evidence gitHead is missing or invalid');
    return errors;
  }
  try {
    assertAncestor(root, gitHead);
    const relevant = changedFiles(root, gitHead).filter((file) => isPromptInputPath(file, scope));
    if (relevant.length > 0) {
      errors.push(`evidence is stale after prompt/tool schema changed: ${relevant.join(', ')}`);
    }
  } catch {
    errors.push('evidence gitHead is not an ancestor of HEAD');
  }
  return errors;
}

function changedForThisGate(root: string, baseRef: string): boolean {
  const scope = loadPromptChangePaths(root);
  return changedFiles(root, baseRef).some((file) => (
    isPromptInputPath(file, scope)
    || file === scope.versionFile
    || file === PROMPT_EVIDENCE.evidence
  ));
}

function parseArgs(argv: string[]): { root: string; baseRef?: string } {
  let root = process.cwd();
  let baseRef: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') root = path.resolve(argv[++index] ?? '');
    else if (argv[index] === '--base-ref') baseRef = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return { root, baseRef };
}

function main(): void {
  const { root, baseRef } = parseArgs(process.argv.slice(2));
  if (baseRef && !changedForThisGate(root, baseRef)) {
    console.log(`Prompt gate evidence check not required: no prompt inputs changed since ${baseRef}.`);
    return;
  }
  const errors = checkPromptGateEvidence(root);
  if (errors.length > 0) {
    console.error('Prompt gate evidence gate failed:');
    for (const error of errors) console.error(`- ${error}`);
    console.error(`修法：${REPAIR}`);
    process.exitCode = 1;
    return;
  }
  console.log('Prompt gate evidence gate passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'prompt gate evidence checker failed');
    console.error(`修法：${REPAIR}`);
    process.exitCode = 1;
  }
}
