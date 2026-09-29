// ============================================================================
// --bare 纯净模式 × 运行期懒加载路径（N-HEADLESS-BARE-BUILTIN）
// 真实链路、真夹具：真 SkillDiscoveryService（含 setBuiltinOnly 守门）+ 真
// resolveSkillInvocation（conversationRuntime 每条用户消息的隐式匹配入口）
// + 真 executeSkill（Skill 工具懒加载入口）。宿主机 skill 夹具摆在
// 用户 dataDir/skills、HOME/.claude/skills、项目 .claude/skills。
// 钉住的不变量：bare 下产品内置 skill（xlsx）可解析，宿主机夹具不可见，
// 指纹 skills=builtin-only 且带 skillNames；非 bare 同一夹具照常装载。
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
const FIXTURE_PROJECT_SKILL = 'bare-project-fixture-skill';

async function plantSkillMd(skillDir: string, name: string): Promise<void> {
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: bare session loader gating fixture',
      '---',
      '',
      'Fixture body. Not meant to be executed.',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** 在用户 dataDir、HOME/.claude/skills、项目 .claude/skills 各落一份宿主机夹具 */
async function plantHostSkills(dataDir: string, homeDir: string, projectDir: string): Promise<void> {
  await plantSkillMd(path.join(dataDir, 'skills', FIXTURE_SKILL), FIXTURE_SKILL);
  await plantSkillMd(path.join(homeDir, '.claude', 'skills', FIXTURE_SKILL), FIXTURE_SKILL);
  await plantSkillMd(path.join(projectDir, '.claude', 'skills', FIXTURE_PROJECT_SKILL), FIXTURE_PROJECT_SKILL);
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
  let homeDir: string;
  let workspace: string;
  let savedDataDir: string | undefined;
  let savedHome: string | undefined;
  let savedAgentHome: string | undefined;
  let savedArgusEnv: string | undefined;
  let savedSwarmMode: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cli-bare-session-'));
    dataDir = path.join(tmpRoot, 'data');
    homeDir = path.join(tmpRoot, 'home');
    workspace = path.join(tmpRoot, 'workspace');
    await fs.promises.mkdir(workspace, { recursive: true });
    savedDataDir = process.env.CODE_AGENT_DATA_DIR;
    savedHome = process.env.HOME;
    savedAgentHome = process.env.CODE_AGENT_HOME;
    savedArgusEnv = process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
    savedSwarmMode = process.env[SWARM_TRACE.STORAGE_MODE_ENV];
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    process.env.HOME = homeDir;
    process.env.CODE_AGENT_HOME = homeDir;
    process.env.CODE_AGENT_ENABLE_ARGUS_MCP = '1';
    delete process.env[SWARM_TRACE.STORAGE_MODE_ENV];
    // 每条用例拿全新的发现服务单例（builtin-only 态不跨用例泄漏）
    resetSkillDiscoveryService();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    // 兜底复位（用例中途 fail 时也别把 initialized/builtin-only 带给下一条）
    await cleanup();
    resetSkillDiscoveryService();
    if (savedDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = savedDataDir;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedAgentHome === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = savedAgentHome;
    if (savedArgusEnv === undefined) delete process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
    else process.env.CODE_AGENT_ENABLE_ARGUS_MCP = savedArgusEnv;
    if (savedSwarmMode !== undefined) process.env[SWARM_TRACE.STORAGE_MODE_ENV] = savedSwarmMode;
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  });

  it('bare：产品内置 xlsx 可解析，HOME/project .claude/skills 用户 skill 不可见，指纹 builtin-only', async () => {
    await plantHostSkills(dataDir, homeDir, workspace);

    await initializeCLIServices({ bare: true });
    await whenCLISkillsReady();

    const discovery = getSkillDiscoveryService();
    expect(discovery.isBuiltinOnly()).toBe(true);
    expect(discovery.getSkill('xlsx')?.name).toBe('xlsx');
    expect(discovery.getSkill(FIXTURE_SKILL)).toBeUndefined();
    expect(discovery.getSkill(FIXTURE_PROJECT_SKILL)).toBeUndefined();

    const builtinInvocation = await resolveSkillInvocation(
      '/xlsx please make a sheet',
      workspace,
    );
    expect(builtinInvocation?.skill.name).toBe('xlsx');

    const hostInvocation = await resolveSkillInvocation(
      `/${FIXTURE_SKILL} please do the thing`,
      workspace,
    );
    expect(hostInvocation).toBeNull();
    const projectInvocation = await resolveSkillInvocation(
      `/${FIXTURE_PROJECT_SKILL} please do the thing`,
      workspace,
    );
    expect(projectInvocation).toBeNull();

    const result = await executeSkill(
      { command: FIXTURE_SKILL, args: '' },
      buildToolContext(workspace),
      allowAlways,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`Unknown skill: ${FIXTURE_SKILL}`);
    }

    const fingerprint = getCLIEnvironmentFingerprint();
    expect(fingerprint.bare).toBe(true);
    expect(fingerprint.skills).toBe('builtin-only');
    expect(fingerprint.hooks).toBe('skipped');
    expect(fingerprint.mcp).toBe('skipped');
    expect(fingerprint.mcpServers).toEqual([]);
    expect(fingerprint.skillCount).toBeGreaterThan(0);
    expect(fingerprint.skillNames).toEqual([...(fingerprint.skillNames ?? [])].sort());
    expect(fingerprint.skillNames).toContain('xlsx');
    expect(fingerprint.skillNames).not.toContain(FIXTURE_SKILL);
    expect(fingerprint.skillNames).not.toContain(FIXTURE_PROJECT_SKILL);
    expect(fingerprint.skillCount).toBe(fingerprint.skillNames?.length);

    // 反向变异咬合点：发现阶段真扫过盘就会把元数据缓存写进 <dataDir>/cache/
    // skill-metadata-index-v4.json。夹具在场而缓存文件不存在 = 宿主机 skill
    // 目录从头到尾没被读过。
    const metadataCacheFile = path.join(dataDir, 'cache', 'skill-metadata-index-v4.json');
    expect(fs.existsSync(metadataCacheFile)).toBe(false);
  });

  it('非 bare（默认）：同一夹具照常装载——隐式匹配命中、工具可见、指纹 loaded+count≥1', async () => {
    await plantHostSkills(dataDir, homeDir, workspace);

    await initializeCLIServices({});
    await whenCLISkillsReady();

    const invocation = await resolveSkillInvocation(
      `/${FIXTURE_SKILL} please do the thing`,
      workspace,
    );
    expect(invocation?.skill.name).toBe(FIXTURE_SKILL);
    expect(invocation?.matchKind).toBe('slash');

    const discovery = getSkillDiscoveryService();
    expect(discovery.isBuiltinOnly()).toBe(false);
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
    expect(fingerprint).not.toHaveProperty('skillNames');

    // 同一可观测取反（防空转）：非 bare 真扫过盘 → 元数据缓存文件确实落盘
    const metadataCacheFile = path.join(dataDir, 'cache', 'skill-metadata-index-v4.json');
    expect(fs.existsSync(metadataCacheFile)).toBe(true);
  });
});
