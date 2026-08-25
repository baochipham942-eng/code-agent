import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => {
  const rawDb = {};
  const databaseService = { getDb: vi.fn(() => rawDb) };
  const registry = {
    waitForDurableKernel: vi.fn().mockResolvedValue(true),
    startDurable: vi.fn(),
    terminalDurable: vi.fn(),
  };
  const migrate = vi.fn();
  const agentLoopConfigs: unknown[] = [];
  const initializeDurableRun = vi.fn().mockResolvedValue({
    kernel: {},
    policy: { mode: 'durable_preferred' },
    recoveryRuntime: null,
    readService: {},
    recoveryResults: [],
    shutdown: vi.fn(),
  });
  const nativeRecoveryPorts = { continuationExecutor: 'available' };
  const autoAgentRecoveryHost = { recover: vi.fn() };

  return {
    rawDb,
    databaseService,
    registry,
    migrate,
    agentLoopConfigs,
    initializeDurableRun,
    nativeRecoveryPorts,
    autoAgentRecoveryHost,
    initCLIDatabase: vi.fn().mockResolvedValue(databaseService),
    createApplicationNativeRecoveryPorts: vi.fn(() => nativeRecoveryPorts),
    createApplicationAutoAgentRecoveryHost: vi.fn(() => autoAgentRecoveryHost),
    configInitialize: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../src/host/services/core/configService', () => ({
  initConfigService: () => ({ initialize: mocks.configInitialize }),
}));

vi.mock('../../../src/cli/database', () => ({
  initCLIDatabase: mocks.initCLIDatabase,
}));

vi.mock('../../../src/cli/cliLedgerSink', () => ({ createCliLedgerSink: vi.fn(() => ({})) }));
vi.mock('../../../src/host/tools/toolLedgerSink', () => ({ setToolLedgerSink: vi.fn() }));
vi.mock('../../../src/cli/permissionPolicy', () => ({ createCLIPermissionHandler: vi.fn() }));
vi.mock('../../../src/cli/session', () => ({ getCLISessionManager: vi.fn(() => ({})) }));
vi.mock('../../../src/host/services/core/repositories/DurableRunRepository', () => ({
  DurableRunRepository: class {
    migrate = mocks.migrate;
  },
}));
vi.mock('../../../src/host/app/applicationRunRegistry', () => ({
  getApplicationRunRegistry: vi.fn(() => mocks.registry),
}));
vi.mock('../../../src/host/app/initializeDurableRun', () => ({
  initializeDurableRun: mocks.initializeDurableRun,
}));
vi.mock('../../../src/host/app/nativeRecoveryHost', () => ({
  createApplicationNativeRecoveryPorts: mocks.createApplicationNativeRecoveryPorts,
}));
vi.mock('../../../src/host/app/autoAgentRecoveryHost', () => ({
  createApplicationAutoAgentRecoveryHost: mocks.createApplicationAutoAgentRecoveryHost,
}));
vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: class {
    constructor(config: unknown) {
      mocks.agentLoopConfigs.push(config);
    }
  },
}));
vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {
    forRun(): this { return this; }
  },
}));
vi.mock('../../../src/host/tools/protocolRegistry', () => ({ getProtocolRegistry: vi.fn() }));
vi.mock('../../../src/host/services/skills', () => ({
  getSkillDiscoveryService: () => ({ initialize: vi.fn(), ensureInitialized: vi.fn() }),
}));
vi.mock('../../../src/host/telemetry', () => ({ getTelemetryCollector: vi.fn() }));

describe('initializeCLIServices durable wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODE_AGENT_ENABLE_CUA;
    delete process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
  });

  it('migrates the CLI SQLite database and configures the shared Durable Run runtime', async () => {
    const { initializeCLIServices } = await import('../../../src/cli/bootstrap');

    await initializeCLIServices();

    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.initializeDurableRun).toHaveBeenCalledWith(expect.objectContaining({
      registry: mocks.registry,
      repository: expect.objectContaining({ migrate: mocks.migrate }),
      ownerId: 'cli-native-host',
      dataDir: expect.any(String),
      processInstanceId: expect.stringMatching(/^cli-\d+-/),
      nativeRecoveryPorts: mocks.nativeRecoveryPorts,
      autoAgentRecoveryHost: mocks.autoAgentRecoveryHost,
    }));
    expect(mocks.createApplicationNativeRecoveryPorts).toHaveBeenCalledWith(mocks.registry);
    expect(mocks.createApplicationAutoAgentRecoveryHost).toHaveBeenCalledWith(mocks.registry);
  });

  it('removes TaskManager-backed command-center tools from the CLI model tool table', async () => {
    const { createAgentLoop, initializeCLIServices } = await import('../../../src/cli/bootstrap');
    const { filterToolsByRunPolicy } = await import('../../../src/host/agent/runtime/toolRunPolicy');
    const {
      cancelTaskSchema,
      delegateTaskSchema,
      steerTaskSchema,
      taskStatusSchema,
    } = await import('../../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema');

    await initializeCLIServices();
    createAgentLoop({
      workingDirectory: process.cwd(),
      modelConfig: { provider: 'openai', model: 'test-model' },
      outputFormat: 'text',
      enablePlanning: false,
      enableHooks: false,
      debug: false,
      autoApprovePlan: true,
    }, vi.fn());

    const runtimeConfig = mocks.agentLoopConfigs.at(-1) as Parameters<typeof filterToolsByRunPolicy>[1];
    const commandCenterSchemas = [
      delegateTaskSchema,
      steerTaskSchema,
      cancelTaskSchema,
      taskStatusSchema,
    ];
    const commandCenterTools = commandCenterSchemas.map((schema): ToolDefinition => ({
      name: schema.name,
      description: schema.description,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'string' },
      permissionLevel: 'read',
      requiresPermission: false,
    }));

    expect(filterToolsByRunPolicy(commandCenterTools, runtimeConfig)).toEqual([]);
    expect(runtimeConfig.deniedToolNames).toEqual(expect.arrayContaining(
      commandCenterTools.map((tool) => tool.name),
    ));
  });

  it('passes the web workbench tool scope through the CLI bootstrap adapter', async () => {
    const { createAgentLoop, initializeCLIServices } = await import('../../../src/cli/bootstrap');

    await initializeCLIServices();
    createAgentLoop({
      workingDirectory: process.cwd(),
      modelConfig: { provider: 'openai', model: 'test-model' },
      outputFormat: 'text',
      enablePlanning: false,
      enableHooks: false,
      debug: false,
      toolScope: { allowedConnectorIds: ['tmeet'] },
    }, vi.fn());

    expect(mocks.agentLoopConfigs.at(-1)).toEqual(expect.objectContaining({
      toolScope: { allowedConnectorIds: ['tmeet'] },
    }));
  });

  it('warns visibly without failing CLI startup when the database is unavailable', async () => {
    vi.resetModules();
    mocks.initCLIDatabase.mockRejectedValueOnce(new Error('sqlite unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { initializeCLIServices } = await import('../../../src/cli/bootstrap');

    await expect(initializeCLIServices()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Database not available (CLI mode):', 'sqlite unavailable');
  });
});
