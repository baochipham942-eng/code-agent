import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

// ADR-067 刀 2：peer 消息触发的审批卡必须标明「此动作由 agent X 的消息触发」。
// PermissionCard 是 store 连接型组件（permissionCard.reason.test.tsx 同款 mock）。

const storeState = vi.hoisted(() => ({
  request: null as ContractPermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh }, { en }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return { useI18n: () => ({ t: storeState.language === 'en' ? en : zh, language: storeState.language }) };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: storeState.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { currentSessionId: string | null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

const { PermissionCard } = await import('../../../src/renderer/components/PermissionDialog/PermissionCard');

function render(request: ContractPermissionRequest): string {
  storeState.request = request;
  return renderToStaticMarkup(React.createElement(PermissionCard));
}

function renderInLanguage(request: ContractPermissionRequest, language: 'zh' | 'en'): string {
  storeState.language = language;
  return render(request);
}

function baseRequest(overrides: Partial<ContractPermissionRequest>): ContractPermissionRequest {
  return {
    id: 'req-peer-1',
    tool: 'Bash',
    type: 'command',
    forceConfirm: true,
    details: { command: 'rm -rf /tmp/x' },
    timestamp: 1,
    ...overrides,
  };
}

describe('PermissionCard peer 起源标注（ADR-067 D3）', () => {
  afterEach(() => {
    storeState.language = 'zh';
  });

  it('details.triggeredByAgentMessage 存在时卡面标明触发来源 agent', () => {
    const html = render(baseRequest({
      details: { command: 'rm -rf /tmp/x', triggeredByAgentMessage: { senderAgentId: 'agent-b' } },
    }));
    expect(html).toContain('此动作由 agent agent-b 的消息触发');
  });

  it('senderAgentId 缺省时仍出标注（不崩、不漏标）', () => {
    const html = render(baseRequest({
      details: { command: 'rm -rf /tmp/x', triggeredByAgentMessage: {} },
    }));
    expect(html).toContain('此动作由 agent ? 的消息触发');
  });

  it('无 peer 标记时不渲染标注', () => {
    const html = render(baseRequest({}));
    expect(html).not.toContain('的消息触发');
  });

  it('plugin origin renders in both languages and main-agent ids do not render a subagent line', () => {
    for (const agentId of ['default', 'role-writer'] as const) {
      const attributed = baseRequest({
        agentId,
        details: {
          command: 'rm -rf /tmp/x',
          pluginId: 'example.plugin',
          pluginName: 'Example Plugin',
        },
      });
      const zh = renderInLanguage(attributed, 'zh');
      const en = renderInLanguage(attributed, 'en');
      expect(zh, agentId).toContain('来自插件《Example Plugin》');
      expect(zh, agentId).not.toContain('example.plugin');
      expect(zh, agentId).not.toContain('来自子 agent');
      expect(en, agentId).toContain('From plugin Example Plugin');
      expect(en, agentId).not.toContain('example.plugin');
      expect(en, agentId).not.toContain('From subagent');
      expect(en, agentId).not.toContain(agentId);
    }

    const withoutAttribution = renderInLanguage(baseRequest({ agentId: 'default' }), 'en');
    expect(withoutAttribution).not.toContain('From plugin');
    expect(withoutAttribution).not.toContain('From subagent');
    expect(withoutAttribution).not.toContain('default');
  });

  it('falls back to the plugin id on older requests without a display name', () => {
    const request = baseRequest({ details: { pluginId: 'example.plugin' } });
    expect(renderInLanguage(request, 'zh')).toContain('来自插件《example.plugin》');
    expect(renderInLanguage(request, 'en')).toContain('From plugin example.plugin');
  });
});
