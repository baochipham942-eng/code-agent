import { makeEvidenceRef, type EvidenceRef } from '../../shared/contract/evidence';
import {
  classifyVerificationFailure,
  type VerificationEvidence,
  type VerificationFailureType,
} from './verification';

export interface CiLogIngestInput {
  source: string;
  logText: string;
  runUrl?: string;
  jobName?: string;
  capturedAtMs?: number;
}

export interface CiFailureAttribution {
  source: string;
  runUrl?: string;
  failingJob?: string;
  failingStep?: string;
  command?: string;
  topErrorLines: string[];
  candidateFiles: string[];
  failureType: VerificationFailureType;
  evidenceRef: EvidenceRef;
}

const ERROR_LINE_PATTERN = /\b(error|failed|failure|exception|traceback|ts\d{4}|eslint|lint|assertion|expected|received)\b/i;
const FILE_PATTERN = /(?:^|[\s"'(])((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|md|py|rs|go|java|kt|swift|yml|yaml))(?:[:()"'\]\s]|$)/g;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function compactLine(line: string): string {
  return line.replace(ANSI_ESCAPE_PATTERN, '').replace(/\s+/g, ' ').trim();
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(compactLine)
    .filter(Boolean);
}

function extractFailingStep(lines: string[]): string | undefined {
  const runLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^Run\s+/.test(line) || /^##\[group\]Run\s+/.test(line));
  const firstErrorIndex = lines.findIndex((line) => ERROR_LINE_PATTERN.test(line) || /Process completed with exit code/i.test(line));
  const eligible = firstErrorIndex >= 0
    ? runLines.filter(({ index }) => index <= firstErrorIndex)
    : runLines;
  const chosen = eligible.at(-1) ?? runLines.at(-1);
  return chosen?.line.replace(/^##\[group\]/, '').replace(/^Run\s+/, '').trim();
}

function extractCommand(lines: string[], failingStep?: string): string | undefined {
  if (failingStep) return failingStep;
  const commandLine = lines.find((line) => /^\$\s+/.test(line) || /^>\s+[\w@./-]+/.test(line) || /^npm\s+(run|test|exec)\b/.test(line));
  return commandLine?.replace(/^\$\s+/, '').replace(/^>\s+/, '').trim();
}

function extractTopErrorLines(lines: string[]): string[] {
  const selected = lines.filter((line) => ERROR_LINE_PATTERN.test(line) || /Process completed with exit code/i.test(line));
  return selected.slice(0, 12);
}

function extractCandidateFiles(lines: string[]): string[] {
  const files = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(FILE_PATTERN)) {
      const file = match[1]?.replace(/^\.\//, '');
      if (file && !file.includes('node_modules/')) {
        files.add(file);
      }
    }
  }
  return [...files].slice(0, 20);
}

function extractFailingJob(input: CiLogIngestInput, lines: string[]): string | undefined {
  if (input.jobName?.trim()) return input.jobName.trim();
  const jobLine = lines.find((line) => /^Job\s+/.test(line) || /^##\[group\].*job/i.test(line));
  return jobLine?.replace(/^##\[group\]/, '').trim();
}

export function attributeCiFailure(input: CiLogIngestInput): CiFailureAttribution {
  const lines = nonEmptyLines(input.logText);
  const failingStep = extractFailingStep(lines);
  const command = extractCommand(lines, failingStep);
  const topErrorLines = extractTopErrorLines(lines);
  const output = topErrorLines.length > 0 ? topErrorLines.join('\n') : lines.slice(-20).join('\n');
  const failureType = classifyVerificationFailure(command || input.source, output, false);
  const evidenceRef = makeEvidenceRef({
    kind: 'ci',
    ref: input.runUrl || input.source,
    source: 'ci-log-ingest',
    state: 'read',
    redactionStatus: 'clean',
    capturedAtMs: input.capturedAtMs,
  });
  return {
    source: input.source,
    runUrl: input.runUrl,
    failingJob: extractFailingJob(input, lines),
    failingStep,
    command,
    topErrorLines,
    candidateFiles: extractCandidateFiles(topErrorLines.length > 0 ? topErrorLines : lines),
    failureType,
    evidenceRef,
  };
}

export function ingestCiLogEvidence(input: CiLogIngestInput): VerificationEvidence {
  const attribution = attributeCiFailure(input);
  const command = attribution.command || input.source;
  const output = attribution.topErrorLines.join('\n');
  return {
    status: 'failed',
    failureType: attribution.failureType,
    summary: `${attribution.failureType}: CI log ${input.source} failed${attribution.failingStep ? ` at ${attribution.failingStep}` : ''}.`,
    plan: {
      cwd: '',
      goal: 'CI verification evidence',
      changedFiles: attribution.candidateFiles,
      packageScripts: [],
      required: [],
      optional: [],
      skippedChecks: [],
    },
    commandResults: [{
      id: `ci:${attribution.evidenceRef.id}`,
      command,
      cwd: '',
      required: true,
      kind: 'ci',
      reason: 'CI log ingest failure attribution.',
      pass: false,
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      stdoutTail: '',
      stderrTail: output,
      output,
      evidenceRef: attribution.evidenceRef,
    }],
    skippedChecks: [],
    evidenceRefs: [attribution.evidenceRef],
  };
}
