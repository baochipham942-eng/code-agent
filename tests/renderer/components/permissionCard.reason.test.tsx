import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

// PermissionCard 是 store 连接型组件（无 props），mock 三个 store + ipcService
// 后用 renderToStaticMarkup 渲染，验证 reason 渲染路径（含本次新增的 reasonCode fallback）。
const storeState = vi.hoisted(() => ({ request: null as ContractPermissionRequest | null }));

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

describe('PermissionCard reason 渲染', () => {
  it('有 reason 文案时逐字渲染（向后兼容，旧路径不变）', () => {
    storeState.request = baseRequest({ reason: '调用 MCP 服务器 github', reasonCode: PermissionRequestReason.McpTool });
    const html = render();
    expect(html).toContain('调用 MCP 服务器 github');
  });

  it('reason 为空但有 reasonCode 时回退到枚举文案（本次新增的可见行为）', () => {
    storeState.request = baseRequest({ reason: undefined, reasonCode: PermissionRequestReason.FileWriteOutsideWorkspace });
    const html = render();
    expect(html).toContain('写入工作区外的文件');
  });

  it('reason 与 reasonCode 都缺失（旧序列化 request）不崩溃、不渲染原因段', () => {
    storeState.request = baseRequest({ reason: undefined, reasonCode: undefined });
    const html = render();
    expect(html).not.toContain('写入工作区外的文件');
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });
});
