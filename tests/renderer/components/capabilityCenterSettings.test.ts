import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CapabilityCenterDiagnostic,
  CapabilityCenterInventory,
  CapabilityCenterItem,
} from '../../../src/shared/contract/capability';

const mocks = vi.hoisted(() => ({
  useCapabilityInventory: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useCapabilityInventory', () => ({
  useCapabilityInventory: mocks.useCapabilityInventory,
}));

import { CapabilityCenterSettings } from '../../../src/renderer/components/features/settings/tabs/CapabilityCenterSettings';

function makeItem(overrides: Partial<CapabilityCenterItem>): CapabilityCenterItem {
  return {
    id: 'capability:test',
    kind: 'tool_bundle',
    name: 'Test capability',
    summary: 'A local capability.',
    tags: [],
    source: {
      kind: 'builtin',
      label: '内置',
    },
    state: {
      install: 'installed',
      enable: 'enabled',
      runtime: 'ready',
      mount: 'not_applicable',
    },
    risk: {
      tier: 'low',
      reasons: ['local only'],
    },
    permissions: [],
    config: [],
    dependencies: [],
    audit: {},
    actions: {
      canEnable: false,
      canDisable: false,
      reason: 'read only',
    },
    ...overrides,
  };
}

function mockInventory(
  items: CapabilityCenterItem[],
  diagnostics: CapabilityCenterDiagnostic[] = [],
  overrides: Record<string, unknown> = {},
): void {
  const inventory: CapabilityCenterInventory = {
    generatedAt: 1,
    summary: {
      total: items.length,
      installed: items.length,
      enabled: items.filter((item) => item.state.enable === 'enabled').length,
      blocked: 0,
      highRisk: 0,
    },
    items,
    diagnostics,
  };

  mocks.useCapabilityInventory.mockReturnValue({
    inventory,
    items,
    loading: false,
    error: null,
    actionResult: null,
    actionKey: null,
    reload: vi.fn(),
    clearActionResult: vi.fn(),
    setEnabled: vi.fn(),
    installDraft: vi.fn(),
    removeDraft: vi.fn(),
    ...overrides,
  });
}

describe('CapabilityCenterSettings', () => {
  beforeEach(() => {
    mocks.useCapabilityInventory.mockReset();
  });

  it('routes configurable templates to their existing settings surface', () => {
    mockInventory([
      makeItem({
        id: 'channel-template:http-api',
        kind: 'channel_adapter',
        name: 'HTTP API',
        state: {
          install: 'available',
          enable: 'not_applicable',
          runtime: 'not_configured',
          mount: 'not_applicable',
        },
        actions: {
          canEnable: false,
          canDisable: false,
          reason: '请在 Channels 设置中添加账号',
        },
      }),
      makeItem({
        id: 'tool-bundle:core-tools',
        kind: 'tool_bundle',
        name: '核心工具包',
        actions: {
          canEnable: false,
          canDisable: false,
          reason: '内置工具包只读',
        },
      }),
    ]);

    const html = renderToStaticMarkup(
      React.createElement(CapabilityCenterSettings, { onNavigateSettings: vi.fn() }),
    );

    expect(html).toContain('去配置');
    expect(html).toContain('只读');
    expect(html).not.toContain('<span>禁用</span></button>');
  });

  it('shows source filters and available template count for curated registry entries', () => {
    mockInventory([
      makeItem({
        id: 'curated:mcp_template%3Amcp-filesystem-readonly',
        kind: 'mcp_template',
        name: 'Filesystem MCP template',
        source: {
          kind: 'curated',
          label: '本地 curated registry',
          author: 'Code Agent',
          reviewedAt: '2026-05-15',
          contentHash: 'sha256:fixture',
          registryFileHash: `sha256:${'a'.repeat(64)}`,
        },
        state: {
          install: 'available',
          enable: 'not_applicable',
          runtime: 'not_configured',
          mount: 'not_applicable',
        },
        actions: {
          canEnable: false,
          canDisable: false,
          reason: '请在 MCP 设置中添加 server',
        },
      }),
    ]);

    const html = renderToStaticMarkup(
      React.createElement(CapabilityCenterSettings, { onNavigateSettings: vi.fn() }),
    );

    expect(html).toContain('Curated');
    expect(html).toContain('模板');
    expect(html).toContain('Filesystem MCP template');
    expect(html).toContain('去配置');
    expect(html).toContain('author Code Agent');
    expect(html).toContain('reviewed 2026-05-15');
    expect(html).toContain('hash sha256:fixture');
    expect(html).toContain(`registry hash sha256:${'a'.repeat(64)}`);
  });

  it('shows external engine status, version, cwd, and read-only guard on the card', () => {
    mockInventory([
      makeItem({
        id: 'agent-engine:codex_cli',
        kind: 'agent_engine',
        name: 'Codex CLI',
        summary: 'Runs Codex CLI through a controlled workspace cwd.',
        source: {
          kind: 'runtime',
          label: '运行时',
          path: '/usr/local/bin/codex',
          version: 'codex-cli 0.130.0',
        },
        state: {
          install: 'installed',
          enable: 'not_applicable',
          runtime: 'ready',
          mount: 'not_applicable',
          statusLabel: '版本检测通过',
        },
        risk: {
          tier: 'medium',
          reasons: ['外部 engine 只允许在当前 workspace cwd 内运行'],
        },
        permissions: [
          {
            label: 'Read-only default',
            level: 'low',
            detail: '当前版本外部 engine 手动选择后默认使用 read_only profile',
          },
        ],
        config: [
          {
            kind: 'config',
            label: 'Launch mode',
            status: 'met',
            value: 'external CLI',
          },
          {
            kind: 'config',
            label: 'Permission profile',
            status: 'met',
            value: 'read_only',
          },
          {
            kind: 'config',
            label: 'Workspace policy',
            status: 'met',
            value: 'current workspace only',
          },
        ],
        audit: {
          installedFiles: ['/usr/local/bin/codex'],
          notes: [
            'command: codex exec --json',
            'cwd policy: workspace_only',
            'detected at: 2026-05-16T00:00:00.000Z',
          ],
        },
        actions: {
          canEnable: false,
          canDisable: false,
          reason: 'Agent Engine 的检测、启用和执行入口分开管理',
        },
      }),
    ]);

    const html = renderToStaticMarkup(
      React.createElement(CapabilityCenterSettings, { onNavigateSettings: vi.fn() }),
    );

    expect(html).toContain('Engine');
    expect(html).toContain('Codex CLI');
    expect(html).toContain('外部 CLI');
    expect(html).toContain('只读默认');
    expect(html).toContain('当前 workspace');
    expect(html).toContain('codex-cli 0.130.0');
    expect(html).toContain('/usr/local/bin/codex');
    expect(html).toContain('检测状态');
    expect(html).toContain('permission read_only');
    expect(html).toContain('cwd current workspace only');
  });

  it('keeps toggle labels for capabilities that can be enabled or disabled', () => {
    mockInventory([
      makeItem({
        id: 'skill:docx',
        kind: 'skill',
        name: 'docx',
        actions: {
          canEnable: true,
          canDisable: true,
        },
      }),
      makeItem({
        id: 'mcp:filesystem',
        kind: 'mcp_template',
        name: 'filesystem',
        state: {
          install: 'installed',
          enable: 'disabled',
          runtime: 'disconnected',
          mount: 'not_applicable',
        },
        actions: {
          canEnable: true,
          canDisable: true,
        },
      }),
    ]);

    const html = renderToStaticMarkup(
      React.createElement(CapabilityCenterSettings, { onNavigateSettings: vi.fn() }),
    );

    expect(html).toContain('禁用');
    expect(html).toContain('启用');
  });

  it('shows install preview for curated available templates without enabling them', () => {
    mockInventory([
      makeItem({
        id: 'curated:mcp_template%3Amcp-filesystem-readonly',
        kind: 'mcp_template',
        name: 'Filesystem MCP template',
        source: {
          kind: 'curated',
          label: '本地 curated registry',
        },
        state: {
          install: 'available',
          enable: 'not_applicable',
          runtime: 'not_configured',
          mount: 'not_applicable',
        },
        actions: {
          canEnable: false,
          canDisable: false,
          reason: '请在 MCP 设置中添加 server',
        },
        installPlan: {
          mode: 'preview_only',
          title: '安装预览: Filesystem MCP template',
          summary: '生成 disabled MCP server 草稿的预览；不会写 mcp.json、不会启动进程、不会连接 server。',
          writes: [
            {
              kind: 'config',
              target: 'project or user mcp.json',
              action: 'create',
              note: 'Draft must use enabled:false and lazyLoad:true before explicit user enablement.',
            },
          ],
          steps: ['确认 server name、transport、command/url 和必填配置。'],
          safety: ['No command execution during preview.'],
          rollback: ['Remove the generated disabled MCP server draft from mcp.json.'],
        },
      }),
    ]);

    const html = renderToStaticMarkup(
      React.createElement(CapabilityCenterSettings, { onNavigateSettings: vi.fn() }),
    );

    expect(html).toContain('安装预览');
    expect(html).toContain('preview_only');
    expect(html).toContain('project or user mcp.json');
    expect(html).toContain('No command execution during preview.');
    expect(html).not.toContain('<span>启用</span></button>');
  });

  it('shows draft install action only for templates with a safe draft spec', () => {
    mockInventory([
      makeItem({
        id: 'curated:mcp_template%3Ainstallable-mcp',
        kind: 'mcp_template',
        name: 'Installable MCP template',
        source: {
          kind: 'curated',
          label: '本地 curated registry',
        },
        state: {
          install: 'available',
          enable: 'not_applicable',
          runtime: 'not_configured',
          mount: 'not_applicable',
        },
        actions: {
          canEnable: false,
          canDisable: false,
          canInstallDraft: true,
          reason: '可生成 disabled MCP server 草稿',
        },
        config: [
          {
            kind: 'path',
            label: 'allowedRoot',
            status: 'missing',
          },
        ],
        installPlan: {
          mode: 'draft_config',
          title: '生成草稿: Installable MCP template',
          summary: '写入 disabled MCP server 草稿；不会启动进程、不会连接 server、不会启用工具。',
          writes: [
            {
              kind: 'config',
              target: 'project .code-agent/mcp.json',
              action: 'create',
            },
          ],
          steps: ['写入 disabled MCP server draft，并在 MCP 设置中展示。'],
          safety: ['No package install or command execution during draft install.'],
          rollback: ['Remove the generated disabled MCP server draft from .code-agent/mcp.json.'],
          draft: {
            kind: 'mcp_server',
            target: 'project_mcp_json',
            name: 'installable_mcp',
            parameters: [
              {
                key: 'allowedRoot',
                label: 'allowedRoot',
                kind: 'path',
                required: true,
                placeholder: '{{allowedRoot}}',
              },
            ],
            config: {
              name: 'installable_mcp',
              type: 'stdio',
              command: 'node',
              args: ['server.js', '{{allowedRoot}}'],
            },
          },
        },
      }),
    ]);

    const html = renderToStaticMarkup(
      React.createElement(CapabilityCenterSettings, { onNavigateSettings: vi.fn() }),
    );

    expect(html).toContain('生成草稿');
    expect(html).toContain('draft_config');
    expect(html).toContain('allowedRoot');
    expect(html).toContain('/path/to/folder');
    expect(html).toContain('缺少 allowedRoot');
    expect(html).toContain('No package install or command execution during draft install.');
    expect(html).not.toContain('安装预览</span></button>');
  });

  it('shows rollback action for generated capability drafts', () => {
    mockInventory([
      makeItem({
        id: 'curated:mcp_template%3Aparameterized-mcp',
        kind: 'mcp_template',
        name: 'Parameterized MCP template',
        source: {
          kind: 'curated',
          label: '本地 curated registry',
        },
        state: {
          install: 'draft',
          enable: 'disabled',
          runtime: 'not_configured',
          mount: 'not_applicable',
          statusLabel: 'draft',
        },
        actions: {
          canEnable: false,
          canDisable: false,
          canInstallDraft: false,
          canRemoveDraft: true,
          reason: '已生成 disabled MCP draft，可删除草稿或到 MCP 设置中管理',
        },
        audit: {
          configFiles: ['project:mcp.json'],
          notes: ['Draft generated as disabled MCP server "parameterized_mcp".'],
        },
        relatedIds: ['mcp:parameterized_mcp'],
        installPlan: {
          mode: 'draft_config',
          title: '生成草稿: Parameterized MCP template',
          summary: '写入 disabled MCP server 草稿；不会启动进程、不会连接 server、不会启用工具。',
          writes: [],
          steps: [],
          safety: [],
          rollback: ['Remove the generated disabled MCP server draft from .code-agent/mcp.json.'],
        },
      }),
    ]);

    const html = renderToStaticMarkup(
      React.createElement(CapabilityCenterSettings, { onNavigateSettings: vi.fn() }),
    );

    expect(html).toContain('删除草稿');
    expect(html).toContain('去管理');
    expect(html).toContain('draft');
    expect(html).toContain('project:mcp.json');
    expect(html).toContain('Draft generated as disabled MCP server');
    expect(html).not.toContain('生成草稿</span></button>');
  });

  it('shows successful capability action feedback', () => {
    mockInventory(
      [
        makeItem({
          id: 'curated:mcp_template%3Aparameterized-mcp',
          kind: 'mcp_template',
          name: 'Parameterized MCP template',
          source: {
            kind: 'curated',
            label: '本地 curated registry',
          },
        }),
      ],
      [],
      {
        actionResult: {
          type: 'success',
          text: 'Parameterized MCP template 草稿已生成',
        },
      },
    );

    const html = renderToStaticMarkup(
      React.createElement(CapabilityCenterSettings, { onNavigateSettings: vi.fn() }),
    );

    expect(html).toContain('Parameterized MCP template 草稿已生成');
  });

  it('shows registry diagnostics without turning them into install actions', () => {
    mockInventory(
      [
        makeItem({
          id: 'tool-bundle:core-tools',
          kind: 'tool_bundle',
          name: '核心工具包',
        }),
      ],
      [
        {
          source: 'registry',
          severity: 'warning',
          code: 'content_hash_mismatch',
          message: 'Registry source.contentHash does not match the canonical local registry content hash.',
          path: '/repo/.code-agent/capabilities/bad.json',
          expectedHash: `sha256:${'0'.repeat(64)}`,
          actualHash: `sha256:${'b'.repeat(64)}`,
        },
      ],
    );

    const html = renderToStaticMarkup(
      React.createElement(CapabilityCenterSettings, { onNavigateSettings: vi.fn() }),
    );

    expect(html).toContain('Registry warnings');
    expect(html).toContain('content_hash_mismatch');
    expect(html).toContain(`expected sha256:${'0'.repeat(64)}`);
    expect(html).toContain(`actual sha256:${'b'.repeat(64)}`);
    expect(html).toContain('坏文件或坏项会被跳过');
    expect(html).not.toContain('去配置');
  });
});
