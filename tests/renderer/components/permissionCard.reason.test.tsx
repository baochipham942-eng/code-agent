import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

// PermissionCard 是 store 连接型组件（无 props），mock 三个 store + ipcService
// 后用 renderToStaticMarkup 渲染，验证普通卡面不再泄出 decision trace / reason。
const storeState = vi.hoisted(() => ({ request: null as ContractPermissionRequest | null }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
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

function baseRequest(overrides: Partial<ContractPermissionRequest>): ContractPermissionRequest {
  return {
    id: 'req-1',
    tool: 'Write',
    type: 'file_write',
    details: { path: '/Users/x/Desktop/out.txt' },
    timestamp: 1,
    ...overrides,
  };
}

function render(): string {
  return renderToStaticMarkup(React.createElement(PermissionCard));
}

describe('PermissionCard reason 开发者门控', () => {
  it('普通卡面不渲染 host reason 原文', () => {
    storeState.request = baseRequest({ reason: '调用 MCP 服务器 github', reasonCode: PermissionRequestReason.McpTool });
    const html = render();
    expect(html).not.toContain('调用 MCP 服务器 github');
  });

  it('普通卡面不渲染 reasonCode 枚举文案', () => {
    storeState.request = baseRequest({ reason: undefined, reasonCode: PermissionRequestReason.FileWriteOutsideWorkspace });
    const html = render();
    expect(html).not.toContain('写入工作区外的文件');
  });

  it('reason 与 reasonCode 都缺失（旧序列化 request）不崩溃、不渲染原因段', () => {
    storeState.request = baseRequest({ reason: undefined, reasonCode: undefined });
    const html = render();
    expect(html).not.toContain('写入工作区外的文件');
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });
});
