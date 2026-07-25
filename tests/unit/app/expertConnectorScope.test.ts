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

describe('ADR-052 C：专家连接器的运行时收窄', () => {
  beforeEach(() => {
    resolveAgentMock.mockReset();
    trackNodeMock.mockReset();
    registerConnector('lark', { connected: true });
    registerConnector('notion', { connected: true });
  });

  afterEach(() => {
    ['lark', 'notion'].forEach((id) => registry.unregister(id));
  });

  it('会话没选连接器时，收窄到专家声明的 core（optional 默认不开）', () => {
    resolveAgentMock.mockReturnValue(expertWithConnectors([
      { id: 'lark', level: 'core' },
      { id: 'notion', level: 'optional' },
    ]));

    expect(connectorScopeOf(undefined, { preferredAgentId: 'writer' })).toEqual(['lark']);
  });

  it('会话里显式选过连接器时以会话为准，专家默认不抢方向盘', () => {
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'lark', level: 'core' }]));

    expect(connectorScopeOf(undefined, {
      preferredAgentId: 'writer',
      selectedConnectorIds: ['notion'],
    })).toEqual(['notion']);
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

    expect(connectorScopeOf({ agentOverrideId: 'writer' }, undefined)).toEqual(['lark']);
    expect(resolveAgentMock).toHaveBeenCalledWith('writer');
  });

  it('专家声明的连接器没连上时不收窄，而不是把它锁成空集', () => {
    registry.unregister('lark');
    registerConnector('lark', { connected: false });
    resolveAgentMock.mockReturnValue(expertWithConnectors([{ id: 'lark', level: 'core' }]));

    expect(connectorScopeOf(undefined, { preferredAgentId: 'writer' })?.length ?? 0).toBe(0);
  });

  it('内置 agent（没有 connectors 声明）不受影响', () => {
    resolveAgentMock.mockReturnValue({ id: 'coder', name: 'coder' });

    expect(connectorScopeOf(undefined, { preferredAgentId: 'coder' })?.length ?? 0).toBe(0);
  });
});
