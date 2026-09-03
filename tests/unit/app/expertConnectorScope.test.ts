// ============================================================================
// ADR-052 C：专家声明的连接器在运行时真收窄
// ============================================================================
//
// #671 让专家能在 agent.md 声明推荐连接器，但那套解析此前**只有 renderer 的专家详情页
// 在用（画界面上的勾）**，宿主一次都没调用——声明是装饰性的，跑起来照样能碰全部连接器。
//
// 本门钉住 ADR-052 选定的方案 C：
//   · 身份取自本轮（context.preferredAgentId，cron 走 options.agentOverrideId），不建会话级绑定；
//   · 会话里显式选过连接器时以会话为准，专家默认不抢方向盘；
//   · **没身份就退回不收窄（宽 fallback）**，并打点记漏传——拍板时明确要先宽后收。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatus } from '../../../src/host/connectors';
import { getConnectorRegistry } from '../../../src/host/connectors';

const resolveAgentMock = vi.hoisted(() => vi.fn());
const trackNodeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/agent/agentRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/agent/agentRegistry')>();
  return { ...actual, resolveAgent: resolveAgentMock };
});

vi.mock('../../../src/host/observability/posthogNode', () => ({
  trackNode: trackNodeMock,
}));

// CLI 连接器（feishu/tmeet）的「连上了没」走自己的状态缓存，不进 connector registry，
// 所以要测「声明了但没连上」这一支必须从这里给状态。
const cliConnectorStatus = vi.hoisted(() => ({} as Record<string, { connected: boolean } | undefined>));
// 专家声明的 MCP 也要过「连上了没」——没连上的进了 scope 会把其他 MCP 工具全挡掉
const connectedMcpServers = vi.hoisted(() => new Set<string>());
vi.mock('../../../src/host/mcp/mcpConnectionProbe', () => ({
  isMcpServerConnected: (name: string) => connectedMcpServers.has(name),
}));
vi.mock('../../../src/host/connectors/cli/cliConnectorStatusCache', () => ({
  isCliConnectorId: (id: string) => id === 'feishu' || id === 'tmeet',
  getCachedCliConnectorConnectionStatus: (id: string) => cliConnectorStatus[id],
}));

import { withWorkbenchTurnSystemContext } from '../../../src/host/app/workbenchTurnContext';

const registry = getConnectorRegistry();

function registerConnector(id: string, status: Partial<ConnectorStatus>): void {
  registry.register({
    id,
    label: id,
    capabilities: ['get_status'],
    getCachedStatus: () => ({ connected: false, capabilities: ['get_status'], ...status }),
    async getStatus() { return this.getCachedStatus!(); },
    async execute() { return { data: null }; },
  });
}

function expertWithConnectors(connectors: Array<{ id: string; level: 'core' | 'optional' }>) {
  return { id: 'writer', name: 'writer', connectors };
}

function connectorScopeOf(
  options: Parameters<typeof withWorkbenchTurnSystemContext>[0],
  context: Parameters<typeof withWorkbenchTurnSystemContext>[1],
): string[] | undefined {
  return withWorkbenchTurnSystemContext(options, context)?.toolScope?.allowedConnectorIds;
}

function mcpScopeOf(
  options: Parameters<typeof withWorkbenchTurnSystemContext>[0],
  context: Parameters<typeof withWorkbenchTurnSystemContext>[1],
): string[] | undefined {
  return withWorkbenchTurnSystemContext(options, context)?.toolScope?.allowedMcpServerIds;
}

describe('ADR-052 C：专家连接器的运行时收窄', () => {
  beforeEach(() => {
    resolveAgentMock.mockReset();
    trackNodeMock.mockReset();
    // 🔴 lark / notion 是**连接器目录里的 MCP 名**，真实运行时 connector registry 里根本没有
    // 它们（那张表只装 CLI 与原生连接器）。原来这里手工把 lark 注册进去，等于伪造了
    // 「MCP 能通过 connector ready 判定」——ADR-052 C 那道门假绿的来源就在这。
    // 现在只注册真正属于连接器侧的 crm（原生连接器），MCP 名一律不注册。
    registerConnector('crm', { connected: true });
    for (const key of Object.keys(cliConnectorStatus)) delete cliConnectorStatus[key];
    connectedMcpServers.clear();
    connectedMcpServers.add('lark');
  });

  afterEach(() => {
    registry.unregister('crm');
  });

  // 2026-09-03 断言落点修正（N-CONNECTOR-INCHAT / ai-review 抓获）：lark 这类是**连接器目录
  // 里的 MCP 名**，以前整批塞进 allowedConnectorIds——而连接器那侧的过滤
  // （matchesScopedConnectorTool）对非连接器工具名一律放行，MCP 工具压根不受它约束，
  // 所以「收窄」从未真正发生，这条门一直是假绿。断言的意图不变（专家 core 要真收窄），
  // 落点改到真正起作用的字段上。
  it('会话没选连接器时，收窄到专家声明的 core（optional 默认不开）——MCP 名落 mcp scope', () => {
    resolveAgentMock.mockReturnValue(expertWithConnectors([
      { id: 'lark', level: 'core' },
      { id: 'notion', level: 'optional' },
    ]));

    expect(mcpScopeOf(undefined, { preferredAgentId: 'writer' })).toEqual(['lark']);
    expect(connectorScopeOf(undefined, { preferredAgentId: 'writer' })?.length ?? 0).toBe(0);
  });

  // 收窄进名单的 server 可能是 lazy（工具定义还没注册、list_tools 也列不出），
  // 必须在 system context 里点名——否则模型既丢了其他 MCP 工具也不知道目标存在
  it('MCP 收窄生效时 system context 点名范围内的 server', () => {
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'lark', level: 'core' }]));

    const merged = withWorkbenchTurnSystemContext(undefined, { preferredAgentId: 'writer' });
    const line = merged?.turnSystemContext?.find((entry) => entry.includes('本轮 MCP 工具面收窄到'));
    expect(line).toContain('lark');
  });

  it('连接器侧（CLI 的 feishu + 注册表里的 crm）与 MCP 名各归各位', () => {
    cliConnectorStatus.feishu = { connected: true };
    resolveAgentMock.mockReturnValue(expertWithConnectors([
      { id: 'feishu', level: 'core' },
      { id: 'crm', level: 'core' },
      { id: 'lark', level: 'core' },
    ]));

    expect(connectorScopeOf(undefined, { preferredAgentId: 'writer' })).toEqual(['feishu', 'crm']);
    expect(mcpScopeOf(undefined, { preferredAgentId: 'writer' })).toEqual(['lark']);
  });

  it('原生连接器没连上时不收窄（与 CLI 那支同口径）', () => {
    registry.unregister('crm');
    registerConnector('crm', { connected: false });
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'crm', level: 'core' }]));

    expect(connectorScopeOf(undefined, { preferredAgentId: 'writer' })?.length ?? 0).toBe(0);
  });

  it('会话显式选过 MCP 时以会话为准，专家声明的 MCP 不抢方向盘', () => {
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'lark', level: 'core' }]));

    expect(mcpScopeOf(undefined, {
      preferredAgentId: 'writer',
      selectedMcpServerIds: ['notion'],
    })).toEqual(['notion']);
  });

  it('会话里显式选过连接器时以会话为准，专家那支两侧一起让位', () => {
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'lark', level: 'core' }]));
    const context = { preferredAgentId: 'writer', selectedConnectorIds: ['crm'] };

    expect(connectorScopeOf(undefined, context)).toEqual(['crm']);
    // 只让连接器侧让位、MCP 侧还偷偷用着专家声明，就和界面上那句
    // 「这轮以你选的连接器为准」打架了
    expect(mcpScopeOf(undefined, context)?.length ?? 0).toBe(0);
  });

  // 只手选 MCP 这条路必须单独覆盖：判据若只看连接器侧，这里会漏——专家的连接器那支
  // 会继续偷偷收窄，而用户以为「我选的说了算」。
  it('会话只手选了 MCP 时，专家的连接器那支也一起让位', () => {
    cliConnectorStatus.feishu = { connected: true };
    resolveAgentMock.mockReturnValue(expertWithConnectors([
      { id: 'feishu', level: 'core' },
      { id: 'lark', level: 'core' },
    ]));
    const context = { preferredAgentId: 'writer', selectedMcpServerIds: ['notion'] };

    expect(mcpScopeOf(undefined, context)).toEqual(['notion']);
    expect(connectorScopeOf(undefined, context)?.length ?? 0).toBe(0);
  });

  // 上游（子代理 / cron / 调用方）传进来的 toolScope 不是「用户手选」。把它当手选，
  // 会出现「上游带了 MCP 范围 ⇒ 专家声明的连接器那支被清空、那类工具重新全开放」。
  it('上游 options.toolScope 带了 MCP 范围，不算用户手选，专家的连接器那支照常收窄', () => {
    cliConnectorStatus.feishu = { connected: true };
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'feishu', level: 'core' }]));

    expect(connectorScopeOf(
      { toolScope: { allowedMcpServerIds: ['upstream-mcp'] } },
      { preferredAgentId: 'writer' },
    )).toEqual(['feishu']);
  });

  // 用户手选是他自己的显式决定；专家声明是背后自动生效的，写错一个名字就把所有
  // MCP 工具挡掉，代价不该落到用户头上。
  it('专家声明的 MCP 没连上时不进 scope；全都没连上就不收窄', () => {
    connectedMcpServers.clear();
    resolveAgentMock.mockReturnValue(expertWithConnectors([
      { id: 'lark', level: 'core' },
      { id: 'typo-mcp', level: 'core' },
    ]));

    expect(mcpScopeOf(undefined, { preferredAgentId: 'writer' })?.length ?? 0).toBe(0);

    // 正向对照：连上一个就收窄到它，证明上面那个 0 不是「这条路本来就走不通」
    connectedMcpServers.add('lark');
    expect(mcpScopeOf(undefined, { preferredAgentId: 'writer' })).toEqual(['lark']);
  });

  // 判据若取 workbenchToolScope（已过 ready 过滤），手选了个没连上的连接器会被过滤成空、
  // 误判成「他没选过」，专家那支就又活了——用户明明选了东西，工具面却被专家收窄。
  it('手选的连接器没连上时，专家那支仍然让位（会话显式选择优先）', () => {
    cliConnectorStatus.feishu = { connected: false };
    connectedMcpServers.add('lark');
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'lark', level: 'core' }]));
    const context = { preferredAgentId: 'writer', selectedConnectorIds: ['feishu'] };

    expect(connectorScopeOf(undefined, context)?.length ?? 0).toBe(0);
    expect(mcpScopeOf(undefined, context)?.length ?? 0).toBe(0);

    // 正向对照：没手选过时专家那支照常收窄，证明上面两个 0 不是「这条路本来就走不通」
    expect(mcpScopeOf(undefined, { preferredAgentId: 'writer' })).toEqual(['lark']);
  });

  // 拍板口径：先宽后收。没身份不是"一个都不给"，而是维持现状不收窄。
  it('本轮没有身份时退回不收窄，并打点记漏传', () => {
    expect(connectorScopeOf(undefined, { selectedSkillIds: ['x'] })?.length ?? 0).toBe(0);

    const identityEvents = trackNodeMock.mock.calls
      .filter(([event]) => event === 'expert_scope_identity');
    expect(identityEvents).toHaveLength(1);
    expect(identityEvents[0]?.[1]).toMatchObject({ present: false });
  });

  // cron / 子代理不经过 renderer，身份走 options.agentOverrideId——这条不覆盖，
  // 收窄就只在"有人盯着的手动聊天"里生效，恰好漏掉最该收的无人值守路径。
  it('cron 路径的身份走 options.agentOverrideId，同样收窄', () => {
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'lark', level: 'core' }]));

    expect(mcpScopeOf({ agentOverrideId: 'writer' }, undefined)).toEqual(['lark']);
    expect(resolveAgentMock).toHaveBeenCalledWith('writer');
  });

  it('专家声明的 CLI 连接器没连上时不收窄，而不是把它锁成空集', () => {
    cliConnectorStatus.feishu = { connected: false };
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'feishu', level: 'core' }]));

    expect(connectorScopeOf(undefined, { preferredAgentId: 'writer' })?.length ?? 0).toBe(0);

    // 正向对照：连上了就收窄，证明上面那个 0 不是「这条路本来就走不通」
    cliConnectorStatus.feishu = { connected: true };
    expect(connectorScopeOf(undefined, { preferredAgentId: 'writer' })).toEqual(['feishu']);
  });

  it('内置 agent（没有 connectors 声明）不受影响', () => {
    resolveAgentMock.mockReturnValue({ id: 'coder', name: 'coder' });

    expect(connectorScopeOf(undefined, { preferredAgentId: 'coder' })?.length ?? 0).toBe(0);
  });
});
