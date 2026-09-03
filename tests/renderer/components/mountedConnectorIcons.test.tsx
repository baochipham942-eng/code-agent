// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const composerState = {
  selectedSkillIds: [] as string[],
  selectedConnectorIds: ['tmeet'],
  selectedMcpServerIds: [] as string[],
  setTurnCapabilityScopeMode: vi.fn(),
  setSelectedSkillIds: vi.fn((ids: string[]) => { composerState.selectedSkillIds = ids; }),
  setSelectedConnectorIds: vi.fn((ids: string[]) => { composerState.selectedConnectorIds = ids; }),
  setSelectedMcpServerIds: vi.fn((ids: string[]) => { composerState.selectedMcpServerIds = ids; }),
};

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: Object.assign(
    (selector: (state: typeof composerState) => unknown) => selector(composerState),
    { getState: () => composerState },
  ),
}));

const makeConnector = (id: string, selected = true, available = true, label?: string) => ({
  kind: 'connector' as const,
  key: `connector:${id}`,
  id,
  label: label ?? id,
  selected,
  available,
  connected: available,
  blocked: false,
  lifecycle: { installState: 'installed', mountState: 'mounted', connectionState: available ? 'connected' : 'disconnected' },
});

const registryState = {
  connectors: [makeConnector('tmeet')],
  mcpServers: [] as any[],
};

// 专家那颗与手选那颗的 MCP 状态取自注册表 mcpServers——真实管线里它是全量的
//（withMissingMcpServers 补齐 lazy / 被关掉的，带 status + enabled），夹具就按这个形状给
const makeServerState = (name: string, status: string, enabled = true) => ({
  kind: 'mcp' as const,
  key: `mcp:${name}`,
  id: name,
  label: name,
  selected: false,
  status,
  enabled,
  available: status === 'connected',
});
vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({ items: [], skills: [], ...registryState }),
}));

// CLI / SaaS 连接器（feishu/tmeet）的登录态走另一条 oauthStatus 通道
const oauthStatusesState = [] as { id: string; connected: boolean; stale?: boolean }[];
vi.mock('../../../src/renderer/hooks/useConnectorOAuthStatuses', () => ({
  useConnectorOAuthStatuses: () => oauthStatusesState,
}));

const openCapabilitySettingsTarget = vi.fn();
const appState = {
  activeAgentId: null as string | null,
  openCapabilitySettingsTarget,
};
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

const agentRegistryState = { entries: [] as any[] };
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector: (state: typeof agentRegistryState) => unknown) => selector(agentRegistryState),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});

import { MountedConnectorIcons } from '../../../src/renderer/components/features/chat/ChatInput/MountedConnectorIcons';

const WEEKLY_EXPERT = {
  id: 'weekly',
  name: '周报专家',
  icon: 'FileText',
  connectors: [{ id: 'tmeet-mcp', level: 'core' as const, reason: '读取会议纪要，整理进周报' }],
};

beforeEach(() => {
  cleanup();
  composerState.selectedConnectorIds = ['tmeet'];
  composerState.selectedMcpServerIds = [];
  registryState.connectors = [makeConnector('tmeet')];
  registryState.mcpServers = [];
  oauthStatusesState.length = 0;
  appState.activeAgentId = null;
  agentRegistryState.entries = [];
  vi.clearAllMocks();
});

describe('MountedConnectorIcons（底栏挂载连接器 chip）', () => {
  it('常驻显示已挂载 connector 的名称，并提供独立移除动作', () => {
    render(<MountedConnectorIcons />);

    const chip = screen.getByTestId('mounted-capability-connector-tmeet');
    expect(chip.textContent).toContain('腾讯会议');
    expect(chip.textContent).not.toContain('tmeet');
    const logo = screen.getByRole('img', { name: '腾讯会议' });
    expect(logo.parentElement?.className).toContain('h-3');
    expect(logo.parentElement?.className).toContain('w-3');
    expect(screen.getByRole('button', { name: '取消挂载 腾讯会议' })).toBeTruthy();
    expect(screen.getByTestId('mounted-connector-icons')).toBeTruthy();
  });

  it('点击 chip 的移除动作取消挂载', () => {
    render(<MountedConnectorIcons />);

    fireEvent.click(screen.getByRole('button', { name: '取消挂载 腾讯会议' }));

    expect(composerState.selectedConnectorIds).toEqual([]);
  });

  it('无挂载、专家也没声明时不渲染', () => {
    registryState.connectors = [makeConnector('tmeet', false)];
    const { container } = render(<MountedConnectorIcons />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('mounted-connector-icons')).toBeNull();
  });

  it('悬停手选的那颗：来源写「你在本会话加的」，状态写已连接；移开即走', () => {
    // CLI 连接器的真实形状：注册表里 available 恒 false，连没连看 oauthStatus
    registryState.connectors = [makeConnector('tmeet', true, false)];
    oauthStatusesState.push({ id: 'tmeet', connected: true });
    render(<MountedConnectorIcons />);
    const hoverId = 'mounted-capability-source-connector-tmeet';
    expect(screen.queryByTestId(hoverId)).toBeNull();

    const chip = screen.getByTestId('mounted-capability-connector-tmeet');
    fireEvent.mouseEnter(chip.parentElement!);
    const card = screen.getByTestId(hoverId);
    expect(card.textContent).toContain('你在本会话加的');
    expect(card.textContent).toContain('已连接');

    fireEvent.mouseLeave(chip.parentElement!);
    expect(screen.queryByTestId(hoverId)).toBeNull();
  });

  it('手选的那颗没连上：卡里给「去能力中心连接」，点了带 id 跳过去', () => {
    registryState.connectors = [makeConnector('tmeet', true, false)];
    render(<MountedConnectorIcons />);

    fireEvent.mouseEnter(screen.getByTestId('mounted-capability-connector-tmeet').parentElement!);
    const card = screen.getByTestId('mounted-capability-source-connector-tmeet');
    expect(card.textContent).toContain('未连接');
    fireEvent.click(screen.getByRole('button', { name: /去能力中心连接/ }));

    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({ kind: 'connector', id: 'tmeet' });
  });

  it('手选超过 4 颗折成 +N，不把底栏撑爆；点开 +N 能看到被折的并保留 × 移除入口', () => {
    registryState.connectors = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => makeConnector(id));
    render(<MountedConnectorIcons />);

    expect(screen.getAllByTestId(/^mounted-capability-connector-/)).toHaveLength(4);
    expect(screen.getByTestId('mounted-capability-overflow').textContent).toBe('+2');

    // 被折掉的第 5、6 颗不能丢 × 移除入口（ai-review 第十一轮 Nit）
    fireEvent.click(screen.getByTestId('mounted-capability-overflow'));
    expect(screen.getAllByTestId(/^mounted-capability-connector-/)).toHaveLength(6);
    expect(screen.getByRole('button', { name: '取消挂载 f' })).toBeTruthy();

    fireEvent.click(screen.getByTestId('mounted-capability-overflow'));
    expect(screen.getAllByTestId(/^mounted-capability-connector-/)).toHaveLength(4);
  });

  it('专家声明的 core 连接器：底栏多一颗组合 chip（徽标+条数），没有移除键', () => {
    composerState.selectedConnectorIds = [];
    registryState.connectors = [makeConnector('tmeet', false)];
    registryState.mcpServers.push(makeServerState('tmeet-mcp', 'connected'));
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [WEEKLY_EXPERT];
    render(<MountedConnectorIcons />);

    const badge = screen.getByTestId('expert-connector-badge');
    expect(badge.textContent).toContain('1');
    expect(badge.getAttribute('aria-label')).toContain('周报专家');
    expect(screen.queryByRole('button', { name: /取消挂载/ })).toBeNull();
    expect(screen.queryByTestId('expert-connector-badge-issue')).toBeNull();

    fireEvent.mouseEnter(badge.parentElement!);
    const card = screen.getByTestId('expert-connector-source');
    expect(card.textContent).toContain('周报专家 需要它：读取会议纪要，整理进周报');
    expect(card.textContent).toContain('已连接');
    expect(card.textContent).not.toContain('这轮以你选的连接器为准');
  });

  it('专家声明的是 CLI 连接器时：卡上的名字和底栏手选那颗同一套，跳转也走 connector', () => {
    composerState.selectedConnectorIds = [];
    // tmeet 没连上也不在手选里 ⇒ 真实管线里注册表查无此条，kind 靠 CLI descriptor 归侧（不靠夹具塞记录）
    registryState.connectors = [];
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [{
      id: 'weekly',
      name: '周报专家',
      connectors: [{ id: 'tmeet', level: 'core' as const }],
    }];
    render(<MountedConnectorIcons />);

    fireEvent.mouseEnter(screen.getByTestId('expert-connector-badge').parentElement!);
    const card = screen.getByTestId('expert-connector-source');
    expect(card.textContent).toContain('腾讯会议');
    expect(card.textContent).not.toContain('tmeet');
    fireEvent.click(screen.getByRole('button', { name: /去能力中心连接/ }));
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({ kind: 'connector', id: 'tmeet' });
  });

  it('用户在本会话手选过连接器：专家那颗照露，但卡上说明这轮没用它', () => {
    composerState.selectedConnectorIds = ['tmeet'];
    registryState.mcpServers.push(makeServerState('tmeet-mcp', 'connected'));
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [WEEKLY_EXPERT];
    render(<MountedConnectorIcons />);

    fireEvent.mouseEnter(screen.getByTestId('expert-connector-badge').parentElement!);
    expect(screen.getByTestId('expert-connector-source').textContent).toContain('这轮以你选的连接器为准');
  });

  it('只手选了 MCP（没选连接器）时，专家那颗同样标让位', () => {
    composerState.selectedConnectorIds = [];
    composerState.selectedMcpServerIds = ['some-mcp'];
    registryState.mcpServers.push(makeServerState('tmeet-mcp', 'connected'));
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [WEEKLY_EXPERT];
    render(<MountedConnectorIcons />);

    fireEvent.mouseEnter(screen.getByTestId('expert-connector-badge').parentElement!);
    expect(screen.getByTestId('expert-connector-source').textContent).toContain('这轮以你选的连接器为准');
  });

  it('专家要的连接器在能力中心被关了：组合 chip 挂警示点，卡里写清楚本轮不会用', () => {
    composerState.selectedConnectorIds = [];
    registryState.connectors = [makeConnector('tmeet', false)];
    // 真实管线产得出的形状：被关的 server 没连上也没被手选，只出现在全量 serverStates 里
    registryState.mcpServers.push(makeServerState('tmeet-mcp', 'disconnected', false));
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [WEEKLY_EXPERT];
    render(<MountedConnectorIcons />);

    expect(screen.getByTestId('expert-connector-badge-issue')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByTestId('expert-connector-badge').parentElement!);
    const card = screen.getByTestId('expert-connector-source');
    expect(card.textContent).toContain('已在能力中心关闭，本轮不会用');
    fireEvent.click(screen.getByRole('button', { name: /去能力中心/ }));
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({ kind: 'mcp', id: 'tmeet-mcp' });
  });

  // ai-review 第七轮 Important 1：stdio 默认 lazyLoad，装好且 enabled 的 server 停在 lazy——
  // 它是健康配置，以前从不进过滤后的注册表列表，被稳定误报成「未连接」+ 假警示点
  it('专家要的 MCP 是 lazy（装好了、用到才连）：不挂警示点，卡里写「已装好」，不给「去连接」出口', () => {
    composerState.selectedConnectorIds = [];
    registryState.connectors = [makeConnector('tmeet', false)];
    registryState.mcpServers.push(makeServerState('tmeet-mcp', 'lazy'));
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [WEEKLY_EXPERT];
    render(<MountedConnectorIcons />);

    expect(screen.queryByTestId('expert-connector-badge-issue')).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId('expert-connector-badge').parentElement!);
    const card = screen.getByTestId('expert-connector-source');
    expect(card.textContent).toContain('已装好，用到时自动连接');
    expect(card.textContent).not.toContain('未连接');
    expect(screen.queryByRole('button', { name: /去能力中心/ })).toBeNull();
  });

  it('手选的 MCP 是 lazy：同样不误报「未连接」，且名字走目录（与专家卡同一套）', () => {
    composerState.selectedConnectorIds = [];
    composerState.selectedMcpServerIds = ['lark'];
    registryState.connectors = [makeConnector('tmeet', false)];
    registryState.mcpServers = [{ kind: 'mcp', key: 'mcp:lark', id: 'lark', label: 'lark', selected: true, status: 'lazy', enabled: true, available: false }];
    render(<MountedConnectorIcons />);

    const chip = screen.getByTestId('mounted-capability-mcp-lark');
    expect(chip.textContent).toContain('飞书');
    expect(chip.textContent).not.toContain('lark');

    fireEvent.mouseEnter(chip.parentElement!);
    const card = screen.getByTestId('mounted-capability-source-mcp-lark');
    expect(card.textContent).toContain('已装好，用到时自动连接');
    expect(screen.queryByRole('button', { name: /去能力中心连接/ })).toBeNull();
  });

  // ai-review 第九轮 Important：被能力中心关掉的 stdio 状态恒 lazy——手选这颗不看 enabled
  // 就会误写「已装好」还不给出口，与专家那颗的 hub_off 口径打架
  it('手选后被能力中心关掉：写「已在能力中心关闭」，给「去能力中心」出口，不冒充「已装好」', () => {
    composerState.selectedConnectorIds = [];
    composerState.selectedMcpServerIds = ['lark'];
    registryState.connectors = [makeConnector('tmeet', false)];
    registryState.mcpServers = [{ kind: 'mcp', key: 'mcp:lark', id: 'lark', label: 'lark', selected: true, status: 'lazy', enabled: false, available: false }];
    render(<MountedConnectorIcons />);

    fireEvent.mouseEnter(screen.getByTestId('mounted-capability-mcp-lark').parentElement!);
    const card = screen.getByTestId('mounted-capability-source-mcp-lark');
    expect(card.textContent).toContain('已在能力中心关闭，本轮不会用');
    expect(card.textContent).not.toContain('已装好');
    fireEvent.click(screen.getByRole('button', { name: /去能力中心/ }));
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({ kind: 'mcp', id: 'lark' });
  });

  // ai-review 第十轮 Important 1：CLI/SaaS 连接器的登录态不在连接器注册表（那条只列原生
  // mail/calendar…），不看 oauthStatus 会把连好的飞书恒判「未连接」——假 CTA + 假警示点，
  // 与宿主 isConnectorReadyForTurnScope 读的 cliConnectorStatusCache 直接打架
  it('手选的 CLI 连接器已连上（oauthStatus 说的）：写「已连接」，不给假「去连接」出口', () => {
    registryState.connectors = [makeConnector('tmeet', true, false)];
    oauthStatusesState.push({ id: 'tmeet', connected: true });
    render(<MountedConnectorIcons />);

    fireEvent.mouseEnter(screen.getByTestId('mounted-capability-connector-tmeet').parentElement!);
    const card = screen.getByTestId('mounted-capability-source-connector-tmeet');
    expect(card.textContent).toContain('已连接');
    expect(card.textContent).not.toContain('未连接');
    expect(screen.queryByRole('button', { name: /去能力中心/ })).toBeNull();
  });

  it('专家声明的 CLI 连接器已连上（oauthStatus 说的）：不挂警示点，卡上写「已连接」', () => {
    composerState.selectedConnectorIds = [];
    registryState.connectors = [];
    oauthStatusesState.push({ id: 'tmeet', connected: true });
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [{
      id: 'weekly',
      name: '周报专家',
      connectors: [{ id: 'tmeet', level: 'core' as const }],
    }];
    render(<MountedConnectorIcons />);

    expect(screen.queryByTestId('expert-connector-badge-issue')).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId('expert-connector-badge').parentElement!);
    const card = screen.getByTestId('expert-connector-source');
    expect(card.textContent).toContain('已连接');
    expect(screen.queryByRole('button', { name: /去能力中心/ })).toBeNull();
  });

  // 原生连接器的名字走注册表本地化名——和手选 chip 的 capability.label 同一份，
  // 专家卡不能退回裸 id（ai-review 第十二轮 Nit：两处显示「mail」vs「邮件」）
  it('专家声明的是原生连接器：卡上的名字与手选那颗同一份（注册表本地化名）', () => {
    composerState.selectedConnectorIds = [];
    registryState.connectors = [makeConnector('mail', false, false, '邮件')];
    appState.activeAgentId = 'weekly';
    agentRegistryState.entries = [{
      id: 'weekly',
      name: '周报专家',
      connectors: [{ id: 'mail', level: 'core' as const }],
    }];
    render(<MountedConnectorIcons />);

    fireEvent.mouseEnter(screen.getByTestId('expert-connector-badge').parentElement!);
    const card = screen.getByTestId('expert-connector-source');
    expect(card.textContent).toContain('邮件');
    expect(card.textContent).not.toContain('mail');
  });
});
