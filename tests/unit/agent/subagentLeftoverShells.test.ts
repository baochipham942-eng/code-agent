import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

type BackgroundTasks = typeof import('../../../src/host/tools/shell/backgroundTasks');
type ProtocolRegistry = ReturnType<typeof import('../../../src/host/tools/protocolRegistry').getProtocolRegistry>;

type FakeModelMode = 'complete' | 'http-error';

interface FakeModel {
  url: string;
  close(): Promise<void>;
}

interface RunInput {
  agentId: string;
  command: string;
  mode: FakeModelMode;
  abortOnTaskStart?: boolean;
}

let root: string;
let dataDir: string;
let cwd: string;
let backgroundTasks: BackgroundTasks;
let registry: ProtocolRegistry;
let SubagentExecutor: typeof import('../../../src/host/agent/subagentExecutor').SubagentExecutor;
let getConfigService: typeof import('../../../src/host/services/core/configService').getConfigService;
let getSystemPromptHint: typeof import('../../../src/shared/i18n/sessionTaskSlot').getSystemPromptHint;
let handoverTimedOutCommand: typeof import('../../../src/host/tools/shell/timeoutHandover').handoverTimedOutCommand;
let consoleError: MockInstance<typeof console.error>;
const taskIds = new Set<string>();
const processGroups = new Set<number>();

function startFakeModel(args: Record<string, unknown>, mode: FakeModelMode): Promise<FakeModel> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        const hasToolResult = body.includes('"role":"tool"');
        if (hasToolResult && mode === 'http-error') {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { message: 'scripted model failure', type: 'invalid_request_error' } }));
          return;
        }
        const message = !hasToolResult
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'Bash', arguments: JSON.stringify(args) },
              }],
            }
          : mode === 'complete'
            ? { role: 'assistant', content: 'The requested command was started.' }
            : { role: 'assistant', content: '' };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'scripted-model-response',
          object: 'chat.completion',
          created: 1,
          model: 'glm-5.3',
          choices: [{
            index: 0,
            message,
            finish_reason: !hasToolResult ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Scripted model did not bind a TCP port');
      resolve({
        url: `http://127.0.0.1:${address.port}/v4`,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}

function recordTask(taskId: string): void {
  taskIds.add(taskId);
  const pid = backgroundTasks.getBackgroundTask(taskId)?.process.pid;
  if (pid !== undefined) processGroups.add(pid);
}

function taskForOwner(ownerAgentId: string) {
  return backgroundTasks.getAllBackgroundTasks().find(
    (task) => task.status === 'running' && task.ownerAgentId === ownerAgentId,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pgrepProcessGroup(pid: number): string {
  try {
    return execFileSync('/usr/bin/pgrep', ['-g', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function setLocale(language: 'zh' | 'en'): Promise<void> {
  const config = getConfigService();
  const current = config.getSettings();
  await config.updateSettings({ ui: { ...current.ui, language } });
}

function warnsFor(taskId: string, reason: string): unknown[][] {
  return consoleError.mock.calls.filter((call) => (
    String(call[0]).includes('WARN [SubagentLeftoverShells]')
    && String(call[0]).includes('background shell still running')
    && (call[1] as { taskId?: string } | undefined)?.taskId === taskId
    && (call[1] as { reason?: string } | undefined)?.reason === reason
  ));
}

async function runAgent(input: RunInput) {
  const fake = await startFakeModel(
    { command: input.command, run_in_background: true },
    input.mode,
  );
  const abortController = new AbortController();
  const stopListening = backgroundTasks.onBackgroundTaskLifecycleEvent((event) => {
    if (event.type !== 'started' || event.task.ownerAgentId !== input.agentId) return;
    recordTask(event.task.taskId);
    if (input.abortOnTaskStart) abortController.abort('user-cancel');
  });
  try {
    return await new SubagentExecutor().execute({
      prompt: 'Start the requested background command exactly once, then finish.',
      config: {
        name: `leftover-${input.agentId}`,
        systemPrompt: 'You are a terse shell worker.',
        availableTools: ['Bash'],
        maxIterations: 6,
        maxExecutionTimeMs: 30_000,
        permissionPreset: 'development',
      },
      context: {
        sessionId: `session-${input.agentId}`,
        executionAgentId: input.agentId,
        cwd,
        workspace: cwd,
        modelConfig: {
          provider: 'zhipu',
          model: 'glm-5.3',
          apiKey: 'scripted-test-key',
          baseUrl: fake.url,
          temperature: 0,
        },
        resolver: {
          getDefinition: (name) => {
            const schema = registry.getSchemas().find((candidate) => candidate.name === name);
            return schema ? {
              name: schema.name,
              description: schema.description,
              inputSchema: schema.inputSchema,
              outputSchema: schema.outputSchema,
              requiresPermission: schema.requiresPermission ?? false,
              permissionLevel: schema.permissionLevel === 'dangerous' ? 'execute' : schema.permissionLevel,
              readOnly: schema.readOnly,
              touchesWorkDirectory: schema.touchesWorkDirectory,
            } : undefined;
          },
        },
        permission: { request: async () => true },
        events: { emit: () => {} },
        abortSignal: abortController.signal,
      },
    });
  } finally {
    stopListening();
    await fake.close();
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'subagent-leftover-shells-'));
  dataDir = path.join(root, 'data');
  cwd = path.join(root, 'work');
  await mkdir(dataDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  vi.stubEnv('CODE_AGENT_HOME', root);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
  vi.stubEnv('CODE_AGENT_LOG_DIR', path.join(root, 'logs'));
  backgroundTasks = await import('../../../src/host/tools/shell/backgroundTasks');
  process.removeListener('beforeExit', backgroundTasks.persistRunningTasks);
  registry = (await import('../../../src/host/tools/protocolRegistry')).getProtocolRegistry();
  ({ SubagentExecutor } = await import('../../../src/host/agent/subagentExecutor'));
  ({ getConfigService } = await import('../../../src/host/services/core/configService'));
  ({ getSystemPromptHint } = await import('../../../src/shared/i18n/sessionTaskSlot'));
  ({ handoverTimedOutCommand } = await import('../../../src/host/tools/shell/timeoutHandover'));
}, 60_000);

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const taskId of taskIds) {
    const state = backgroundTasks.getBackgroundTask(taskId);
    if (state?.status === 'running') await backgroundTasks.killBackgroundTask(taskId);
  }
  for (const pid of processGroups) {
    await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false), { timeout: 5_000, interval: 50 });
    const pgrep = pgrepProcessGroup(pid);
    console.log(`[cleanup] pgrep -g ${pid}: ${pgrep || 'empty'}`);
    expect(pgrep).toBe('');
  }
  taskIds.clear();
  processGroups.clear();
  backgroundTasks.cleanupCompletedTasks();
  backgroundTasks.clearPersistedTasks();
  consoleError.mockRestore();
});

afterAll(async () => {
  backgroundTasks.stopBackgroundTaskCleanupTimer();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe.sequential('subagent leftover background shells', () => {
  it('completed terminal reports its real Bash child, excludes main/user tasks, and persists the owner', async () => {
    await setLocale('en');
    const main = backgroundTasks.startBackgroundTask('sleep 7330', cwd, 60_000, {
      sessionId: 'main-session',
      ownerAgentId: 'primary',
    });
    const userBackgrounded = backgroundTasks.startBackgroundTask('sleep 7331', cwd, 60_000, {
      sessionId: 'main-session',
    });
    expect(main.success).toBe(true);
    expect(userBackgrounded.success).toBe(true);
    recordTask(main.taskId!);
    recordTask(userBackgrounded.taskId!);

    const result = await runAgent({
      agentId: 'completed-agent',
      command: 'sleep 7332',
      mode: 'complete',
    });
    const owned = taskForOwner('completed-agent');
    expect(result.success).toBe(true);
    expect(owned).toBeDefined();
    expect(result.output).toContain(owned!.taskId);
    expect(result.output).toContain('sleep 7332');
    expect(result.output).toContain('running 1 second');
    expect(result.output).toContain('Still running — can be stopped manually.');
    expect(result.output).not.toContain(main.taskId!);
    expect(result.output).not.toContain(userBackgrounded.taskId!);
    const ownedPid = backgroundTasks.getBackgroundTask(owned!.taskId)?.process.pid;
    expect(ownedPid).toEqual(expect.any(Number));
    expect(isProcessAlive(ownedPid!)).toBe(true);
    expect(backgroundTasks.getAllBackgroundTasks().find((task) => task.taskId === main.taskId)?.ownerAgentId).toBeUndefined();
    expect(backgroundTasks.getAllBackgroundTasks().find((task) => task.taskId === userBackgrounded.taskId)?.ownerAgentId).toBeUndefined();

    backgroundTasks.persistRunningTasks();
    const persisted = JSON.parse(await readFile(path.join(dataDir, 'background-tasks.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(persisted.find((task) => task.taskId === owned!.taskId)?.ownerAgentId).toBe('completed-agent');
    expect(persisted.find((task) => task.taskId === main.taskId)).not.toHaveProperty('ownerAgentId');
    expect(persisted.find((task) => task.taskId === userBackgrounded.taskId)).not.toHaveProperty('ownerAgentId');
    expect(backgroundTasks.loadPersistedTasks()).toContainEqual(expect.objectContaining({
      taskId: owned!.taskId,
      ownerAgentId: 'completed-agent',
      status: 'failed',
    }));
    const warnings = warnsFor(owned!.taskId, 'completed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({
      agentId: 'completed-agent',
      taskId: owned!.taskId,
      pid: expect.any(Number),
      reason: 'completed',
    });
    console.log(`RAW WARN ${JSON.stringify(warnings[0]?.[1])}`);
    console.log(`RAW EN REPORT\n${result.output}`);
  }, 20_000);

  it('reuses the permission-prompt predicate and exact Chinese hint copy', async () => {
    await setLocale('zh');
    const result = await runAgent({
      agentId: 'system-prompt-agent',
      command: `sleep 7333 # osascript ${'x'.repeat(100)}`,
      mode: 'complete',
    });
    const owned = taskForOwner('system-prompt-agent');
    expect(owned).toBeDefined();
    expect(result.output).toContain(getSystemPromptHint('zh'));
    expect(result.output).toContain('sleep 7333 # osascript');
    expect(result.output).toContain('仍在运行，可手动停止。');
    const summary = /^- `([^`]+)`/m.exec(result.output)?.[1];
    expect(summary?.length).toBeLessThanOrEqual(80);
    const ownedPid = backgroundTasks.getBackgroundTask(owned!.taskId)?.process.pid;
    expect(ownedPid).toEqual(expect.any(Number));
    expect(isProcessAlive(ownedPid!)).toBe(true);
    console.log(`RAW ZH REPORT\n${result.output}`);
  }, 20_000);

  it('failed terminal returns the still-running child report without killing it', async () => {
    await setLocale('en');
    let thrown: unknown;
    try {
      await runAgent({
        agentId: 'failed-agent',
        command: 'sleep 7334',
        mode: 'http-error',
      });
    } catch (error) {
      thrown = error;
    }
    const owned = taskForOwner('failed-agent');
    expect(owned).toBeDefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(owned!.taskId);
    expect((thrown as Error).message).toContain('Still running — can be stopped manually.');
    const ownedPid = backgroundTasks.getBackgroundTask(owned!.taskId)?.process.pid;
    expect(ownedPid).toEqual(expect.any(Number));
    expect(isProcessAlive(ownedPid!)).toBe(true);
    const warnings = warnsFor(owned!.taskId, 'failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({ pid: expect.any(Number) });
    console.log(`RAW FAILED REPORT\n${(thrown as Error).message}`);
  }, 20_000);

  it('cancelled terminal returns the still-running child report without killing it', async () => {
    await setLocale('en');
    const result = await runAgent({
      agentId: 'cancelled-agent',
      command: 'sleep 7335',
      mode: 'complete',
      abortOnTaskStart: true,
    });
    const owned = taskForOwner('cancelled-agent');
    expect(result.success).toBe(false);
    expect(result.cancellationReason).toBe('user-cancel');
    expect(owned).toBeDefined();
    expect(result.output).toContain(owned!.taskId);
    expect(result.output).toContain('Still running — can be stopped manually.');
    const ownedPid = backgroundTasks.getBackgroundTask(owned!.taskId)?.process.pid;
    expect(ownedPid).toEqual(expect.any(Number));
    expect(isProcessAlive(ownedPid!)).toBe(true);
    const warnings = warnsFor(owned!.taskId, 'cancelled');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({ pid: expect.any(Number) });
    console.log(`RAW CANCELLED REPORT\n${result.output}`);
  }, 20_000);

  it('early-failure terminal appends the report before any model iteration', async () => {
    await setLocale('en');
    const started = backgroundTasks.startBackgroundTask('sleep 7336', cwd, 60_000, {
      ownerAgentId: 'early-failure-agent',
    });
    expect(started.success).toBe(true);
    recordTask(started.taskId!);
    const result = await new SubagentExecutor().execute({
      prompt: 'This run must fail during tool assembly.',
      config: {
        name: 'early-failure-agent',
        systemPrompt: 'No model call should occur.',
        availableTools: ['DefinitelyMissingTool'],
      },
      context: {
        sessionId: 'session-early-failure-agent',
        executionAgentId: 'early-failure-agent',
        cwd,
        modelConfig: { provider: 'zhipu', model: 'glm-5.3', apiKey: 'unused' },
        resolver: { getDefinition: () => undefined },
        permission: { request: async () => true },
        events: { emit: () => {} },
        abortSignal: new AbortController().signal,
      },
    });
    expect(result.success).toBe(false);
    expect(result.iterations).toBe(0);
    expect(result.output).toContain(started.taskId!);
    const ownedPid = backgroundTasks.getBackgroundTask(started.taskId!)?.process.pid;
    expect(ownedPid).toEqual(expect.any(Number));
    expect(isProcessAlive(ownedPid!)).toBe(true);
    const warnings = warnsFor(started.taskId!, 'early-failure');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({ pid: expect.any(Number) });
  }, 20_000);

  it('foreground-timeout adoption carries the same owning agent field', async () => {
    const child = spawn('bash', ['-c', 'sleep 7337'], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const adopted = handoverTimedOutCommand({
      child,
      command: 'sleep 7337',
      cwd,
      ownerAgentId: 'timeout-owner-agent',
      stdout: '',
      stderr: '',
      startedAt: Date.now(),
    });
    expect(adopted).not.toBeNull();
    recordTask(adopted!.taskId);
    expect(backgroundTasks.getAllBackgroundTasks().find((task) => task.taskId === adopted!.taskId))
      .toMatchObject({ ownerAgentId: 'timeout-owner-agent', status: 'running' });
  });
});
