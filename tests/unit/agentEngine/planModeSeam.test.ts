import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message, PermissionRequest, Session } from '../../../src/shared/contract';
import {
  externalProfileCeilingForSessionMode,
  type AgentEngineKind,
  type AgentEngineSessionMetadata,
  type ExternalAgentEngineKind,
} from '../../../src/shared/contract/agentEngine';
import type { ConfigService } from '../../../src/host/services/core/configService';
import type { SubagentExecutionRequest } from '../../../src/host/agent/subagentExecutorTypes';
import { WORKTREE_BASE_DIR } from '../../../src/host/agent/agentWorktreePath';

const SESSION = 'planexit-k3-seam';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  getLogsPath: vi.fn(),
  addMessageToSession: vi.fn(),
  updateSession: vi.fn(),
  upsertTask: vi.fn(),
  appendEvent: vi.fn(),
  registryGet: vi.fn(),
  dbReady: true,
  dbThrows: false,
  recentThrows: false,
  messages: [] as Message[],
  getRecentMessages: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mocks.spawn(...args),
  };
});

vi.mock('../../../src/host/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/platform')>();
  return {
    ...actual,
    getLogsPath: () => mocks.getLogsPath(),
  };
});

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: mocks.addMessageToSession,
    updateSession: mocks.updateSession,
    getMessages: vi.fn(async () => []),
    getCurrentSessionId: () => SESSION,
  }),
}));

vi.mock('../../../src/host/task/backgroundTaskLedger', () => ({
  getBackgroundTaskLedger: () => ({
    upsertTask: mocks.upsertTask,
    appendEvent: mocks.appendEvent,
    addOutputRef: vi.fn(),
    queueNotification: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/agentEngine/agentEngineRegistry', () => ({
  getAgentEngineRegistry: () => ({
    get: mocks.registryGet,
  }),
}));

vi.mock('../../../src/host/services/infra/shellEnvironment', () => ({
  getShellPath: () => '/usr/bin:/bin',
  getShellEnvironmentValue: () => undefined,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (mocks.dbThrows) throw new Error('database unavailable');
    return {
      get isReady() { return mocks.dbReady; },
      getRecentMessages: (sessionId: string, count: number) => {
        mocks.getRecentMessages(sessionId, count);
        if (mocks.recentThrows) throw new Error('database unavailable');
        return mocks.messages;
      },
      getPendingApprovalRepo: () => {
        throw new Error('pending approval repo unused');
      },
    };
  },
}));

import { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import { ExternalEngineSubagentExecutor } from '../../../src/host/agent/externalEngineSubagentExecutor';
import { getExternalEngineAdapter } from '../../../src/host/services/agentEngine/agentEngineAdapterRegistry';
import { resolveExternalEngineLaunch } from '../../../src/host/services/agentEngine/agentEngineGuards';
import {
  getPermissionModeManager,
  resetPermissionModeManager,
  type PermissionMode,
} from '../../../src/host/permissions/modes';

function permissionCards(events: AgentEvent[]): PermissionRequest[] {
  return events.flatMap((event) => (event.type === 'permission_request' ? [event.data] : []));
}

function planCard(
  status: 'pending' | 'starting' | 'approved' | 'failed' | 'cancelled' | 'revision_requested',
  source?: 'model_exit' | 'synthetic_text',
): Message {
  const plan = '1. Read the host boundary';
  return {
    id: 'message-plan',
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolCalls: [{
      id: 'tool-plan',
      name: 'exit_plan_mode',
      arguments: { plan },
      result: {
        toolCallId: 'tool-plan',
        success: true,
        metadata: {
          confirmationType: 'plan_approval',
          plan,
          planApproval: {
            status,
            originalPlan: plan,
            steps: [{ id: 'step-1', content: 'Read the host boundary', originalContent: 'Read the host boundary' }],
            ...(source ? { source } : {}),
          },
        },
      },
    }],
  };
}

function createMockChild(stdoutLines: string[], exitCode: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.exitCode = null;
  child.pid = 4242;
  child.kill = vi.fn(() => {
    child.exitCode = 1;
    setImmediate(() => child.emit('close', 1));
    return true;
  });
  setImmediate(() => {
    for (const line of stdoutLines) child.stdout.emit('data', Buffer.from(`${line}\n`));
    child.exitCode = exitCode;
    child.emit('close', exitCode);
  });
  return child;
}

function spawnedArgs(): string[] {
  const args = mocks.spawn.mock.calls.at(-1)?.[1];
  expect(args).toEqual(expect.any(Array));
  return args as string[];
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

describe('external engine plan-mode write-back', () => {
  let orchestrator: AgentOrchestrator;
  let events: AgentEvent[];

  beforeEach(() => {
    resetPermissionModeManager();
    events = [];
    mocks.dbReady = true;
    mocks.dbThrows = false;
    mocks.recentThrows = false;
    mocks.messages = [];
    mocks.getRecentMessages.mockClear();
    const configService = {
      getSettings: () => ({
        permissions: {
          autoApprove: { read: false, write: false, execute: false, network: false },
          devModeAutoApprove: false,
        },
      }),
      isDevModeAutoApproveEnabled: () => false,
    } as unknown as ConfigService;
    orchestrator = new AgentOrchestrator({
      configService,
      hasApprovalUi: () => true,
      onEvent: (event) => { events.push(event); },
    });
  });

  afterEach(async () => {
    for (const pending of orchestrator.getPendingPermissionRequests()) {
      orchestrator.handlePermissionResponse(pending.id, 'deny');
    }
    await orchestrator.drainWorkspaceServices();
    resetPermissionModeManager();
  });

  function setMode(mode: PermissionMode): void {
    expect(getPermissionModeManager().setSessionMode(SESSION, mode, true)).toBe(true);
  }

  function writeRequest(type: 'file_write' | 'command' | 'file_read') {
    return {
      sessionId: SESSION,
      type,
      tool: type === 'command' ? 'acp:terminal/create' : 'acp:fs/write_text_file',
      details: { path: '/tmp/planexit-k3.txt', command: type === 'command' ? 'true' : undefined },
    };
  }

  async function expectFailClosed(type: 'file_write' | 'command'): Promise<void> {
    const before = permissionCards(events).length;
    const pendingBefore = orchestrator.getPendingPermissionRequests().length;
    const pending = orchestrator.requestExternalEnginePermission(writeRequest(type));
    await Promise.resolve();
    expect(permissionCards(events).length).toBe(before);
    expect(orchestrator.getPendingPermissionRequests().length).toBe(pendingBefore);
    await expect(pending).resolves.toEqual({ approved: false, denialSource: 'fail-closed' });
  }

  async function expectApprovalChain(type: 'file_write' | 'command' | 'file_read'): Promise<void> {
    const before = permissionCards(events).length;
    const pending = orchestrator.requestExternalEnginePermission(writeRequest(type));
    await Promise.resolve();
    const cards = permissionCards(events);
    expect(cards.length).toBe(before + 1);
    expect(orchestrator.getPendingPermissionRequests().length).toBeGreaterThan(0);
    const card = cards[cards.length - 1];
    if (!card) throw new Error('missing permission_request');
    orchestrator.handlePermissionResponse(card.id, 'deny');
    await expect(pending).resolves.toMatchObject({ approved: false, denialSource: 'user' });
  }

  it('plan mode denies engine file writes and commands with no card and no pending entry', async () => {
    setMode('plan');
    await expectFailClosed('file_write');
    await expectFailClosed('command');
  });

  it('plan mode still asks before a file read', async () => {
    setMode('plan');
    await expectApprovalChain('file_read');
  });

  it.each(['model_exit', 'synthetic_text'] as const)(
    'a pending %s plan card denies an engine file_write without an approval card',
    async (source) => {
      setMode('default');
      mocks.messages = [planCard('pending', source)];
      await expectFailClosed('file_write');
      expect(mocks.getRecentMessages).toHaveBeenCalledWith(SESSION, 20);
    },
  );

  it('a pending plan card denies an engine command the same way', async () => {
    setMode('default');
    mocks.messages = [planCard('pending', 'model_exit')];
    await expectFailClosed('command');
  });

  it('a failed plan card is still retryable and denies write-back', async () => {
    setMode('default');
    mocks.messages = [planCard('failed', 'synthetic_text')];
    await expectFailClosed('file_write');
  });

  it('a pending plan card does not deny a file read', async () => {
    setMode('default');
    mocks.messages = [planCard('pending', 'model_exit')];
    await expectApprovalChain('file_read');
  });

  it('no plan card and mode default reaches the approval chain', async () => {
    setMode('default');
    await expectApprovalChain('file_write');
  });

  it.each(['approved', 'cancelled'] as const)(
    'a %s plan card reaches the approval chain',
    async (status) => {
      setMode('default');
      mocks.messages = [planCard(status, 'model_exit')];
      await expectApprovalChain('file_write');
    },
  );

  it('an unavailable database fail-opens write-back onto the approval chain', async () => {
    setMode('default');
    mocks.dbReady = false;
    mocks.messages = [planCard('pending', 'synthetic_text')];
    await expectApprovalChain('file_write');
    expect(mocks.getRecentMessages).not.toHaveBeenCalled();
  });

  it('a database throw fail-opens write-back onto the approval chain', async () => {
    setMode('default');
    mocks.dbThrows = true;
    mocks.messages = [planCard('pending', 'model_exit')];
    await expectApprovalChain('file_write');
  });
});

describe('external engine plan session launch args', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let worktreePath: string;
  let outsidePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetPermissionModeManager();
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'planexit-k3-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    await fsp.mkdir(workspaceRoot, { recursive: true });
    await fsp.mkdir(WORKTREE_BASE_DIR, { recursive: true });
    worktreePath = await fsp.mkdtemp(path.join(WORKTREE_BASE_DIR, 'planexit-k3-'));
    outsidePath = await fsp.mkdtemp(path.join(path.dirname(WORKTREE_BASE_DIR), 'planexit-k3-outside-'));
    mocks.getLogsPath.mockReturnValue(path.join(tempDir, 'logs'));
    mocks.registryGet.mockImplementation(async (kind: AgentEngineKind) => ({
      kind,
      label: kind,
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      binaryPath: '/opt/homebrew/bin/engine',
      capabilities: ['execute', 'stream_events', 'resume', 'workspace_write'],
    }));
    mocks.addMessageToSession.mockResolvedValue(undefined);
    mocks.updateSession.mockResolvedValue(undefined);
    mocks.spawn.mockImplementation(() => createMockChild([
      JSON.stringify({ type: 'message_delta', delta: 'ok' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ], 0));
  });

  afterEach(async () => {
    resetPermissionModeManager();
    await fsp.rm(tempDir, { recursive: true, force: true });
    await fsp.rm(worktreePath, { recursive: true, force: true });
    await fsp.rm(outsidePath, { recursive: true, force: true });
  });

  function setMode(mode: PermissionMode): void {
    expect(getPermissionModeManager().setSessionMode(SESSION, mode, true)).toBe(true);
  }

  async function launchTopLevel(kind: 'codex_cli' | 'claude_code'): Promise<string[]> {
    const session = {
      id: SESSION,
      title: 'plan seam',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      workingDirectory: workspaceRoot,
      type: 'chat',
      createdAt: 1,
      updatedAt: 1,
    } as Session;
    const engine: AgentEngineSessionMetadata = {
      kind,
      permissionProfile: 'read_only',
      origin: 'manual',
    };
    const launch = resolveExternalEngineLaunch(session, engine, workspaceRoot);
    expect(externalProfileCeilingForSessionMode(getPermissionModeManager().getModeForSession(SESSION))).toBe('read_only');
    expect(launch.permissionProfile).toBe('read_only');
    await getExternalEngineAdapter(kind).run({
      sessionId: SESSION,
      prompt: 'inspect only',
      cwd: launch.cwd,
      workspaceRoot: launch.workspaceRoot,
      permissionProfile: launch.permissionProfile,
      emitEvent: () => undefined,
    });
    return spawnedArgs();
  }

  async function launchSubagent(kind: ExternalAgentEngineKind, cwd: string): Promise<string[]> {
    mocks.spawn.mockClear();
    const result = await new ExternalEngineSubagentExecutor().execute(makeRequest(kind, cwd));
    expect(result.success).toBe(true);
    return spawnedArgs();
  }

  it('plan mode launches codex and claude top-level runs read-only', async () => {
    setMode('plan');
    expect(flagValue(await launchTopLevel('codex_cli'), '--sandbox')).toBe('read-only');
    mocks.spawn.mockClear();
    expect(flagValue(await launchTopLevel('claude_code'), '--permission-mode')).toBe('plan');
  });

  it('plan mode launches a worktree subagent read-only for codex and claude', async () => {
    setMode('plan');
    expect(flagValue(await launchSubagent('codex_cli', worktreePath), '--sandbox')).toBe('read-only');
    expect(flagValue(await launchSubagent('claude_code', worktreePath), '--permission-mode')).toBe('plan');
  });

  it('acceptEdits launches a worktree subagent with workspace write flags', async () => {
    setMode('acceptEdits');
    expect(flagValue(await launchSubagent('codex_cli', worktreePath), '--sandbox')).toBe('workspace-write');
    expect(flagValue(await launchSubagent('claude_code', worktreePath), '--permission-mode')).toBe('acceptEdits');
  });

  it('a cwd outside a worktree stays read-only even in acceptEdits', async () => {
    setMode('acceptEdits');
    expect(flagValue(await launchSubagent('codex_cli', outsidePath), '--sandbox')).toBe('read-only');
    expect(flagValue(await launchSubagent('claude_code', outsidePath), '--permission-mode')).toBe('plan');
  });
});

describe('no second session-mode translation under agent engines', () => {
  const engineDir = path.resolve(process.cwd(), 'src/host/services/agentEngine');

  it('only the two profile mappers mention engine permission flags, and session mode is not re-translated', () => {
    const violations = sessionModeTranslationViolations(engineDir);
    expect(violations).toEqual([]);
  });
});

function sessionModeTranslationViolations(engineDir: string): string[] {
  const violations: string[] = [];
  for (const file of listTypeScriptFiles(engineDir)) {
    const raw = fs.readFileSync(file, 'utf8');
    const text = stripProfileMappers(raw);
    const rel = path.relative(engineDir, file);
    if (text.includes('permissions/modes')) violations.push(`${rel}: imports permissions/modes`);
    if (text.includes('getPermissionModeManager')) violations.push(`${rel}: references getPermissionModeManager`);
    if (text.includes('bypassPermissions')) violations.push(`${rel}: references bypassPermissions as a session mode`);
    if (text.includes('acceptEdits')) violations.push(`${rel}: references acceptEdits as a session mode`);
    if (/switch\s*\(\s*sessionMode\s*\)/.test(text)) violations.push(`${rel}: local switch (sessionMode) table`);
  }
  return violations;
}

function stripProfileMappers(source: string): string {
  return source
    .replace(/export function toClaudePermissionMode\b[\s\S]*?\n\}/g, '')
    .replace(/function toCodexSandbox\b[\s\S]*?\n\}/g, '');
}

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTypeScriptFiles(full));
    else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function makeRequest(engine: ExternalAgentEngineKind, cwd: string): SubagentExecutionRequest {
  return {
    prompt: 'inspect only',
    config: {
      name: 'seam-agent',
      engine,
      systemPrompt: 'system',
      availableTools: [],
    },
    context: {
      sessionId: SESSION,
      cwd,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      resolver: { getDefinition: () => undefined },
      permission: { request: async () => false },
      events: { emit: () => undefined },
      abortSignal: new AbortController().signal,
      executionAgentId: 'agent-1',
    },
  } as SubagentExecutionRequest;
}
