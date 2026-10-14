import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

// N-APPROVAL-EXTERNAL-SCOPENOTE：external（离开本机）工具的交互审批卡出作用域提示
// （收不回警示 + 有 target 时点一行去向，与停车审批收件箱同 i18n 组）；
// 非 external 卡一字节不变；mail_send 主卡不与 w.irreversible 重复出收不回提示
// （那条只在编辑态作为问句出现，编辑态不渲染 RequestDetails）。
// PermissionCard 是 store 连接型组件（permissionCard.peerOrigin.test.tsx 同款 mock）。

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

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('PermissionCard external 作用域提示（离开本机）', () => {
  afterEach(() => {
    storeState.language = 'zh';
  });

  it('external 卡出「离开本机：发出去收不回」并用同一 i18n 组点一行去向', () => {
    const html = render({
      id: 'permission-feishu-send',
      tool: 'mcp__feishu__im_v1_message_create',
      type: 'mcp',
      riskClass: 'external',
      details: { standingGrantTarget: 'chat_id:oc_C1', server: 'feishu', toolName: 'im_v1_message_create' },
      timestamp: 1,
    });
    expect(html).toContain('离开本机：发出去收不回');
    expect(html).toContain('离开本机 → chat_id:oc_C1');
  });

  it('external 但提取不到 target 时只出收不回警示，不出去向行', () => {
    const html = render({
      id: 'permission-slack-send',
      tool: 'mcp__slack__chat_postMessage',
      type: 'mcp',
      riskClass: 'external',
      details: { server: 'slack', toolName: 'chat_postMessage' },
      timestamp: 1,
    });
    expect(html).toContain('离开本机：发出去收不回');
    expect(html).not.toContain('离开本机 →');
  });

  it('im_chat_list（IM 只读）卡不出作用域提示', () => {
    const html = render({
      id: 'permission-feishu-read',
      tool: 'mcp__feishu__im_chat_list',
      type: 'mcp',
      details: { server: 'feishu', toolName: 'im_chat_list' },
      timestamp: 1,
    });
    expect(html).not.toContain('离开本机');
    expect(html).not.toContain('permission-external-scope');
  });

  it('web_fetch（联网读）卡不出作用域提示', () => {
    const html = render({
      id: 'permission-web-fetch',
      tool: 'web_fetch',
      type: 'network',
      details: { url: 'https://example.com' },
      timestamp: 1,
    });
    expect(html).not.toContain('离开本机');
    expect(html).not.toContain('发出去收不回');
  });

  it('mail_send 主卡的收不回提示恰好一条（不与 w.irreversible 编辑态文案重复）', () => {
    const html = render({
      id: 'permission-mail-send',
      tool: 'mail_send',
      type: 'file_write',
      riskClass: 'external',
      details: {
        subject: 'Q3 对账单',
        to: ['li.wei@acme.com'],
        content: '请确认。',
        standingGrantTarget: 'li.wei@acme.com',
      } as ContractPermissionRequest['details'],
      timestamp: 1,
    });
    expect(countOccurrences(html, '发出去收不回')).toBe(1);
    // w.irreversible（发出后无法撤回…）只在编辑态作为问句渲染；主卡不得出现第二条收不回提示
    expect(html).not.toContain('无法撤回');
    expect(html).toContain('离开本机 → li.wei@acme.com');
  });

  it('英文卡出同一条作用域提示与去向', () => {
    const html = renderInLanguage({
      id: 'permission-feishu-send-en',
      tool: 'mcp__feishu__im_v1_message_create',
      type: 'mcp',
      riskClass: 'external',
      details: { standingGrantTarget: 'chat_id:oc_C1', server: 'feishu', toolName: 'im_v1_message_create' },
      timestamp: 1,
    }, 'en');
    expect(html).toContain('Leaves this device: cannot be recalled once sent');
    expect(html).toContain('Leaves this device → chat_id:oc_C1');
  });
});
