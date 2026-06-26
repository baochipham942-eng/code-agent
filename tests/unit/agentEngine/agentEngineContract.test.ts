import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeAgentEngineSession,
} from '../../../src/shared/contract/agentEngine';
import {
  assertWorkspaceCwd,
  buildManualAgentEngineSelection,
  resolveExternalEngineLaunch,
} from '../../../src/host/services/agentEngine/agentEngineGuards';
import {
  DEFAULT_CODEX_CLI_TIMEOUT_MS,
  MIN_CODEX_CLI_TIMEOUT_MS,
  normalizeCodexCliRunTiming,
} from '../../../src/host/services/agentEngine/agentEngineTiming';
import { normalizeVersionOutput as normalizeRegistryVersionOutput } from '../../../src/host/services/agentEngine/agentEngineRegistry';
import type { Session } from '../../../src/shared/contract/session';

describe('Agent Engine contract', () => {
  it('defaults old sessions to native', () => {
    expect(normalizeAgentEngineSession(null)).toEqual({
      kind: 'native',
      permissionProfile: 'default',
      origin: 'manual',
    });
  });

  it('defaults Codex CLI sessions to read only', () => {
    expect(normalizeAgentEngineSession({ kind: 'codex_cli' })).toMatchObject({
      kind: 'codex_cli',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });

  it('defaults Claude Code sessions to read only', () => {
    expect(normalizeAgentEngineSession({ kind: 'claude_code' })).toMatchObject({
      kind: 'claude_code',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });

  it('preserves external engine session metadata fields', () => {
    expect(normalizeAgentEngineSession({
      kind: 'codex_cli',
      cwd: '/repo/code-agent',
      permissionProfile: 'read_only',
      origin: 'manual',
      model: 'gpt-5',
      runId: 'run-1',
      externalSessionId: 'external-1',
      logPath: '/repo/code-agent/.logs/run-1.jsonl',
      updatedAt: 123,
    })).toEqual({
      kind: 'codex_cli',
      cwd: '/repo/code-agent',
      permissionProfile: 'read_only',
      origin: 'manual',
      model: 'gpt-5',
      runId: 'run-1',
      externalSessionId: 'external-1',
      logPath: '/repo/code-agent/.logs/run-1.jsonl',
      updatedAt: 123,
    });
  });

  it('preserves structured external engine failure diagnostics', () => {
    expect(normalizeAgentEngineSession({
      kind: 'claude_code',
      failure: {
        category: 'auth',
        reason: 'auth_failed',
        message: 'Failed to authenticate. API Error: 401',
        suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录后重试。',
        retryable: false,
        occurredAt: 123456,
        statusCode: 401,
        exitCode: 1,
        reliability: {
          authState: 'needs_login',
          quotaState: 'available',
          cliStatus: 'available',
          toolSupport: 'workspace_tools',
        },
      },
    })).toMatchObject({
      kind: 'claude_code',
      failure: {
        category: 'auth',
        reason: 'auth_failed',
        message: 'Failed to authenticate. API Error: 401',
        suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录后重试。',
        retryable: false,
        occurredAt: 123456,
        statusCode: 401,
        exitCode: 1,
        reliability: {
          authState: 'needs_login',
          quotaState: 'available',
          cliStatus: 'available',
        },
      },
    });
  });

  it('drops malformed external engine failure diagnostics', () => {
    expect(normalizeAgentEngineSession({
      kind: 'codex_cli',
      failure: {
        category: 'auth',
        reason: '',
        message: 'missing suggestion',
      },
    })).toEqual({
      kind: 'codex_cli',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });
});

describe('Agent Engine registry helpers', () => {
  it('normalizes the first version output line', () => {
    expect(normalizeRegistryVersionOutput('\n codex-cli 0.130.0\nextra')).toBe('codex-cli 0.130.0');
  });
});

describe('Agent Engine cwd guard', () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-engine-guard-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'subdir'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'other'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('allows cwd inside the workspace', async () => {
    const cwd = path.join(workspaceRoot, 'subdir');
    await expect(fs.realpath(cwd)).resolves.toBe(assertWorkspaceCwd(cwd, workspaceRoot));
  });

  it('rejects cwd outside the workspace', () => {
    expect(() => assertWorkspaceCwd(path.join(tempDir, 'other'), workspaceRoot)).toThrow(/inside workspace/);
  });

  it('rejects symlink escapes from the workspace', async () => {
    const linkPath = path.join(workspaceRoot, 'escape');
    await fs.symlink(path.join(tempDir, 'other'), linkPath);
    expect(() => assertWorkspaceCwd(linkPath, workspaceRoot)).toThrow(/inside workspace/);
  });
});

describe('Agent Engine launch policy', () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-engine-policy-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    workspaceRoot = await fs.realpath(workspaceRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('selects external engines only for manual chat sessions and pins cwd as workspace root', () => {
    const selected = buildManualAgentEngineSelection(makeSession({ workingDirectory: workspaceRoot }), {
      kind: 'codex_cli',
      label: 'Codex CLI',
      summary: '',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      capabilities: ['execute'],
      defaultPermissionProfile: 'read_only',
      cwdPolicy: 'workspace_only',
      riskTier: 'medium',
      detectedAt: Date.now(),
    });

    expect(selected).toMatchObject({
      kind: 'codex_cli',
      cwd: workspaceRoot,
      permissionProfile: 'read_only',
      origin: 'manual',
    });
  });

  it('preserves selected external model through launch policy', () => {
    const selected = buildManualAgentEngineSelection(makeSession({ workingDirectory: workspaceRoot }), {
      kind: 'claude_code',
      label: 'Claude Code',
      summary: '',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      capabilities: ['execute'],
      defaultPermissionProfile: 'read_only',
      cwdPolicy: 'workspace_only',
      riskTier: 'medium',
      detectedAt: Date.now(),
    }, undefined, 'sonnet');

    expect(selected.model).toBe('sonnet');
    expect(resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot }),
      selected,
    ).model).toBe('sonnet');
  });

  it('rejects workspace-write external engine selection in the current release', () => {
    expect(() => buildManualAgentEngineSelection(makeSession({ workingDirectory: workspaceRoot }), {
      kind: 'codex_cli',
      label: 'Codex CLI',
      summary: '',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      capabilities: ['execute'],
      defaultPermissionProfile: 'workspace_write',
      cwdPolicy: 'workspace_only',
      riskTier: 'medium',
      detectedAt: Date.now(),
    })).toThrow(/read-only/);
  });

  it('blocks external launches from channel and read-only sessions even if metadata is polluted', () => {
    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot, origin: { kind: 'channel' } }),
      { kind: 'codex_cli', cwd: workspaceRoot, permissionProfile: 'read_only', origin: 'manual' },
    )).toThrow(/channel/);

    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot, readOnly: true }),
      { kind: 'codex_cli', cwd: workspaceRoot, permissionProfile: 'read_only', origin: 'manual' },
    )).toThrow(/read-only/);
  });

  it('blocks external launches from automation-style sessions', () => {
    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot, type: 'schedule', origin: { kind: 'cron' } }),
      { kind: 'codex_cli', cwd: workspaceRoot, permissionProfile: 'read_only', origin: 'manual' },
    )).toThrow(/only allowed for chat sessions/);

    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot, type: 'heartbeat', origin: { kind: 'heartbeat' } }),
      { kind: 'claude_code', cwd: workspaceRoot, permissionProfile: 'read_only', origin: 'manual' },
    )).toThrow(/only allowed for chat sessions/);
  });

  it('requires manual external engine selection at launch time', () => {
    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot }),
      { kind: 'codex_cli', cwd: workspaceRoot, permissionProfile: 'read_only', origin: 'import' },
    )).toThrow(/manual engine selection/);

    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot }),
      { kind: 'claude_code', cwd: workspaceRoot, permissionProfile: 'read_only', origin: 'external' },
    )).toThrow(/manual engine selection/);
  });

  it('requires read-only permission profile at launch time', () => {
    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot }),
      { kind: 'codex_cli', cwd: workspaceRoot, permissionProfile: 'workspace_write', origin: 'manual' },
    )).toThrow(/read-only/);

    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot }),
      { kind: 'claude_code', cwd: workspaceRoot, permissionProfile: 'default', origin: 'manual' },
    )).toThrow(/read-only/);
  });

  it('uses the session workspace as the launch boundary even when engine metadata is polluted', async () => {
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(outside, { recursive: true });

    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot }),
      { kind: 'codex_cli', cwd: outside, permissionProfile: 'read_only', origin: 'manual' },
      outside,
    )).toThrow(/inside workspace/);
  });

  it('rejects requested launch cwd outside the session workspace', async () => {
    const outside = path.join(tempDir, 'outside-requested');
    await fs.mkdir(outside, { recursive: true });

    expect(() => resolveExternalEngineLaunch(
      makeSession({ workingDirectory: workspaceRoot }),
      { kind: 'claude_code', cwd: workspaceRoot, permissionProfile: 'read_only', origin: 'manual' },
      outside,
    )).toThrow(/inside workspace/);
  });
});

describe('Codex CLI run timing', () => {
  it('uses conservative defaults', () => {
    expect(normalizeCodexCliRunTiming()).toEqual({
      stallWarningMs: 45_000,
      timeoutMs: DEFAULT_CODEX_CLI_TIMEOUT_MS,
    });
  });

  it('keeps stall warning below timeout', () => {
    expect(normalizeCodexCliRunTiming({ timeoutMs: 20_000, stallWarningMs: 60_000 })).toEqual({
      stallWarningMs: 19_000,
      timeoutMs: 20_000,
    });
  });

  it('enforces a minimum timeout', () => {
    expect(normalizeCodexCliRunTiming({ timeoutMs: 100, stallWarningMs: 50 }).timeoutMs).toBe(MIN_CODEX_CLI_TIMEOUT_MS);
  });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Session',
    modelConfig: { provider: 'openai', model: 'gpt-5' } as Session['modelConfig'],
    type: 'chat',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
