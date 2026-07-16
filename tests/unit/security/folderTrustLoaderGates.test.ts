import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import {
  FolderTrustService,
  resetFolderTrustServiceForTest,
} from '../../../src/host/security/folderTrustService';
import { loadAllHooksConfig } from '../../../src/host/hooks/configParser';
import { loadMcpConfigFiles } from '../../../src/host/mcp/mcpConfigFile';
import { initAgentRegistry, disposeAgentRegistry, listAllAgents } from '../../../src/host/agent/agentRegistry';
import { SkillDiscoveryService } from '../../../src/host/services/skills/skillDiscoveryService';
import { PromptCommandService } from '../../../src/host/services/commands/promptCommandService';
import { loadSoul } from '../../../src/host/prompts/soulLoader';
import { discoverAgentFiles } from '../../../src/host/context/agentsDiscovery';
import { PolicyEnforcer } from '../../../src/host/security/policyEnforcer';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/skills/builtinSkills', () => ({
  getBuiltinSkills: () => [],
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getSkills: () => [],
  }),
}));

vi.mock('../../../src/host/services/cloud/cloudConfigService', () => ({
  getCloudConfigService: () => ({
    getMCPServers: () => [],
    isCloudMCPServersEnabledByPolicy: () => true,
  }),
}));

vi.mock('../../../src/host/services/toolSearch', () => ({
  getToolSearchService: () => ({
    clearSkills: vi.fn(),
    registerSkills: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isSkillEnabled: () => true,
  }),
}));

vi.mock('../../../src/host/skills/marketplace/installService', () => ({
  getEnabledSkillDirs: async () => [],
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getPrompts: () => [],
  }),
}));

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

describe('folder trust loader gates', () => {
  let tmpRoot: string;
  let homeDir: string;
  let dataDir: string;
  let projectDir: string;
  let trustService: FolderTrustService;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-trust-gates-'));
    homeDir = path.join(tmpRoot, 'home');
    dataDir = path.join(tmpRoot, 'data');
    projectDir = path.join(tmpRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    vi.stubEnv('CODE_AGENT_TEST_DEFAULT_FOLDER_TRUST', '');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('CODE_AGENT_HOME', homeDir);
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    resetFolderTrustServiceForTest();
    trustService = new FolderTrustService();
  });

  afterEach(async () => {
    await disposeAgentRegistry();
    resetFolderTrustServiceForTest();
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('blocks project hooks until the folder is trusted', async () => {
    await writeFile(path.join(projectDir, '.code-agent', 'hooks', 'hooks.json'), JSON.stringify({
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo project' }] }],
    }));

    expect(await loadAllHooksConfig(projectDir)).toEqual([]);

    await trustService.set(projectDir, 'trusted', 'test');
    const configs = await loadAllHooksConfig(projectDir);
    expect(configs).toHaveLength(1);
    expect(configs[0].source).toBe('project');
  });

  it('blocks project and local MCP configs until the folder is trusted', async () => {
    await writeFile(path.join(dataDir, 'mcp.json'), JSON.stringify({
      servers: [{ name: 'user-http', serverUrl: 'http://127.0.0.1:1/mcp' }],
    }));
    await writeFile(path.join(projectDir, '.code-agent', 'mcp.json'), JSON.stringify({
      servers: [{ name: 'project-stdio', command: 'node', args: ['server.js'] }],
    }));
    await writeFile(path.join(projectDir, '.code-agent', 'mcp.local.json'), JSON.stringify({
      servers: [{ name: 'local-stdio', command: 'node', args: ['local.js'] }],
    }));

    expect((await loadMcpConfigFiles(projectDir)).map((server) => server.name)).toEqual(['user-http']);

    await trustService.set(projectDir, 'trusted', 'test');
    expect((await loadMcpConfigFiles(projectDir)).map((server) => server.name)).toEqual([
      'user-http',
      'project-stdio',
      'local-stdio',
    ]);
  });

  it('blocks project agents, skills, commands, profile, instructions, and policy until trusted', async () => {
    await writeFile(path.join(projectDir, '.code-agent', 'agents', 'rogue.md'), '---\nname: rogue\n---\nRogue');
    await writeFile(path.join(projectDir, '.code-agent', 'skills', 'rogue-skill', 'SKILL.md'), '---\nname: rogue-skill\ndescription: Rogue\n---\nBody');
    await writeFile(path.join(projectDir, '.code-agent', 'commands', 'rogue.md'), 'Rogue command');
    await writeFile(path.join(projectDir, '.code-agent', 'PROFILE.md'), 'PROJECT_PROFILE_MARKER');
    await writeFile(path.join(projectDir, 'AGENTS.md'), 'PROJECT_AGENT_INSTRUCTIONS');
    await writeFile(path.join(projectDir, 'code-agent-policy.toml'), '[execution]\nallow_shell = false\n');

    await initAgentRegistry(projectDir);
    expect(listAllAgents().some((agent) => agent.id === 'rogue')).toBe(false);

    const skillService = new SkillDiscoveryService();
    await skillService.initialize(projectDir);
    expect(skillService.getSkill('rogue-skill')).toBeUndefined();

    const commandService = new PromptCommandService();
    expect((await commandService.listCommands(projectDir)).some((command) => command.name === 'rogue')).toBe(false);

    expect(loadSoul(projectDir)).not.toContain('PROJECT_PROFILE_MARKER');
    expect((await discoverAgentFiles(projectDir)).combinedInstructions).not.toContain('PROJECT_AGENT_INSTRUCTIONS');
    expect(new PolicyEnforcer(projectDir).isActive).toBe(false);

    await trustService.set(projectDir, 'trusted', 'test');

    await initAgentRegistry(projectDir);
    expect(listAllAgents().some((agent) => agent.id === 'rogue')).toBe(true);

    const trustedSkillService = new SkillDiscoveryService();
    await trustedSkillService.initialize(projectDir);
    expect(trustedSkillService.getSkill('rogue-skill')?.source).toBe('project');

    expect((await commandService.listCommands(projectDir)).some((command) => command.name === 'rogue')).toBe(true);
    expect(loadSoul(projectDir)).toContain('PROJECT_PROFILE_MARKER');
    expect((await discoverAgentFiles(projectDir)).combinedInstructions).toContain('PROJECT_AGENT_INSTRUCTIONS');
    expect(new PolicyEnforcer(projectDir).isActive).toBe(true);
  });
});
