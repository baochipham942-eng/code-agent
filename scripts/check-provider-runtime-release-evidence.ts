#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type GateMode = 'static' | 'full';

interface GateOptions {
  root: string;
  mode: GateMode;
  now: Date;
}

interface MatrixEvidence {
  requestFixture: string;
  automatedTest: string;
  liveSmokeLedgerId: string;
}

interface MatrixCell {
  status: string;
  note: string;
  evidence?: MatrixEvidence;
}

interface MatrixEntry {
  runtime: string;
  protocolFamily: string;
  providerScope: string[];
  adapterBoundary: string;
  capabilities: Record<string, MatrixCell>;
  capabilityOverrides?: Record<string, Record<string, MatrixCell>>;
}

interface LedgerRecord {
  id: string;
  date: string;
  runtime: string;
  protocolFamily: string;
  provider: string;
  model: string;
  verificationStatus: string;
  result: string;
  evidence?: string[];
  reason?: string;
  scope?: string;
}

const LEDGER_MAX_AGE_DAYS = 30;
const LONG_SESSION_MAX_AGE_DAYS = 14;
const STOP_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;

const LONG_SESSION_RELEVANT = [
  /^src\/renderer\/components\/features\/chat\//,
  /^src\/renderer\/components\/.*(Conversation|TurnBasedTraceView)/i,
  /^src\/renderer\/hooks\/.*(conversation|session|scroll|stream)/i,
  /^src\/renderer\/stores\/.*(conversation|session|stream)/i,
  /^src\/host\/agent\/agentLoop\.ts$/,
  /^src\/host\/app\/agentAppService\.ts$/,
  /^src\/host\/session\/streamSnapshot\.ts$/,
  /^src\/host\/runtime\/run(Context|Registry)\.ts$/,
  /^src\/shared\/contract\/session\.ts$/,
  /^src\/web\/routes\/agent\.ts$/,
  /^scripts\/perf\/long-session-/,
  /^tests\/(renderer|unit|integration)\/.*(Conversation|longSession|streamSnapshot|runRegistry)/i,
];

const STOP_RELEVANT = [
  /^src\/host\/agent\/agentLoop\.ts$/,
  /^src\/host\/app\/agentAppService\.ts$/,
  /^src\/host\/runtime\/run(Context|Registry)\.ts$/,
  /^src\/host\/tools\//,
  /^src\/web\/routes\/(agent|dev|devAgentLoopStubSmoke|devCancellableToolSmoke)\.ts$/,
  /^src\/renderer\/components\/features\/chat\//,
  /^src\/shared\/contract\/session\.ts$/,
  /^scripts\/acceptance\/(tool-cancel|agent-runtime-app-host)-smoke\.ts$/,
  /^tests\/.*(cancel|stop|runRegistry|recovery)/i,
];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) errors.push(`${label} has unknown field(s): ${unknown.join(', ')}`);
}

function readJson(root: string, relativePath: string, errors: string[]): unknown {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    errors.push(`missing evidence file: ${relativePath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    errors.push(`invalid JSON in evidence file: ${relativePath}`);
    return null;
  }
}

function dateAgeDays(value: unknown, now: Date, label: string, maxAge: number, errors: string[]): void {
  if (typeof value !== 'string') {
    errors.push(`${label} is missing a date`);
    return;
  }
  const parsed = new Date(value.includes('T') ? value : `${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    errors.push(`${label} has an invalid date`);
    return;
  }
  const age = (now.valueOf() - parsed.valueOf()) / DAY_MS;
  if (age < -1) errors.push(`${label} is dated in the future`);
  if (age > maxAge) errors.push(`${label} is stale: older than ${maxAge} days`);
}

function scanSensitive(relativePath: string, value: unknown, errors: string[]): void {
  const text = JSON.stringify(value);
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{8,}/i,
    /Bearer\s+[A-Za-z0-9._~+/-]{8,}/i,
    /"(?:authorization|cookie|apiKey|accessToken|refreshToken|token|password|secret|userPrompt|prompt|responseBody|responseText)"\s*:/i,
  ];
  if (patterns.some((pattern) => pattern.test(text))) {
    errors.push(`${relativePath} contains a forbidden secret or user-content field`);
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function changedSince(root: string, gitHead: string, patterns: RegExp[], label: string, errors: string[]): void {
  if (!/^[0-9a-f]{40}$/i.test(gitHead)) {
    errors.push(`${label} gitHead is missing or invalid`);
    return;
  }
  try {
    git(root, ['merge-base', '--is-ancestor', gitHead, 'HEAD']);
    const committed = git(root, ['diff', '--name-only', `${gitHead}..HEAD`]);
    const working = git(root, ['diff', '--name-only', 'HEAD']);
    const staged = git(root, ['diff', '--cached', '--name-only', 'HEAD']);
    const files = [...new Set(`${committed}\n${working}\n${staged}`.split(/\r?\n/).filter(Boolean))];
    const relevant = files.filter((file) => patterns.some((pattern) => pattern.test(file)));
    if (relevant.length > 0) {
      errors.push(`${label} is stale after relevant code changed: ${relevant.join(', ')}`);
    }
  } catch {
    errors.push(`${label} gitHead is not an ancestor of HEAD`);
  }
}

async function loadMatrix(options: GateOptions, errors: string[]): Promise<{
  statuses: string[];
  capabilities: string[];
  entries: MatrixEntry[];
}> {
  const relativePath = 'src/host/model/providerRuntimeCapabilities.ts';
  const filePath = path.join(options.root, relativePath);
  if (!fs.existsSync(filePath)) {
    errors.push(`missing evidence source: ${relativePath}`);
    return { statuses: [], capabilities: [], entries: [] };
  }
  try {
    const module = await import(`${pathToFileURL(filePath).href}?release-evidence=${Date.now()}`) as Record<string, unknown>;
    return {
      statuses: Array.isArray(module.PROVIDER_RUNTIME_CAPABILITY_STATUSES) ? [...module.PROVIDER_RUNTIME_CAPABILITY_STATUSES] as string[] : [],
      capabilities: Array.isArray(module.PROVIDER_RUNTIME_CAPABILITIES) ? [...module.PROVIDER_RUNTIME_CAPABILITIES] as string[] : [],
      entries: Array.isArray(module.PROVIDER_RUNTIME_CAPABILITY_MATRIX) ? module.PROVIDER_RUNTIME_CAPABILITY_MATRIX as MatrixEntry[] : [],
    };
  } catch {
    errors.push(`cannot load provider/runtime matrix: ${relativePath}`);
    return { statuses: [], capabilities: [], entries: [] };
  }
}

function validateFixture(
  options: GateOptions,
  relativePath: string,
  runtime: string,
  protocolFamily: string,
  errors: string[],
): void {
  const fixture = readJson(options.root, relativePath, errors);
  if (!isObject(fixture)) return;
  ownKeys(fixture, ['schemaVersion', 'runtime', 'protocolFamily', 'adapterBoundary', 'syntheticRequest', 'expectedRequestedCapabilities', 'expectedFailure', 'redaction'], relativePath, errors);
  if (fixture.schemaVersion !== 1) errors.push(`${relativePath} has unknown schemaVersion`);
  if (fixture.runtime !== runtime) errors.push(`${relativePath} runtime does not match matrix entry`);
  if (fixture.protocolFamily !== protocolFamily) errors.push(`${relativePath} protocolFamily does not match matrix entry`);
  scanSensitive(relativePath, fixture, errors);
}

function validateLedger(options: GateOptions, errors: string[]): Map<string, LedgerRecord> {
  const relativePath = 'docs/capabilities/provider-runtime-live-smoke-ledger.json';
  const ledger = readJson(options.root, relativePath, errors);
  const records = new Map<string, LedgerRecord>();
  if (!isObject(ledger)) return records;
  ownKeys(ledger, ['schemaVersion', 'updatedAt', 'policy', 'localDiscovery', 'records'], relativePath, errors);
  if (ledger.schemaVersion !== 1) errors.push(`${relativePath} has unknown schemaVersion`);
  if (!Array.isArray(ledger.records)) {
    errors.push(`${relativePath} records must be an array`);
    return records;
  }
  if (isObject(ledger.policy)) {
    ownKeys(ledger.policy, ['verificationStatus', 'supportedRequiresVerifiedRecord', 'paidOrSubscriptionSmokeRequiresExplicitAuthorization', 'secretsAndUserContent'], `${relativePath} policy`, errors);
  } else {
    errors.push(`${relativePath} policy is missing`);
  }
  if (isObject(ledger.localDiscovery)) {
    ownKeys(ledger.localDiscovery, ['configuredProviderNamesOnly', 'externalRuntimeAvailability', 'credentialValuesRecorded'], `${relativePath} localDiscovery`, errors);
  } else {
    errors.push(`${relativePath} localDiscovery is missing`);
  }
  scanSensitive(relativePath, ledger, errors);
  for (const [index, raw] of ledger.records.entries()) {
    const label = `${relativePath} record ${index}`;
    if (!isObject(raw)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    ownKeys(raw, ['id', 'date', 'runtime', 'protocolFamily', 'provider', 'model', 'verificationStatus', 'result', 'evidence', 'reason', 'scope'], label, errors);
    const required = ['id', 'date', 'runtime', 'protocolFamily', 'provider', 'model', 'verificationStatus', 'result'];
    for (const field of required) if (typeof raw[field] !== 'string' || !raw[field]) errors.push(`${label} is missing ${field}`);
    if (!['verified', 'unverified', 'failed'].includes(String(raw.verificationStatus))) errors.push(`${label} has invalid verificationStatus`);
    if (raw.verificationStatus === 'verified') {
      if (!Array.isArray(raw.evidence) || raw.evidence.length === 0 || raw.evidence.some((item) => typeof item !== 'string' || !item)) {
        errors.push(`${label} verified record is missing evidence`);
      }
      dateAgeDays(raw.date, options.now, label, LEDGER_MAX_AGE_DAYS, errors);
    }
    if (typeof raw.id === 'string') {
      if (records.has(raw.id)) errors.push(`${label} duplicates ledger id ${raw.id}`);
      records.set(raw.id, raw as unknown as LedgerRecord);
    }
  }
  return records;
}

function validateReleaseMaterials(options: GateOptions, matrix: MatrixEntry[], errors: string[]): void {
  const releasesDir = path.join(options.root, 'docs/releases');
  if (!fs.existsSync(releasesDir)) {
    errors.push('missing release materials directory: docs/releases');
    return;
  }
  const files = fs.readdirSync(releasesDir).filter((file) => /^stability-.*\.md$/i.test(file));
  if (files.length === 0) errors.push('missing Stability Release template under docs/releases');
  const nonSupported = new Set<string>();
  for (const entry of matrix) {
    for (const [capability, cell] of Object.entries(entry.capabilities)) {
      if (cell.status !== 'supported') nonSupported.add(`${entry.runtime}/${entry.protocolFamily}/${capability}`);
    }
  }
  for (const file of files) {
    const relativePath = `docs/releases/${file}`;
    const content = fs.readFileSync(path.join(releasesDir, file), 'utf8');
    if (!content.includes('../capabilities/provider-runtime-matrix.md') || !content.includes('../capabilities/provider-runtime-live-smoke-ledger.json')) {
      errors.push(`${relativePath} must reference the provider matrix and live smoke ledger`);
    }
    for (const coordinate of nonSupported) {
      const escaped = coordinate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:supported|正式支持)[^\\n]{0,80}${escaped}|${escaped}[^\\n]{0,80}(?:supported|正式支持)`, 'i').test(content)) {
        errors.push(`${relativePath} claims non-supported capability as supported: ${coordinate}`);
      }
    }
  }
}

async function validateMatrix(options: GateOptions, ledger: Map<string, LedgerRecord>, errors: string[]): Promise<MatrixEntry[]> {
  const { statuses, capabilities, entries } = await loadMatrix(options, errors);
  const allowed = ['supported', 'experimental', 'unknown', 'unsupported'];
  if (JSON.stringify(statuses) !== JSON.stringify(allowed)) errors.push('matrix status enum must contain only supported, experimental, unknown, unsupported');
  if (capabilities.length === 0 || entries.length === 0) errors.push('provider/runtime matrix is empty');
  for (const [entryIndex, entry] of entries.entries()) {
    const label = `matrix entry ${entryIndex}`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    ownKeys(entry as unknown as Record<string, unknown>, ['runtime', 'protocolFamily', 'providerScope', 'adapterBoundary', 'capabilities', 'capabilityOverrides'], label, errors);
    if (typeof entry.runtime !== 'string' || typeof entry.protocolFamily !== 'string') errors.push(`${label} is missing runtime or protocolFamily`);
    const keys = isObject(entry.capabilities) ? Object.keys(entry.capabilities) : [];
    if ([...keys].sort().join(',') !== [...capabilities].sort().join(',')) errors.push(`${label} does not define every declared capability exactly once`);
    const cells: Array<[string, MatrixCell]> = Object.entries(entry.capabilities ?? {});
    for (const [provider, overrides] of Object.entries(entry.capabilityOverrides ?? {})) {
      for (const [capability, cell] of Object.entries(overrides)) cells.push([`${provider}/${capability}`, cell]);
    }
    for (const [capability, cell] of cells) {
      const cellLabel = `${entry.runtime}/${entry.protocolFamily}/${capability}`;
      if (!isObject(cell)) {
        errors.push(`${cellLabel} must be an object`);
        continue;
      }
      ownKeys(cell as unknown as Record<string, unknown>, ['status', 'note', 'evidence'], cellLabel, errors);
      if (!allowed.includes(cell.status)) errors.push(`${cellLabel} has invalid status`);
      if (typeof cell.note !== 'string' || !cell.note) errors.push(`${cellLabel} is missing note`);
      if (cell.status === 'supported' && !cell.evidence) errors.push(`${cellLabel} supported cell is missing three-layer evidence`);
      if (!cell.evidence) continue;
      const evidence = cell.evidence;
      ownKeys(evidence as unknown as Record<string, unknown>, ['requestFixture', 'automatedTest', 'liveSmokeLedgerId'], `${cellLabel} evidence`, errors);
      if (!fs.existsSync(path.join(options.root, evidence.automatedTest))) errors.push(`${cellLabel} automated test does not exist: ${evidence.automatedTest}`);
      validateFixture(options, evidence.requestFixture, entry.runtime, entry.protocolFamily, errors);
      const [ledgerPath, ledgerId, ...extra] = evidence.liveSmokeLedgerId.split('#');
      if (ledgerPath !== 'docs/capabilities/provider-runtime-live-smoke-ledger.json' || !ledgerId || extra.length > 0) {
        errors.push(`${cellLabel} has invalid live smoke ledger reference`);
        continue;
      }
      const record = ledger.get(ledgerId);
      if (!record) {
        errors.push(`${cellLabel} references missing live smoke record: ${ledgerId}`);
        continue;
      }
      if (record.runtime !== entry.runtime || record.protocolFamily !== entry.protocolFamily) errors.push(`${cellLabel} ledger runtime/protocolFamily does not match matrix`);
      if (cell.status === 'supported' && entry.providerScope.length > 0 && !entry.providerScope.includes(record.provider)) {
        errors.push(`${cellLabel} ledger provider does not match matrix providerScope`);
      }
      if (cell.status === 'supported' && (record.verificationStatus !== 'verified' || record.result !== 'passed')) {
        errors.push(`${cellLabel} supported cell requires a verified passed live smoke`);
      }
    }
  }
  return entries;
}

function validateLongSession(options: GateOptions, errors: string[]): void {
  const relativePath = 'docs/perf/long-session-gold-latest.json';
  const report = readJson(options.root, relativePath, errors);
  if (!isObject(report)) return;
  ownKeys(report, ['schemaVersion', 'generatedAt', 'environment', 'thresholds', 'stopEvidence', 'scenarios', 'mainThread', 'memory', 'gates', 'passed'], relativePath, errors);
  if (report.schemaVersion !== 1) errors.push(`${relativePath} has unknown schemaVersion`);
  if (report.passed !== true) errors.push(`${relativePath} passed must be true`);
  if (!isObject(report.gates) || Object.keys(report.gates).length === 0 || Object.values(report.gates).some((value) => value !== true)) errors.push(`${relativePath} requires every gate to be true`);
  if (!isObject(report.environment)) {
    errors.push(`${relativePath} environment is missing`);
    return;
  }
  const requiredEnvironment = ['gitHead', 'node', 'platform', 'cpu', 'cpuCount', 'totalMemoryBytes', 'browser', 'viewport'];
  for (const field of requiredEnvironment) if (report.environment[field] === undefined || report.environment[field] === '') errors.push(`${relativePath} environment is missing ${field}`);
  dateAgeDays(report.generatedAt, options.now, relativePath, LONG_SESSION_MAX_AGE_DAYS, errors);
  changedSince(options.root, String(report.environment.gitHead ?? ''), LONG_SESSION_RELEVANT, relativePath, errors);
}

function validateStopReport(
  options: GateOptions,
  relativePath: string,
  expectedSmoke: string,
  scenarios: string[],
  errors: string[],
): void {
  const report = readJson(options.root, relativePath, errors);
  if (!isObject(report)) return;
  ownKeys(report, ['schemaVersion', 'smoke', 'generatedAt', 'gitHead', 'passed', 'scenarios'], relativePath, errors);
  if (report.schemaVersion !== 1) errors.push(`${relativePath} has unknown schemaVersion`);
  if (report.smoke !== expectedSmoke) errors.push(`${relativePath} smoke id is invalid`);
  if (report.passed !== true) errors.push(`${relativePath} passed must be true`);
  if (!isObject(report.scenarios)) {
    errors.push(`${relativePath} scenarios are missing`);
  } else {
    ownKeys(report.scenarios, scenarios, `${relativePath} scenarios`, errors);
    for (const scenario of scenarios) {
      const value = report.scenarios[scenario];
      if (!isObject(value)) {
        errors.push(`${relativePath} is missing ${scenario} scenario`);
        continue;
      }
      ownKeys(value, ['passed', 'durationMs', 'terminalCleanup'], `${relativePath} ${scenario}`, errors);
      if (value.passed !== true || value.terminalCleanup !== true || typeof value.durationMs !== 'number' || value.durationMs < 0) {
        errors.push(`${relativePath} ${scenario} scenario did not pass with terminal cleanup and duration`);
      }
    }
  }
  dateAgeDays(report.generatedAt, options.now, relativePath, STOP_MAX_AGE_DAYS, errors);
  changedSince(options.root, String(report.gitHead ?? ''), STOP_RELEVANT, relativePath, errors);
}

export async function checkProviderRuntimeReleaseEvidence(options: GateOptions): Promise<string[]> {
  const errors: string[] = [];
  const ledger = validateLedger(options, errors);
  const matrix = await validateMatrix(options, ledger, errors);
  validateReleaseMaterials(options, matrix, errors);
  if (options.mode === 'full') {
    validateLongSession(options, errors);
    validateStopReport(options, 'docs/stability/tool-cancel-smoke-latest.json', 'tool-cancel', ['Bash', 'http_request'], errors);
    validateStopReport(options, 'docs/stability/agent-runtime-app-host-smoke-latest.json', 'agent-runtime-app-host', ['RunRegistry', 'rendererStop'], errors);
  }
  return errors;
}

function parseOptions(argv: string[]): GateOptions {
  let root = process.cwd();
  let mode: GateMode = 'full';
  let now = new Date();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') root = path.resolve(argv[++index] ?? '');
    else if (arg === '--mode') {
      const value = argv[++index];
      if (value !== 'static' && value !== 'full') throw new Error('--mode must be static or full');
      mode = value;
    } else if (arg === '--now') {
      now = new Date(argv[++index] ?? '');
      if (Number.isNaN(now.valueOf())) throw new Error('--now must be an ISO date');
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { root, mode, now };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const errors = await checkProviderRuntimeReleaseEvidence(options);
  if (errors.length > 0) {
    console.error('Provider/runtime release evidence gate failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Provider/runtime release evidence gate passed (${options.mode}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'release evidence checker failed');
    process.exitCode = 1;
  });
}
