import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rawDb = {};
  const databaseService = { getDb: vi.fn(() => rawDb) };
  const registry = {
    waitForDurableKernel: vi.fn().mockResolvedValue(true),
    startDurable: vi.fn(),
    terminalDurable: vi.fn(),
  };
  const migrate = vi.fn();
  const initializeDurableRun = vi.fn().mockResolvedValue({
    kernel: {},
    policy: { mode: 'durable_preferred' },
    recoveryRuntime: null,
    readService: {},
    recoveryResults: [],
    shutdown: vi.fn(),
  });

  return {
    rawDb,
    databaseService,
    registry,
    migrate,
    initializeDurableRun,
    configInitialize: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../src/host/services/core/configService', () => ({
  initConfigService: () => ({ initialize: mocks.configInitialize }),
}));

vi.mock('../../../src/cli/database', () => ({
  initCLIDatabase: vi.fn().mockResolvedValue(mocks.databaseService),
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
vi.mock('../../../src/host/agent/agentLoop', () => ({ AgentLoop: class {} }));
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
    }));
  });
});
