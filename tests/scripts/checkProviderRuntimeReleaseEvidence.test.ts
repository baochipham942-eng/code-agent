import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CHECKER = path.join(REPO_ROOT, 'scripts/check-provider-runtime-release-evidence.ts');
const workspaces: string[] = [];

function writeJson(root: string, relativePath: string, value: unknown): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(root: string, relativePath: string, value: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8')) as T;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-release-evidence-'));
  workspaces.push(root);

  writeText(root, 'src/host/model/providerRuntimeCapabilities.ts', `
export const PROVIDER_RUNTIME_CAPABILITY_STATUSES = ['supported', 'experimental', 'unknown', 'unsupported'] as const;
export const PROVIDER_RUNTIME_CAPABILITIES = ['text_streaming'] as const;
export const PROVIDER_RUNTIME_CAPABILITY_MATRIX = [{
  runtime: 'native',
  protocolFamily: 'openai_chat_completions',
  providerScope: ['openai'],
  adapterBoundary: 'synthetic adapter',
  capabilities: {
    text_streaming: {
      status: 'supported',
      note: 'verified synthetic fixture',
      evidence: {
        requestFixture: 'docs/capabilities/request-shapes/native-openai.json',
        automatedTest: 'tests/unit/model/providerRuntimeCapabilities.test.ts',
        liveSmokeLedgerId: 'docs/capabilities/provider-runtime-live-smoke-ledger.json#openai-live',
      },
    },
  },
}];
`);
  writeText(root, 'tests/unit/model/providerRuntimeCapabilities.test.ts', '// synthetic automated evidence\n');
  writeJson(root, 'docs/capabilities/request-shapes/native-openai.json', {
    schemaVersion: 1,
    runtime: 'native',
    protocolFamily: 'openai_chat_completions',
    syntheticRequest: { provider: 'openai', model: '<synthetic-model>' },
  });
  writeJson(root, 'docs/capabilities/provider-runtime-live-smoke-ledger.json', {
    schemaVersion: 1,
    updatedAt: '2026-07-11',
    policy: {
      verificationStatus: ['verified', 'unverified', 'failed'],
      supportedRequiresVerifiedRecord: true,
      paidOrSubscriptionSmokeRequiresExplicitAuthorization: true,
      secretsAndUserContent: 'must-not-be-recorded',
    },
    localDiscovery: {
      configuredProviderNamesOnly: ['openai'],
      externalRuntimeAvailability: {},
      credentialValuesRecorded: false,
    },
    records: [{
      id: 'openai-live',
      date: '2026-07-11',
      runtime: 'native',
      protocolFamily: 'openai_chat_completions',
      provider: 'openai',
      model: 'synthetic-live-model',
      verificationStatus: 'verified',
      result: 'passed',
      evidence: ['artifact://provider-smoke/openai-live'],
    }],
  });

  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'neo-test@example.invalid');
  git(root, 'config', 'user.name', 'Neo Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture base');
  const head = git(root, 'rev-parse', 'HEAD');

  writeJson(root, 'docs/perf/long-session-gold-latest.json', {
    schemaVersion: 1,
    generatedAt: '2026-07-11T00:00:00.000Z',
    environment: {
      gitHead: head,
      node: 'v24.0.0',
      platform: 'darwin/arm64',
      cpu: 'Synthetic CPU',
      cpuCount: 8,
      totalMemoryBytes: 16_000_000_000,
      browser: 'Synthetic Browser',
      viewport: { width: 1440, height: 900 },
    },
    gates: {
      turns500Interactive: true,
      anchorDrift: true,
      userScroll: true,
      streamingFollow: true,
      search: true,
      mainThread: true,
      memoryRecorded: true,
    },
    passed: true,
  });
  writeJson(root, 'docs/stability/tool-cancel-smoke-latest.json', {
    schemaVersion: 1,
    smoke: 'tool-cancel',
    generatedAt: '2026-07-11T00:00:00.000Z',
    gitHead: head,
    passed: true,
    scenarios: {
      Bash: { passed: true, durationMs: 20, terminalCleanup: true },
      http_request: { passed: true, durationMs: 25, terminalCleanup: true },
    },
  });
  writeJson(root, 'docs/stability/agent-runtime-app-host-smoke-latest.json', {
    schemaVersion: 1,
    smoke: 'agent-runtime-app-host',
    generatedAt: '2026-07-11T00:00:00.000Z',
    gitHead: head,
    passed: true,
    scenarios: {
      RunRegistry: { passed: true, durationMs: 30, terminalCleanup: true },
      rendererStop: { passed: true, durationMs: 40, terminalCleanup: true },
    },
  });
  writeText(root, 'docs/releases/stability-release-template.md', `# Stability Release\n\nProvider capability source: [matrix](../capabilities/provider-runtime-matrix.md) and [ledger](../capabilities/provider-runtime-live-smoke-ledger.json).\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fresh evidence');
  return root;
}

function runChecker(root: string, mode = 'full'): { status: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), CHECKER, '--root', root, '--mode', mode, '--now', '2026-07-11T12:00:00.000Z'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

describe('provider runtime release evidence gate', () => {
  it('returns zero for a complete and fresh evidence workspace', () => {
    const result = runChecker(createWorkspace());
    expect(result, result.output).toMatchObject({ status: 0 });
  });

  it('rejects a supported cell without a verified live smoke record', () => {
    const root = createWorkspace();
    const ledger = readJson<{ records: Array<Record<string, unknown>> }>(root, 'docs/capabilities/provider-runtime-live-smoke-ledger.json');
    ledger.records[0].verificationStatus = 'unverified';
    ledger.records[0].result = 'not_run';
    delete ledger.records[0].evidence;
    writeJson(root, 'docs/capabilities/provider-runtime-live-smoke-ledger.json', ledger);

    const result = runChecker(root, 'static');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('requires a verified passed live smoke');
  });

  it('rejects a supported cell whose request fixture is missing', () => {
    const root = createWorkspace();
    fs.rmSync(path.join(root, 'docs/capabilities/request-shapes/native-openai.json'));

    const result = runChecker(root, 'static');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('missing evidence file');
  });

  it.each([
    ['Authorization', { Authorization: 'Bearer redacted-but-forbidden' }],
    ['API key', { apiKey: 'sk-forbidden12345678' }],
  ])('rejects a ledger containing %s material', (_label, secret) => {
    const root = createWorkspace();
    const ledger = readJson<Record<string, unknown>>(root, 'docs/capabilities/provider-runtime-live-smoke-ledger.json');
    Object.assign(ledger, secret);
    writeJson(root, 'docs/capabilities/provider-runtime-live-smoke-ledger.json', ledger);

    const result = runChecker(root, 'static');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('forbidden secret or user-content field');
    expect(result.output).not.toContain('sk-forbidden');
  });

  it('allows experimental plus unverified evidence without claiming formal support', () => {
    const root = createWorkspace();
    const matrixPath = path.join(root, 'src/host/model/providerRuntimeCapabilities.ts');
    fs.writeFileSync(matrixPath, fs.readFileSync(matrixPath, 'utf8').replace("status: 'supported'", "status: 'experimental'"));
    const ledger = readJson<{ records: Array<Record<string, unknown>> }>(root, 'docs/capabilities/provider-runtime-live-smoke-ledger.json');
    ledger.records[0].verificationStatus = 'unverified';
    ledger.records[0].result = 'not_run';
    ledger.records[0].provider = 'configured-provider-set';
    delete ledger.records[0].evidence;
    writeJson(root, 'docs/capabilities/provider-runtime-live-smoke-ledger.json', ledger);

    expect(runChecker(root, 'static')).toMatchObject({ status: 0 });

    fs.appendFileSync(
      path.join(root, 'docs/releases/stability-release-template.md'),
      '\nFormally supported: native/openai_chat_completions/text_streaming\n',
    );
    const claimed = runChecker(root, 'static');
    expect(claimed.status).not.toBe(0);
    expect(claimed.output).toContain('claims non-supported capability as supported');
  });

  it.each([
    ['broken JSON', '{broken', 'invalid JSON'],
    ['unknown schemaVersion', JSON.stringify({ schemaVersion: 999 }), 'unknown schemaVersion'],
  ])('fails closed for %s', (_label, content, expected) => {
    const root = createWorkspace();
    fs.writeFileSync(path.join(root, 'docs/capabilities/provider-runtime-live-smoke-ledger.json'), content);

    const result = runChecker(root, 'static');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(expected);
  });

  it('rejects a failed long-session report', () => {
    const root = createWorkspace();
    const report = readJson<Record<string, unknown>>(root, 'docs/perf/long-session-gold-latest.json');
    report.passed = false;
    writeJson(root, 'docs/perf/long-session-gold-latest.json', report);

    const result = runChecker(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('passed must be true');
  });

  it('marks long-session evidence stale after related source changes', () => {
    const root = createWorkspace();
    writeText(root, 'src/renderer/components/Conversation/LongSessionChange.tsx', 'export const changed = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'change long session UI');

    const result = runChecker(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('long-session-gold-latest.json is stale after relevant code changed');
  });

  it('does not mark long-session evidence stale for unrelated documentation changes', () => {
    const root = createWorkspace();
    writeText(root, 'docs/capabilities/unrelated-provider-note.md', '# Provider-only note\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'provider docs only');

    const result = runChecker(root);
    expect(result, result.output).toMatchObject({ status: 0 });
  });

  it.each([
    ['http_request', 'docs/stability/tool-cancel-smoke-latest.json'],
    ['rendererStop', 'docs/stability/agent-runtime-app-host-smoke-latest.json'],
  ])('rejects Stop evidence missing the %s scenario', (scenario, relativePath) => {
    const root = createWorkspace();
    const report = readJson<{ scenarios: Record<string, unknown> }>(root, relativePath);
    delete report.scenarios[scenario];
    writeJson(root, relativePath, report);

    const result = runChecker(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`missing ${scenario} scenario`);
  });

  it('marks Stop evidence stale after RunRegistry changes', () => {
    const root = createWorkspace();
    writeText(root, 'src/host/runtime/runRegistry.ts', 'export const changed = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'change run registry');

    const result = runChecker(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('tool-cancel-smoke-latest.json is stale after relevant code changed');
    expect(result.output).toContain('agent-runtime-app-host-smoke-latest.json is stale after relevant code changed');
  });

  it.each([
    ['provider live smoke', 'docs/capabilities/provider-runtime-live-smoke-ledger.json', (value: Record<string, unknown>) => {
      const records = value.records as Array<Record<string, unknown>>;
      records[0].date = '2026-06-01';
    }, 'older than 30 days'],
    ['long session', 'docs/perf/long-session-gold-latest.json', (value: Record<string, unknown>) => {
      value.generatedAt = '2026-06-20T00:00:00.000Z';
    }, 'older than 14 days'],
    ['Stop', 'docs/stability/tool-cancel-smoke-latest.json', (value: Record<string, unknown>) => {
      value.generatedAt = '2026-07-01T00:00:00.000Z';
    }, 'older than 7 days'],
  ])('locks the freshness window for %s evidence', (_label, relativePath, mutate, expected) => {
    const root = createWorkspace();
    const value = readJson<Record<string, unknown>>(root, relativePath);
    mutate(value);
    writeJson(root, relativePath, value);

    const result = runChecker(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(expected);
  });
});
