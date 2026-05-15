import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ParsedSkill } from '../../../../src/shared/contract/agentSkill';
import type { ChannelAccount } from '../../../../src/shared/contract/channel';

const skillEnable = vi.fn();
const skillDisable = vi.fn();
const skillRefresh = vi.fn();
const mcpSetEnabled = vi.fn();
const mcpAddServer = vi.fn();
const mcpRemoveServer = vi.fn();
const clearMcpContext = vi.fn();
const connectorConfigure = vi.fn();
const channelUpdateAccount = vi.fn();
const configUpdateSettings = vi.fn();

const projectSkill: ParsedSkill = {
  name: 'research',
  description: 'Research local evidence',
  promptContent: '',
  basePath: '/repo/.code-agent/skills/research',
  allowedTools: ['Read', 'Grep'],
  disableModelInvocation: false,
  userInvocable: true,
  executionContext: 'inline',
  source: 'project',
  loaded: false,
};

const librarySkill: ParsedSkill = {
  name: 'slides',
  description: 'Create decks',
  promptContent: '',
  basePath: '/home/.code-agent/skills/slides',
  allowedTools: ['Read', 'Write'],
  disableModelInvocation: false,
  userInvocable: true,
  executionContext: 'fork',
  source: 'library',
  bins: ['node'],
  envVars: ['SLIDES_TOKEN'],
  dependencyStatus: {
    satisfied: false,
    missingBins: [],
    missingEnvVars: ['SLIDES_TOKEN'],
    missingReferences: [],
  },
  loaded: false,
};

const httpAccount: ChannelAccount = {
  id: 'acct-1',
  name: 'Local API',
  type: 'http-api',
  config: {
    type: 'http-api',
    port: 8080,
    apiKey: 'super-secret-api-key',
    privacyMode: 'local-redact',
  },
  status: 'connected',
  enabled: true,
  createdAt: 1,
};

const githubMcpState = {
  config: {
    name: 'github',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'raw-token' },
    enabled: true,
    scope: 'project',
  },
  status: 'lazy',
  toolCount: 2,
  resourceCount: 1,
};
let mcpStates: Array<typeof githubMcpState>;

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../../src/main/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({
    ensureInitialized: vi.fn(),
    getAllSkills: () => [projectSkill, librarySkill],
    refreshLibraries: skillRefresh,
  }),
}));

vi.mock('../../../../src/main/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn(),
    getLocalLibraries: () => [
      {
        repoId: 'deck-lib',
        repoName: 'Deck Lib',
        localPath: '/home/.code-agent/skills/deck-lib',
        downloadedAt: 1,
        lastUpdated: 2,
        version: 'abc123',
        skills: [
          {
            name: 'slides',
            description: 'Create decks',
            libraryId: 'deck-lib',
            localPath: '/home/.code-agent/skills/deck-lib/skills/slides',
            enabled: false,
          },
        ],
      },
    ],
    enableSkill: skillEnable,
    disableSkill: skillDisable,
  }),
}));

vi.mock('../../../../src/main/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getServerStates: () => mcpStates,
    getServerState: (serverName: string) => mcpStates.find((state) => state.config.name === serverName),
    addServer: mcpAddServer,
    removeServer: mcpRemoveServer,
    setServerEnabled: mcpSetEnabled,
  }),
  isStdioConfig: (config: { type?: string }) => !config.type || config.type === 'stdio',
  isSSEConfig: (config: { type?: string }) => config.type === 'sse',
  isHttpStreamableConfig: (config: { type?: string }) => config.type === 'http-streamable',
  isInProcessConfig: (config: { type?: string }) => config.type === 'in-process',
}));

vi.mock('../../../../src/main/context/contextHealthService', () => ({
  getContextHealthService: () => ({
    clearMcpServerAcrossSessions: clearMcpContext,
  }),
}));

vi.mock('../../../../src/main/connectors', () => ({
  getConnectorRegistry: () => ({
    list: () => [
      {
        id: 'calendar',
        label: 'Calendar',
        getStatus: async () => ({
          connected: true,
          readiness: 'ready',
          capabilities: ['list_events'],
        }),
      },
    ],
    configure: connectorConfigure,
  }),
}));

vi.mock('../../../../src/main/channels', () => ({
  getChannelManager: () => ({
    getRegisteredPlugins: () => [
      {
        type: 'http-api',
        meta: {
          name: 'HTTP API',
          description: 'REST API channel',
          capabilities: {},
        },
      },
      {
        type: 'feishu',
        meta: {
          name: '飞书',
          description: 'Feishu bot channel',
          capabilities: {},
        },
      },
    ],
    getAccounts: () => [httpAccount],
    updateAccount: channelUpdateAccount,
  }),
}));

vi.mock('../../../../src/main/lightMemory/indexLoader', () => ({
  getMemoryDir: () => '/tmp/code-agent-missing-memory-dir',
}));

import { CapabilityCenterService } from '../../../../src/main/services/capabilities/capabilityCenterService';

describe('CapabilityCenterService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpStates = [{ ...githubMcpState, config: { ...githubMcpState.config } }];
    configUpdateSettings.mockResolvedValue(undefined);
    mcpSetEnabled.mockResolvedValue(undefined);
    mcpAddServer.mockImplementation((config) => {
      mcpStates.push({
        config,
        status: 'lazy',
        toolCount: 0,
        resourceCount: 0,
      } as typeof githubMcpState);
    });
    mcpRemoveServer.mockImplementation((serverName: string) => {
      mcpStates = mcpStates.filter((state) => state.config.name !== serverName);
    });
    channelUpdateAccount.mockResolvedValue(httpAccount);
  });

  it('builds a local inventory without leaking secrets', async () => {
    const service = new CapabilityCenterService();
    const inventory = await service.listCapabilities({
      workingDirectory: '/repo',
      configService: {
        getSettings: () => ({ connectors: { enabledNative: ['calendar'] } }),
        updateSettings: configUpdateSettings,
      } as never,
    });

    expect(inventory.items.some((item) => item.kind === 'tool_bundle')).toBe(true);
    expect(inventory.items.find((item) => item.id === 'skill%3Aresearch')).toBeUndefined();
    expect(inventory.items.find((item) => item.id === 'skill:research')).toMatchObject({
      kind: 'skill',
      source: { kind: 'project' },
      state: { enable: 'enabled', runtime: 'ready' },
    });
    expect(inventory.items.find((item) => item.id === 'skill:slides')).toMatchObject({
      kind: 'skill',
      source: { kind: 'library' },
      state: { enable: 'disabled', runtime: 'blocked' },
    });
    expect(inventory.items.find((item) => item.id === 'mcp:github')).toMatchObject({
      kind: 'mcp_template',
      state: { enable: 'enabled', runtime: 'lazy' },
      metrics: { tools: 2, resources: 1 },
    });
    expect(inventory.items.find((item) => item.id === 'connector:calendar')).toMatchObject({
      kind: 'connector',
      state: { enable: 'enabled', runtime: 'connected' },
    });
    expect(inventory.items.find((item) => item.id === 'channel:acct-1')).toMatchObject({
      kind: 'channel_adapter',
      state: { enable: 'enabled', runtime: 'connected' },
    });
    expect(inventory.items.find((item) => item.id === 'channel-template:feishu')).toMatchObject({
      kind: 'channel_adapter',
      state: { install: 'available', runtime: 'not_configured' },
    });
    expect(inventory.items.find((item) => item.id === 'curated:mcp_template%3Amcp-filesystem-readonly')).toMatchObject({
      kind: 'mcp_template',
      source: { kind: 'curated' },
      state: { install: 'available', enable: 'not_applicable', runtime: 'not_configured' },
      actions: {
        canEnable: false,
        canDisable: false,
        canInstallDraft: true,
      },
      installPlan: {
        mode: 'draft_config',
        draft: {
          kind: 'mcp_server',
          parameters: [
            {
              key: 'allowedRoot',
              label: 'allowedRoot',
              kind: 'path',
              required: true,
            },
          ],
        },
        writes: [
          {
            target: 'project .code-agent/mcp.json',
          },
        ],
      },
    });
    expect(JSON.stringify(inventory.items)).not.toContain('super-secret-api-key');
    expect(JSON.stringify(inventory.items)).not.toContain('raw-token');
    expect(inventory.summary.total).toBe(inventory.items.length);
  });

  it('loads project curated registry templates as read-only available cards', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-capability-registry-'));
    const registryDir = path.join(workspace, '.code-agent', 'capabilities');
    await fs.mkdir(registryDir, { recursive: true });
    await fs.writeFile(path.join(registryDir, 'unsafe-template.json'), JSON.stringify({
      source: {
        label: 'Unsafe fixture',
        reviewedAt: '2026-05-15',
        contentHash: `sha256:${'0'.repeat(64)}`,
      },
      items: [
        {
          id: 'ignored-skill',
          kind: 'skill',
          name: 'Ignored Skill',
          summary: 'Registry must not mint installed skills.',
        },
        {
          id: 'missing-summary',
          kind: 'workflow_recipe',
          name: 'Missing Summary',
        },
        {
          id: 'unsafe-enabled-mcp',
          kind: 'mcp_template',
          name: 'Unsafe Enabled MCP',
          summary: 'A fixture that tries to smuggle enabled state through registry metadata.',
          tags: ['fixture'],
          state: { install: 'installed', enable: 'enabled', runtime: 'connected' },
          actions: { canEnable: true, canDisable: true },
          config: [{ kind: 'env', label: 'TOKEN', value: 'registry-secret', status: 'missing', sensitive: true }],
          risk: {
            tier: 'high',
            reasons: ['Fixture declares dangerous runtime state'],
          },
        },
        {
          id: 'installable-mcp',
          kind: 'mcp_template',
          name: 'Installable MCP',
          summary: 'A fixture with a complete local stdio draft spec.',
          install: {
            mcpServer: {
              name: 'installable_mcp',
              type: 'stdio',
              command: 'node',
              args: ['server.js'],
            },
          },
        },
        {
          id: 'placeholder-mcp',
          kind: 'mcp_template',
          name: 'Placeholder MCP',
          summary: 'A fixture with unresolved template placeholders.',
          config: [
            {
              kind: 'path',
              label: 'allowedRoot',
              status: 'missing',
            },
          ],
          install: {
            mcpServer: {
              name: 'placeholder_mcp',
              type: 'stdio',
              command: 'node',
              args: ['{{allowedRoot}}'],
            },
          },
        },
        {
          id: 'mcp-filesystem-readonly',
          kind: 'mcp_template',
          name: 'Duplicate Filesystem MCP',
          summary: 'This duplicates the repository curated registry id and must be skipped.',
        },
      ],
    }));
    await fs.writeFile(path.join(registryDir, 'bad-json.json'), '{bad json');
    await fs.writeFile(path.join(registryDir, 'invalid-items.json'), JSON.stringify({
      source: { label: 'Invalid fixture' },
      items: { id: 'not-an-array' },
    }));
    await fs.writeFile(path.join(registryDir, 'invalid-hash.json'), JSON.stringify({
      source: {
        label: 'Invalid hash fixture',
        contentHash: 'sha256:not-a-real-hash',
      },
      items: [
        {
          id: 'invalid-hash-template',
          kind: 'workflow_recipe',
          name: 'Invalid Hash Template',
          summary: 'Valid template with an invalid source hash declaration.',
        },
      ],
    }));

    const service = new CapabilityCenterService();
    const inventory = await service.listCapabilities({
      workingDirectory: workspace,
      configService: {
        getSettings: () => ({ connectors: { enabledNative: [] } }),
        updateSettings: configUpdateSettings,
      } as never,
    });

    expect(inventory.items.find((item) => item.id === 'curated:mcp_template%3Aunsafe-enabled-mcp')).toMatchObject({
      kind: 'mcp_template',
      source: { kind: 'curated', label: 'Unsafe fixture' },
      state: {
        install: 'available',
        enable: 'not_applicable',
        runtime: 'not_configured',
      },
      actions: {
        canEnable: false,
        canDisable: false,
      },
    });
    const unsafeItem = inventory.items.find((item) => item.id === 'curated:mcp_template%3Aunsafe-enabled-mcp');
    expect(unsafeItem).toMatchObject({
      source: { contentHash: `sha256:${'0'.repeat(64)}` },
      config: [{ label: 'TOKEN', sensitive: true }],
      installPlan: {
        mode: 'preview_only',
        summary: expect.stringContaining('不会写 mcp.json'),
      },
    });
    expect(unsafeItem?.source.registryFileHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(unsafeItem?.config[0]?.value).toBeUndefined();
    expect(inventory.items.find((item) => item.id === 'curated:mcp_template%3Ainstallable-mcp')).toMatchObject({
      actions: { canInstallDraft: true },
      installPlan: {
        mode: 'draft_config',
        draft: {
          kind: 'mcp_server',
          name: 'installable_mcp',
        },
      },
    });
    expect(inventory.items.find((item) => item.id === 'curated:mcp_template%3Aplaceholder-mcp')).toMatchObject({
      actions: { canInstallDraft: true },
      installPlan: {
        mode: 'draft_config',
        draft: {
          parameters: [
            {
              key: 'allowedRoot',
              label: 'allowedRoot',
              kind: 'path',
              required: true,
            },
          ],
        },
      },
    });
    expect(inventory.items.find((item) => item.id === 'curated:skill%3Aignored-skill')).toBeUndefined();
    expect(inventory.items.find((item) => item.id === 'curated:workflow_recipe%3Amissing-summary')).toBeUndefined();
    expect(inventory.items.filter((item) => item.id === 'curated:mcp_template%3Amcp-filesystem-readonly')).toHaveLength(1);
    expect(inventory.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'unsupported_kind',
      'missing_required_field',
      'duplicate_registry_item',
      'invalid_registry_json',
      'invalid_registry_items',
      'content_hash_mismatch',
      'invalid_content_hash',
    ]));
    expect(inventory.diagnostics?.some((diagnostic) => diagnostic.itemId === 'ignored-skill')).toBe(true);
    expect(JSON.stringify(inventory.items)).not.toContain('registry-secret');
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('delegates enablement to existing services instead of installing remote templates', async () => {
    const service = new CapabilityCenterService();
    const configService = {
      getSettings: () => ({ connectors: { enabledNative: ['calendar'] } }),
      updateSettings: configUpdateSettings,
    } as never;

    await service.setEnabled({ id: 'skill:slides', kind: 'skill', enabled: true }, { configService });
    expect(skillEnable).toHaveBeenCalledWith('slides');
    expect(skillRefresh).toHaveBeenCalled();

    await service.setEnabled({ id: 'mcp:github', kind: 'mcp_template', enabled: false }, { configService });
    expect(mcpSetEnabled).toHaveBeenCalledWith('github', false);
    expect(clearMcpContext).toHaveBeenCalledWith('github');

    await service.setEnabled({ id: 'connector:mail', kind: 'connector', enabled: true }, { configService });
    expect(configUpdateSettings).toHaveBeenCalledWith({
      connectors: { enabledNative: ['calendar', 'mail'] },
    });
    expect(connectorConfigure).toHaveBeenCalledWith(['calendar', 'mail']);

    await service.setEnabled({ id: 'channel:acct-1', kind: 'channel_adapter', enabled: false }, { configService });
    expect(channelUpdateAccount).toHaveBeenCalledWith('acct-1', { enabled: false });
  });

  it('generates a disabled MCP draft without enabling or connecting it', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-capability-install-'));
    const registryDir = path.join(workspace, '.code-agent', 'capabilities');
    await fs.mkdir(registryDir, { recursive: true });
    await fs.writeFile(path.join(registryDir, 'installable.json'), JSON.stringify({
      source: {
        label: 'Install fixture',
        reviewedAt: '2026-05-15',
      },
      items: [
        {
          id: 'parameterized-mcp',
          kind: 'mcp_template',
          name: 'Parameterized MCP',
          summary: 'A fixture with a required user-provided path.',
          config: [
            {
              kind: 'path',
              label: 'allowedRoot',
              status: 'missing',
            },
          ],
          install: {
            mcpServer: {
              name: 'parameterized_mcp',
              type: 'stdio',
              command: 'node',
              args: ['server.js', '{{allowedRoot}}'],
            },
          },
        },
      ],
    }));

    const service = new CapabilityCenterService();
    const configService = {
      getSettings: () => ({ connectors: { enabledNative: [] } }),
      updateSettings: configUpdateSettings,
    } as never;

    await expect(service.installDraft(
      { id: 'curated:mcp_template%3Aparameterized-mcp', kind: 'mcp_template' },
      { workingDirectory: workspace, configService },
    )).rejects.toThrow('allowedRoot');

    const afterInstall = await service.installDraft(
      { id: 'curated:mcp_template%3Aparameterized-mcp', kind: 'mcp_template', inputs: { allowedRoot: '/tmp/capability-root' } },
      { workingDirectory: workspace, configService },
    );

    const persisted = JSON.parse(
      await fs.readFile(path.join(workspace, '.code-agent', 'mcp.json'), 'utf8'),
    ) as { servers: Array<Record<string, unknown>> };
    expect(persisted.servers).toEqual([
      expect.objectContaining({
        name: 'parameterized_mcp',
        type: 'stdio',
        command: 'node',
        args: ['server.js', '/tmp/capability-root'],
        enabled: false,
        lazyLoad: true,
        capabilityDraft: expect.objectContaining({
          origin: 'capability_center',
          capabilityId: 'curated:mcp_template%3Aparameterized-mcp',
          capabilityKind: 'mcp_template',
          installedAt: expect.any(Number),
        }),
      }),
    ]);
    expect(mcpAddServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'parameterized_mcp',
      enabled: false,
      lazyLoad: true,
      scope: 'project',
      capabilityDraft: expect.objectContaining({
        capabilityId: 'curated:mcp_template%3Aparameterized-mcp',
      }),
    }));
    expect(mcpSetEnabled).not.toHaveBeenCalled();

    expect(afterInstall.items.find((item) => item.id === 'curated:mcp_template%3Aparameterized-mcp')).toMatchObject({
      state: {
        install: 'draft',
        enable: 'disabled',
        runtime: 'not_configured',
        statusLabel: 'draft',
      },
      actions: {
        canInstallDraft: false,
        canRemoveDraft: true,
      },
      relatedIds: ['mcp:parameterized_mcp'],
    });

    await service.removeDraft(
      { id: 'curated:mcp_template%3Aparameterized-mcp', kind: 'mcp_template' },
      { workingDirectory: workspace, configService },
    );
    const rolledBack = JSON.parse(
      await fs.readFile(path.join(workspace, '.code-agent', 'mcp.json'), 'utf8'),
    ) as { servers: Array<Record<string, unknown>> };
    expect(rolledBack.servers).toEqual([]);
    expect(mcpRemoveServer).toHaveBeenCalledWith('parameterized_mcp');
    expect(clearMcpContext).toHaveBeenCalledWith('parameterized_mcp');

    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('rejects non-toggleable capability actions before they reach runtime services', async () => {
    const service = new CapabilityCenterService();
    const configService = {
      getSettings: () => ({ connectors: { enabledNative: ['calendar'] } }),
      updateSettings: configUpdateSettings,
    } as never;

    await expect(service.setEnabled(
      { id: 'tool-bundle:core-tools', kind: 'tool_bundle', enabled: false },
      { configService },
    )).rejects.toThrow('内置工具包');
    await expect(service.setEnabled(
      { id: 'channel-template:feishu', kind: 'channel_adapter', enabled: true },
      { configService },
    )).rejects.toThrow('Channels 设置');
    await expect(service.setEnabled(
      { id: 'skill:research', kind: 'skill', enabled: false },
      { configService },
    )).rejects.toThrow('library skill');
    await expect(service.setEnabled(
      { id: 'curated:mcp_template%3Amcp-filesystem-readonly', kind: 'mcp_template', enabled: true },
      { configService },
    )).rejects.toThrow('disabled MCP');

    expect(skillDisable).not.toHaveBeenCalled();
    expect(channelUpdateAccount).not.toHaveBeenCalled();
    expect(mcpSetEnabled).not.toHaveBeenCalled();
  });
});
