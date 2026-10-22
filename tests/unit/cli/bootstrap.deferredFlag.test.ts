// ============================================================================
// CLI bootstrap 工具延迟加载开关接线（N-PLUGIN-ORIGIN-BUILTIN-HIDE-FU1）
// ----------------------------------------------------------------------------
// 不变量：createAgentLoop 传给 AgentLoop 的 enableToolDeferredLoading 不再写死
// true，而是 config 显式值优先、缺省跟随 AGENT_RUNTIME_DEFAULTS.toolMode
// （与 agentLoop.ts 同一默认真源）。用 toolMode='all' 的默认翻转证明接线
// 真的读了默认源，而不是恰好等于当前默认值的硬编码。
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  skillServiceState: { builtinOnly: false },
  initMCPClient: vi.fn(async () => {}),
  initCLIDatabase: vi.fn(),
}));

vi.mock('../../../src/host/services/skills', () => ({
  getSkillDiscoveryService: () => ({
    initialize: async () => {},
    ensureInitialized: async () => {},
    setBuiltinOnly: (builtinOnly: boolean) => { mocks.skillServiceState.builtinOnly = builtinOnly; },
    isBuiltinOnly: () => mocks.skillServiceState.builtinOnly,
    isInitialized: () => true,
    getAllSkills: () => [],
  }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  initMCPClient: mocks.initMCPClient,
  getMCPClient: () => ({
    disconnectAll: async () => {},
    getStatus: () => ({ connectedServers: [] }),
  }),
}));

vi.mock('../../../src/host/plugins/builtin/computerUse/installState', () => ({
  isComputerUseCapabilityInstalledSync: () => false,
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  initConfigService: () => ({
    initialize: async () => {},
    getSettings: () => ({}),
    getApiKey: () => 'test-key',
  }),
  getConfigService: () => ({
    initialize: async () => {},
    getSettings: () => ({}),
    getApiKey: () => 'test-key',
  }),
}));

vi.mock('../../../src/cli/database', () => ({
  initCLIDatabase: mocks.initCLIDatabase,
}));
vi.mock('../../../src/cli/session', () => ({
  getCLISessionManager: () => ({}),
}));
vi.mock('../../../src/cli/cliLedgerSink', () => ({
  createCliLedgerSink: () => ({}),
}));
vi.mock('../../../src/host/tools/toolLedgerSink', () => ({
  setToolLedgerSink: () => {},
}));

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: vi.fn(),
}));
vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {
    setWorkingDirectory = vi.fn();
    forRun = vi.fn();
  },
}));
vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: vi.fn(() => ({})),
}));
vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: vi.fn(),
}));
vi.mock('../../../src/host/services/core/envCapabilities', () => ({
  probeEnvCapabilities: vi.fn(async () => {}),
}));
vi.mock('../../../src/host/tools/shell/shutdownReaper', () => ({
  reapChildProcesses: vi.fn(),
}));

// 默认源翻转：toolMode='all' 时缺省必须落到 false——证明读的是这个真源
vi.mock('../../../src/host/agent/agentRuntimeDefaults', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/agent/agentRuntimeDefaults')>();
  return {
    ...actual,
    AGENT_RUNTIME_DEFAULTS: { ...actual.AGENT_RUNTIME_DEFAULTS, toolMode: 'all' as const },
  };
});

import { buildCLIConfig, cleanup, createAgentLoop, initializeCLIServices } from '../../../src/cli/bootstrap';
import { AgentLoop } from '../../../src/host/agent/agentLoop';

function lastAgentLoopConfig(): { enableToolDeferredLoading?: boolean } {
  const calls = vi.mocked(AgentLoop).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as { enableToolDeferredLoading?: boolean };
}

describe('createAgentLoop 工具延迟加载开关接线', () => {
  let tmpDir: string;
  let savedDataDir: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-deferred-flag-test-'));
    savedDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    vi.clearAllMocks();
    mocks.initCLIDatabase.mockResolvedValue(null);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await initializeCLIServices({ bare: true });
  });

  afterEach(async () => {
    await cleanup();
    warnSpy.mockRestore();
    if (savedDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = savedDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('缺省跟随 AGENT_RUNTIME_DEFAULTS.toolMode（默认源翻成 all → false，不再是写死 true）', () => {
    createAgentLoop(buildCLIConfig({}), () => {});
    expect(lastAgentLoopConfig().enableToolDeferredLoading).toBe(false);
  });

  it('显式 override 优先：enableToolDeferredLoading=false / true 都原样透传', () => {
    createAgentLoop({ ...buildCLIConfig({}), enableToolDeferredLoading: false }, () => {});
    expect(lastAgentLoopConfig().enableToolDeferredLoading).toBe(false);

    createAgentLoop({ ...buildCLIConfig({}), enableToolDeferredLoading: true }, () => {});
    expect(lastAgentLoopConfig().enableToolDeferredLoading).toBe(true);
  });
});
