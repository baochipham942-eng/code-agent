import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execToolCommand } from '../../../src/cli/commands/execTool';
import { exportCommand } from '../../../src/cli/commands/export';
import { initSoulCommand } from '../../../src/cli/commands/initSoul';
import { listAgentsCommand } from '../../../src/cli/commands/listAgents';
import { listToolsCommand } from '../../../src/cli/commands/listTools';
import { openchronicleCommand } from '../../../src/cli/commands/openchronicleCmd';
import { runCommand } from '../../../src/cli/commands/run';

const mocks = vi.hoisted(() => ({
  runToolDirectly: vi.fn(),
  listDefinitions: vi.fn(),
  getProtocolRegistry: vi.fn(),
  initAgentRegistry: vi.fn(),
  listAllAgents: vi.fn(),
  disposeAgentRegistry: vi.fn(),
  setEnabled: vi.fn(),
  getStatus: vi.fn(),
  loadSettings: vi.fn(),
  createCLIAgent: vi.fn(),
  initializeCLIServices: vi.fn(),
  cleanup: vi.fn(),
  getDatabaseService: vi.fn(),
  terminalOutput: {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    startThinking: vi.fn(),
    stopThinking: vi.fn(),
    success: vi.fn(),
  },
  jsonOutput: {
    start: vi.fn(),
    result: vi.fn(),
    error: vi.fn(),
  },
  transcriptExporterConstructor: vi.fn(),
  exportTranscript: vi.fn(),
  exportTranscriptToFile: vi.fn(),
  sessionLocalCacheConstructor: vi.fn(),
  cacheSetSession: vi.fn(),
}));

vi.mock('../../../src/cli/commands/_runToolDirectly', () => ({
  runToolDirectly: mocks.runToolDirectly,
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ listDefinitions: mocks.listDefinitions }),
}));

vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: mocks.getProtocolRegistry,
}));

vi.mock('../../../src/host/agent/agentRegistry', () => ({
  initAgentRegistry: mocks.initAgentRegistry,
  listAllAgents: mocks.listAllAgents,
  disposeAgentRegistry: mocks.disposeAgentRegistry,
}));

vi.mock('../../../src/host/services/external/openchronicleSupervisor', () => ({
  setEnabled: mocks.setEnabled,
  getStatus: mocks.getStatus,
  loadSettings: mocks.loadSettings,
}));

vi.mock('../../../src/cli/adapter', () => ({
  createCLIAgent: mocks.createCLIAgent,
}));

vi.mock('../../../src/cli/bootstrap', () => ({
  initializeCLIServices: mocks.initializeCLIServices,
  cleanup: mocks.cleanup,
  getDatabaseService: mocks.getDatabaseService,
}));

vi.mock('../../../src/cli/output', () => ({
  terminalOutput: mocks.terminalOutput,
  jsonOutput: mocks.jsonOutput,
}));

vi.mock('../../../src/host/session/localCache', () => ({
  SessionLocalCache: vi.fn(function SessionLocalCache(options: unknown) {
    mocks.sessionLocalCacheConstructor(options);
    return {
      setSession: mocks.cacheSetSession,
    };
  }),
}));

vi.mock('../../../src/host/session/transcriptExporter', () => ({
  TranscriptExporter: vi.fn(function TranscriptExporter(options: unknown) {
    mocks.transcriptExporterConstructor(options);
    return {
      exportTranscript: mocks.exportTranscript,
      exportTranscriptToFile: mocks.exportTranscriptToFile,
    };
  }),
}));

describe('CLI command entrypoints', () => {
  const tempDirs: string[] = [];
  const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  beforeEach(() => {
    (runCommand as unknown as { parent?: Command }).parent = undefined;
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function' && 'mockReset' in mock) {
        mock.mockReset();
      }
    }
    for (const mock of Object.values(mocks.terminalOutput)) {
      mock.mockReset();
    }
    for (const mock of Object.values(mocks.jsonOutput)) {
      mock.mockReset();
    }
    mocks.cleanup.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (stdinIsTTYDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-commands-test-'));
    tempDirs.push(dir);
    return dir;
  }

  function mockProcessIO(): { stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];

    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(' '));
    });

    return { stdout, stderr };
  }

  function forceTtyStdin(): void {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
  }

  it('exec-tool forwards tool options and global CLI options', async () => {
    const program = new Command();
    program.exitOverride();
    program
      .option('-p, --project <path>')
      .option('--json')
      .option('--debug')
      .addCommand(execToolCommand);

    await program.parseAsync([
      'node',
      'agent-neo',
      '--project',
      '/workspace',
      '--debug',
      'exec-tool',
      'Read',
      '--params',
      '{"path":"README.md"}',
      '--session',
      'sess-1',
    ]);

    expect(mocks.runToolDirectly).toHaveBeenCalledWith(
      'Read',
      {
        params: '{"path":"README.md"}',
        session: 'sess-1',
      },
      expect.objectContaining({
        project: '/workspace',
        debug: true,
      }),
    );
  });

  it('list-tools initializes protocol tools and prints compact JSON definitions', async () => {
    const { stdout } = mockProcessIO();
    mocks.listDefinitions.mockReturnValue([
      {
        name: 'Read',
        description: 'Read a file',
        tags: ['filesystem'],
        inputSchema: {
          properties: {
            path: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['path'],
        },
      },
      {
        name: 'Ping',
        description: 'Ping service',
        inputSchema: {},
      },
    ]);

    await listToolsCommand.parseAsync(['node', 'list-tools'], { from: 'node' });

    expect(mocks.getProtocolRegistry).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed).toEqual([
      {
        name: 'Read',
        description: 'Read a file',
        category: 'filesystem',
        params: [
          { n: 'path', t: 'string', required: true },
          { n: 'limit', t: 'number', required: false },
        ],
      },
      {
        name: 'Ping',
        description: 'Ping service',
        category: 'unknown',
        params: [],
      },
    ]);
  });

  it('list-agents initializes and disposes the agent registry around JSON output', async () => {
    const { stdout } = mockProcessIO();
    mocks.listAllAgents.mockReturnValue([
      {
        id: 'planner',
        name: 'Planner',
        description: 'Plans tasks',
        source: 'builtin',
        modelTier: 'smart',
        readonly: true,
        tools: ['Read'],
      },
    ]);
    mocks.disposeAgentRegistry.mockResolvedValue(undefined);

    await listAgentsCommand.parseAsync(['node', 'list-agents', '--working-dir', '/workspace'], { from: 'node' });

    expect(mocks.initAgentRegistry).toHaveBeenCalledWith('/workspace');
    expect(mocks.disposeAgentRegistry).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.join(''))).toEqual([
      {
        id: 'planner',
        name: 'Planner',
        description: 'Plans tasks',
        source: 'builtin',
        modelTier: 'smart',
        readonly: true,
        tools: ['Read'],
      },
    ]);
  });

  it('openchronicle status and on commands report supervisor state', async () => {
    const { stdout } = mockProcessIO();
    mocks.loadSettings.mockResolvedValue({ enabled: true });
    mocks.getStatus.mockResolvedValue({
      state: 'running',
      pid: 123,
      mcpHealthy: true,
      bufferFiles: 2,
      memoryEntries: 8,
    });
    mocks.setEnabled.mockResolvedValue({ ok: true });

    await openchronicleCommand.parseAsync(['node', 'openchronicle', 'status'], { from: 'node' });
    await openchronicleCommand.parseAsync(['node', 'openchronicle', 'on'], { from: 'node' });

    expect(stdout.join('\n')).toContain('Toggle:        ON');
    expect(stdout.join('\n')).toContain('Daemon state:  running');
    expect(stdout.join('\n')).toContain('PID:           123');
    expect(stdout.join('\n')).toContain('MCP healthy:   yes');
    expect(stdout.join('\n')).toContain('屏幕记忆已开启');
    expect(mocks.setEnabled).toHaveBeenCalledWith(true);
  });

  it('init-soul creates a project PROFILE.md without touching the user SOUL.md in profile-only mode', async () => {
    const { stdout } = mockProcessIO();
    const projectDir = makeTempDir();

    await initSoulCommand.parseAsync(['node', 'init-soul', '--profile-only', '--dir', projectDir], { from: 'node' });

    const profilePath = path.join(projectDir, '.code-agent', 'PROFILE.md');
    expect(fs.existsSync(profilePath)).toBe(true);
    expect(fs.readFileSync(profilePath, 'utf8')).toContain('Project Profile');
    expect(stdout.join('')).toContain(profilePath);
    expect(stdout.join('')).toContain('PROFILE.md');
  });

  it('export lists available sessions without loading the transcript exporter', async () => {
    const { stdout } = mockProcessIO();
    mocks.getDatabaseService.mockReturnValue({
      listSessions: vi.fn(() => [
        { id: 'session-1', title: 'First Session', createdAt: 1700000000000 },
        { id: 'session-2', createdAt: 1700000001000 },
      ]),
    });

    await exportCommand.parseAsync(['node', 'export', '--list'], { from: 'node' });

    expect(mocks.initializeCLIServices).toHaveBeenCalledTimes(1);
    expect(mocks.terminalOutput.info).toHaveBeenCalledWith('可用会话:');
    expect(stdout.join('\n')).toContain('session-1');
    expect(stdout.join('\n')).toContain('First Session');
    expect(stdout.join('\n')).toContain('session-2');
    expect(mocks.transcriptExporterConstructor).not.toHaveBeenCalled();
  });

  it('export uses the most recent session, maps db messages into cache, and prints markdown', async () => {
    const { stdout } = mockProcessIO();
    const listSessions = vi.fn((limit: number) => [
      {
        id: limit === 1 ? 'recent-session' : 'other',
        title: 'Recent',
        createdAt: 100,
        updatedAt: 200,
      },
    ]);
    const getSession = vi.fn(() => ({
      id: 'recent-session',
      title: 'Recent',
      createdAt: 100,
      updatedAt: 200,
    }));
    const getMessages = vi.fn(() => [
      { id: 'm1', role: 'user', content: 'hello', timestamp: 101 },
      { role: 'assistant', content: 'hi', timestamp: 102 },
    ]);
    mocks.getDatabaseService.mockReturnValue({ listSessions, getSession, getMessages });
    mocks.exportTranscript.mockResolvedValue({
      success: true,
      markdown: '# Transcript',
    });

    await exportCommand.parseAsync(['node', 'export', '--format', 'markdown', '--summary'], { from: 'node' });

    expect(mocks.terminalOutput.info).toHaveBeenCalledWith('使用最近会话: recent-session');
    expect(mocks.sessionLocalCacheConstructor).toHaveBeenCalledWith({ maxSessions: 10 });
    expect(mocks.cacheSetSession).toHaveBeenCalledWith({
      sessionId: 'recent-session',
      messages: [
        { id: 'm1', role: 'user', content: 'hello', timestamp: 101 },
        { id: 'msg-1', role: 'assistant', content: 'hi', timestamp: 102 },
      ],
      startedAt: 100,
      lastActivityAt: 200,
      totalTokens: 0,
      metadata: { title: 'Recent' },
    });
    expect(mocks.exportTranscript).toHaveBeenCalledWith('recent-session', {
      format: 'markdown',
      template: 'default',
      prependSummary: true,
      anonymize: false,
      title: 'Recent',
    });
    expect(stdout.join('\n')).toContain('# Transcript');
  });

  it('export writes a transcript file and reports summary plus stats', async () => {
    mockProcessIO();
    mocks.getDatabaseService.mockReturnValue({
      listSessions: vi.fn(),
      getSession: vi.fn(() => ({
        id: 'session-9',
        title: '',
        createdAt: 100,
        updatedAt: 200,
      })),
      getMessages: vi.fn(() => []),
    });
    mocks.exportTranscriptToFile.mockResolvedValue({
      success: true,
      filePath: '/tmp/session.md',
      summary: 'Short summary',
      stats: { messageCount: 2, characterCount: 42 },
    });

    await exportCommand.parseAsync([
      'node',
      'export',
      'session-9',
      '--format',
      'json',
      '--template',
      'minimal',
      '--anonymize',
      '--output',
      '/tmp/session.md',
    ], { from: 'node' });

    expect(mocks.exportTranscriptToFile).toHaveBeenCalledWith('session-9', '/tmp/session.md', {
      format: 'json',
      template: 'minimal',
      prependSummary: false,
      anonymize: true,
      title: 'Session session-',
    });
    expect(mocks.terminalOutput.success).toHaveBeenCalledWith('已导出到: /tmp/session.md');
    expect(mocks.terminalOutput.info).toHaveBeenCalledWith('摘要: Short summary');
    expect(mocks.terminalOutput.info).toHaveBeenCalledWith('统计: 2 条消息, 42 字符');
  });

  it('run forwards global options, restores sessions, emits JSON output, and cleans up', async () => {
    mockProcessIO();
    forceTtyStdin();
    const run = vi.fn(async () => ({ success: true, output: 'done' }));
    const restoreSession = vi.fn(async () => true);
    const getSessionId = vi.fn(() => 'session-1');
    mocks.createCLIAgent.mockResolvedValue({
      run,
      restoreSession,
      getSessionId,
    });
    mocks.getDatabaseService.mockReturnValue(null);
    const program = new Command();
    program.exitOverride();
    program
      .option('--json')
      .option('-p, --project <path>')
      .option('--model <model>')
      .option('--provider <provider>')
      .option('--output-format <format>')
      .option('--debug')
      .addCommand(runCommand);

    await program.parseAsync([
      'node',
      'agent-neo',
      '--json',
      '--project',
      '/workspace',
      '--model',
      'gpt-test',
      '--provider',
      'openai',
      '--debug',
      'run',
      'write tests',
      '--session',
      'session-old',
    ]);

    expect(mocks.initializeCLIServices).toHaveBeenCalledTimes(1);
    expect(mocks.createCLIAgent).toHaveBeenCalledWith({
      project: '/workspace',
      model: 'gpt-test',
      provider: 'openai',
      json: true,
      debug: true,
      outputFormat: undefined,
      systemPrompt: undefined,
      metrics: undefined,
    });
    expect(restoreSession).toHaveBeenCalledWith('session-old');
    expect(run).toHaveBeenCalledWith('write tests');
    expect(mocks.jsonOutput.start).toHaveBeenCalledTimes(1);
    expect(mocks.jsonOutput.result).toHaveBeenCalledWith({ success: true, output: 'done' });
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('run retries schema validation failures and reports the validated structured output', async () => {
    mockProcessIO();
    forceTtyStdin();
    const schema = JSON.stringify({
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    });
    const run = vi.fn()
      .mockResolvedValueOnce({ success: true, output: '{"name":42}' })
      .mockResolvedValueOnce({ success: true, output: '{"name":"Aix"}' });
    mocks.createCLIAgent.mockResolvedValue({
      run,
      restoreSession: vi.fn(),
      getSessionId: vi.fn(() => 'schema-session'),
    });
    mocks.getDatabaseService.mockReturnValue(null);

    await runCommand.parseAsync([
      'node',
      'run',
      'return a name',
      '--output-schema',
      schema,
      '--max-retries',
      '2',
    ], { from: 'node' });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toContain('请严格按照以下 JSON Schema 输出 JSON');
    expect(run.mock.calls[1][0]).toContain('上一次输出不符合要求的 JSON Schema');
    expect(mocks.terminalOutput.warning).toHaveBeenCalledWith('结构化输出验证失败，重试中 (1/2)...');
    expect(mocks.terminalOutput.success).toHaveBeenCalledWith('结构化输出验证通过 ✓');
    expect(mocks.terminalOutput.info).toHaveBeenCalledWith('会话 ID: schema-session');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('run exits before initialization when the inline output schema is invalid', async () => {
    mockProcessIO();
    forceTtyStdin();

    await runCommand.parseAsync([
      'node',
      'run',
      'return json',
      '--output-schema',
      '{',
    ], { from: 'node' });

    expect(mocks.terminalOutput.error).toHaveBeenCalledWith('--output-schema 不是有效的 JSON 字符串');
    expect(mocks.initializeCLIServices).not.toHaveBeenCalled();
    expect(mocks.createCLIAgent).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
