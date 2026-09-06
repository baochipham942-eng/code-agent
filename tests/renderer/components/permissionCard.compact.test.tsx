// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    developerMode: false,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const internalWrite: PermissionRequest = {
  id: 'permission-internal-write',
  sessionId: 'request-session',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/workspace/reports/report.md' },
  boundary: { id: 'file.project_write' },
  timestamp: 1,
};

const externalWrite: PermissionRequest = {
  ...internalWrite,
  id: 'permission-external-write',
  details: { path: '/Users/me/Documents/report.md' },
  boundary: { id: 'file.external_write' },
};

const dangerousCommand: PermissionRequest = {
  id: 'permission-danger-command',
  sessionId: 'request-session',
  tool: 'Bash',
  type: 'dangerous_command',
  dangerLevel: 'danger',
  details: {
    command: 'rm -rf ./dist',
    commandRiskLevel: 'high',
    commandSecurityFlags: ['recursive_delete_targeted'],
    affectedPath: '/workspace/dist',
    affectedFileCount: 312,
  },
  boundary: { id: 'command.shell' },
  timestamp: 1,
};

const mcpRequest: PermissionRequest = {
  id: 'permission-mcp',
  sessionId: 'request-session',
  tool: 'MCPUnified',
  type: 'network',
  details: { server: 'lark-prod', toolName: 'docs.search' },
  boundary: { id: 'mcp.server_tool' },
  timestamp: 1,
};

const deviceNullEdit: PermissionRequest = {
  ...internalWrite,
  id: 'permission-dev-null',
  tool: 'Edit',
  type: 'file_edit',
  details: { path: '/dev/null' },
  boundary: { id: 'file.external_write' },
};

function renderRequest(request: PermissionRequest) {
  return render(
    <PermissionCard
      requestOverride={request}
      sessionIdOverride="session-current"
    />,
  );
}

describe('PermissionCard 紧凑/展开判据', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    for (const request of [internalWrite, externalWrite, dangerousCommand, mcpRequest, deviceNullEdit]) releaseApprovalResponse(request.id);
  });

  it('工作区内 Write 默认紧凑，摘要含 basename，DOM 不泄工具原名与审批说明块', () => {
    renderRequest(internalWrite);

    const card = screen.getByTestId('permission-card').firstElementChild as HTMLElement;
    expect(card.dataset.viewMode).toBe('compact');
    expect(screen.getByText('允许写入 report.md？')).toBeTruthy();
    expect(document.body.textContent).not.toContain('/workspace/reports/report.md');
    expect(document.body.textContent).not.toContain('Write');
    expect(document.body.textContent).not.toContain('为什么需要审批');
    expect(document.body.textContent).not.toContain('审批决策链');
    expect(document.body.textContent).not.toContain('会访问');
    expect(screen.getByRole('button', { name: /允许一次/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /本会话允许/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /始终允许/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /拒绝/ })).toBeTruthy();
  });

  it('MCP server / tool 只在默认展开的详情区出现，卡头不露协议工具原名', () => {
    renderRequest(mcpRequest);

    const card = screen.getByTestId('permission-card').firstElementChild as HTMLElement;
    expect(card.dataset.viewMode).toBe('expanded');
    expect(screen.getByText('允许调用这个 MCP 工具？')).toBeTruthy();
    expect(screen.getByText('lark-prod / docs.search')).toBeTruthy();
    const header = card.firstElementChild as HTMLElement;
    expect(header.textContent).not.toContain('MCPUnified');
    expect(header.textContent).not.toContain('lark-prod');
    expect(header.textContent).not.toContain('docs.search');
    fireEvent.click(screen.getByRole('button', { name: '收起▴' }));
    expect(document.body.textContent).not.toContain('lark-prod');
    expect(document.body.textContent).not.toContain('docs.search');
  });

  it('工作区外 Write 默认展开，拒绝是主按钮且 Enter 执行安全侧', async () => {
    renderRequest(externalWrite);

    const card = screen.getByTestId('permission-card').firstElementChild as HTMLElement;
    expect(card.dataset.viewMode).toBe('expanded');
    expect(screen.getByText('允许写入 report.md（工作区外）？')).toBeTruthy();
    expect(screen.getByTestId('permission-consequence').textContent).toContain('工作区外');
    expect(screen.getByTestId('permission-consequence').textContent).toContain('/Users/me/Documents/report.md');
    expect(document.body.textContent).not.toContain('Write');
    expect(document.body.textContent).not.toContain('会访问');

    const reject = screen.getByRole('button', { name: /拒绝/ });
    const allow = screen.getByRole('button', { name: /允许一次/ });
    expect(reject.className).toContain('from-primary-800');
    expect(reject.className).toContain('ml-auto');
    expect(allow.className).toContain('border-red-500/50');
    expect(document.activeElement).toBe(reject);

    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'agent:permission-response',
        externalWrite.id,
        'deny',
        externalWrite.sessionId,
      );
    });
  });

  it('/dev/null 标题用完整路径，后果不含覆盖措辞', () => {
    renderRequest(deviceNullEdit);

    expect(screen.getByText('允许编辑 /dev/null（工作区外）？')).toBeTruthy();
    expect(screen.queryByText('允许编辑 null（工作区外）？')).toBeNull();
    expect(screen.getByTestId('permission-consequence').textContent)
      .toBe('将向工作区外的设备文件 /dev/null 写入。');
    expect(screen.getByTestId('permission-consequence').textContent).not.toContain('可能覆盖现有内容');
  });

  it('danger 默认展开：规则后果含路径和文件数，Enter 无效，拒绝是右侧蓝色主按钮', () => {
    renderRequest(dangerousCommand);

    const card = screen.getByTestId('permission-card').firstElementChild as HTMLElement;
    expect(card.dataset.viewMode).toBe('expanded');
    expect(screen.getByTestId('permission-consequence').textContent)
      .toBe('将永久删除 /workspace/dist（约 312 个文件），不进回收站。');
    expect(screen.getByText('rm -rf ./dist')).toBeTruthy();
    expect(screen.getAllByText('危险')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Bash');

    const reject = screen.getByRole('button', { name: /拒绝/ });
    const execute = screen.getByRole('button', { name: /仍然执行/ });
    expect(reject.className).toContain('from-primary-800');
    expect(reject.className).toContain('ml-auto');
    expect(execute.className).toContain('border-red-500/50');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
