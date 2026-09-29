// ============================================================================
// --bare 纯净模式 × 运行期懒加载路径（N-HEADLESS-BARE rework r1）
// 真实链路、真夹具：真 SkillDiscoveryService（含 setDisabled 守门）+ 真
// resolveSkillInvocation（conversationRuntime 每条用户消息的隐式匹配入口）
// + 真 executeSkill（Skill 工具懒加载入口）。本地 skill 夹具摆在
// <CODE_AGENT_DATA_DIR>/skills/（用户级 skill 库），两条用例共用同一夹具，
// 只有 --bare 与否不同。
// 钉住的不变量：bare 下首条用户消息不会把宿主机 skill 库读进来——隐式匹配
// 无命中、Skill 工具清单为空、指纹 skills=skipped 且 skillCount=0；
// 非 bare 同一夹具全部照常——隐式匹配命中、工具可见、指纹 loaded 且 count≥1。
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- 模块边界 mock（skills 链路本体保持真实） ----
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/services/skills/builtinSkills', () => ({
  getBuiltinSkills: () => [],
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getSkills: () => [] }),
}));

vi.mock('../../../src/host/services/toolSearch', () => ({
  getToolSearchService: () => ({
    registerSkill: vi.fn(),
    unregisterSkill: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isSkillEnabled: () => true,
  }),
}));

// ---- bootstrap 周边重依赖照 bootstrap.bare.test.ts 的边界 mock ----
vi.mock('../../../src/host/mcp/mcpClient', () => ({
  initMCPClient: vi.fn(async () => {}),
  getMCPClient: () => ({
    disconnectAll: vi.fn(async () => {}),
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
  initCLIDatabase: vi.fn().mockResolvedValue(null),
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
  reapChildProcesses: vi.fn(async () => {}),
}));

import {
  cleanup,
  getCLIEnvironmentFingerprint,
  initializeCLIServices,
  whenCLISkillsReady,
} from '../../../src/cli/bootstrap';
import {
  getSkillDiscoveryService,
  resetSkillDiscoveryService,
  resolveSkillInvocation,
} from '../../../src/host/services/skills';
import { executeSkill } from '../../../src/host/tools/modules/skill/skill';
import type { ToolContext, CanUseToolResult } from '../../../src/host/protocol/tools';
import { SWARM_TRACE } from '../../../src/shared/constants/storage';

const FIXTURE_SKILL = 'bare-fixture-skill';

/** 在用户级 skill 库（<dataDir>/skills）落一个可被发现的本地 skill 夹具 */
async function plantFixtureSkill(dataDir: string): Promise<void> {
  const skillDir = path.join(dataDir, 'skills', FIXTURE_SKILL);
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${FIXTURE_SKILL}`,
      'description: bare session loader gating fixture',
      '---',
      '',
      'Fixture body. Not meant to be executed.',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function buildToolContext(workingDir: string): ToolContext {
  return {
    sessionId: 'bare-session-test',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ToolContext;
}

const allowAlways = async (): Promise<CanUseToolResult> => ({ allow: true });

describe('--bare 纯净模式 × 运行期懒加载（真实 skill 链路 + 本地夹具）', () => {
  let tmpRoot: string;
  let dataDir: string;
  let workspace: string;
  let savedDataDir: string | undefined;
  let savedArgusEnv: string | undefined;
  let savedSwarmMode: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cli-bare-session-'));
    dataDir = path.join(tmpRoot, 'data');
    workspace = path.join(tmpRoot, 'workspace');
    await fs.promises.mkdir(workspace, { recursive: true });
    savedDataDir = process.env.CODE_AGENT_DATA_DIR;
    savedArgusEnv = process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
    savedSwarmMode = process.env[SWARM_TRACE.STORAGE_MODE_ENV];
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    process.env.CODE_AGENT_ENABLE_ARGUS_MCP = '1';
    delete process.env[SWARM_TRACE.STORAGE_MODE_ENV];
    // 每条用例拿全新的发现服务单例（禁用态不跨用例泄漏）
    resetSkillDiscoveryService();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    // 兜底复位（用例中途 fail 时也别把 initialized/禁用态带给下一条）
    await cleanup();
    resetSkillDiscoveryService();
    if (savedDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = savedDataDir;
    if (savedArgusEnv === undefined) delete process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
    else process.env.CODE_AGENT_ENABLE_ARGUS_MCP = savedArgusEnv;
    if (savedSwarmMode !== undefined) process.env[SWARM_TRACE.STORAGE_MODE_ENV] = savedSwarmMode;
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  });

  it('bare：真实用户消息链路读不到本地 skill 库（隐式匹配无命中、Skill 工具无清单、指纹 skipped+0）', async () => {
    await plantFixtureSkill(dataDir);

    await initializeCLIServices({ bare: true });

    // conversationRuntime 每条用户消息都走的隐式匹配入口（懒加载第一漏点）
    const invocation = await resolveSkillInvocation(
      `/${FIXTURE_SKILL} please do the thing`,
      workspace,
    );
    expect(invocation).toBeNull();

    const discovery = getSkillDiscoveryService();
    expect(discovery.isDisabled()).toBe(true);
    expect(discovery.getAllSkills()).toEqual([]);

    // Skill 工具懒加载入口（skill.ts 的 ensureInitialized→getSkill/getAllSkills）
    const result = await executeSkill(
      { command: FIXTURE_SKILL, args: '' },
      buildToolContext(workspace),
      allowAlways,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('当前没有可用 skill');
    }

    // 指纹如实报告：skipped 且 count=0（从发现服务实况导出，非硬编码）
    expect(getCLIEnvironmentFingerprint()).toEqual({
      bare: true,
      skills: 'skipped',
      skillCount: 0,
      hooks: 'skipped',
      mcp: 'skipped',
      mcpServers: [],
    });

    // 反向变异咬合点：发现阶段真扫过盘就会把元数据缓存写进 <dataDir>/cache/
    // skill-metadata-index-v4.json（disabled 分支零磁盘 I/O）。夹具在场而缓存
    // 文件不存在 = 本机 skill 库从头到尾没被读过。
    const metadataCacheFile = path.join(dataDir, 'cache', 'skill-metadata-index-v4.json');
    expect(fs.existsSync(metadataCacheFile)).toBe(false);
  });

  it('非 bare（默认）：同一夹具照常装载——隐式匹配命中、工具可见、指纹 loaded+count≥1', async () => {
    await plantFixtureSkill(dataDir);

    await initializeCLIServices({});
    await whenCLISkillsReady();

    const invocation = await resolveSkillInvocation(
      `/${FIXTURE_SKILL} please do the thing`,
      workspace,
    );
    expect(invocation?.skill.name).toBe(FIXTURE_SKILL);
    expect(invocation?.matchKind).toBe('slash');

    const discovery = getSkillDiscoveryService();
    expect(discovery.isDisabled()).toBe(false);
    expect(discovery.getAllSkills().map((s) => s.name)).toContain(FIXTURE_SKILL);

    // Skill 工具能看见本地库：typo 触发就近建议（不真正执行 skill）
    const result = await executeSkill(
      { command: `${FIXTURE_SKILL}-typo`, args: '' },
      buildToolContext(workspace),
      allowAlways,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(FIXTURE_SKILL);
    }

    const fingerprint = getCLIEnvironmentFingerprint();
    expect(fingerprint.bare).toBe(false);
    expect(fingerprint.skills).toBe('loaded');
    expect(fingerprint.skillCount).toBeGreaterThanOrEqual(1);

    // 同一可观测取反（防空转）：非 bare 真扫过盘 → 元数据缓存文件确实落盘
    const metadataCacheFile = path.join(dataDir, 'cache', 'skill-metadata-index-v4.json');
    expect(fs.existsSync(metadataCacheFile)).toBe(true);
  });
});
