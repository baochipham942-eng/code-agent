// ============================================================================
// PermissionCard 参数预览块（N-PARKED-APPROVAL-SURVIVE-RESTART-PERSIST ④）
// 判据：request.argsPreview 在时渲染预览块（zh/en 两种词条都验证），不在时不渲染。
// 预览文本由 host parkApproval 脱敏 + 截断，renderer 只负责呈现，不再二次加工。
// ============================================================================

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

// PermissionCard 是 store 连接型组件（无 props），mock 三个 store + ipcService
// 后用 renderToStaticMarkup 渲染（与 permissionCard.reason.test.tsx 同一模式）。
const storeState = vi.hoisted(() => ({
  request: null as ContractPermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: storeState.language === 'en' ? en : zh,
      language: storeState.language,
    }),
  };
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
    id: 'req-preview-1',
    tool: 'Bash',
    type: 'command',
    details: { command: 'npm run gates:fast' },
    timestamp: 1,
    ...overrides,
  };
}

function render(): string {
  return renderToStaticMarkup(React.createElement(PermissionCard));
}

describe('PermissionCard argsPreview 呈现', () => {
  it('request.argsPreview 在时渲染预览块与脱敏文本（zh）', () => {
    storeState.language = 'zh';
    storeState.request = baseRequest({
      argsPreview: 'curl https://api.example.com/v1 · Bearer ***REDACTED***',
    });
    const html = render();
    expect(html).toContain('data-testid="permission-args-preview"');
    expect(html).toContain('参数预览');
    expect(html).toContain('Bearer ***REDACTED***');
  });

  it('request.argsPreview 在时渲染预览块（en 词条）', () => {
    storeState.language = 'en';
    storeState.request = baseRequest({
      argsPreview: 'curl https://api.example.com/v1 · Bearer ***REDACTED***',
    });
    const html = render();
    expect(html).toContain('data-testid="permission-args-preview"');
    expect(html).toContain('Arguments preview');
    expect(html).toContain('Bearer ***REDACTED***');
  });

  it('request.argsPreview 缺省（交互路径 / 旧事件）不渲染预览块', () => {
    storeState.language = 'zh';
    storeState.request = baseRequest({});
    const html = render();
    expect(html).not.toContain('permission-args-preview');
    expect(html).not.toContain('参数预览');
  });
});
