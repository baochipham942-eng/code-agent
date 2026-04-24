import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchCapabilitySheetLite } from '../../../src/renderer/components/workbench/WorkbenchCapabilitySheetLite';

describe('WorkbenchCapabilitySheetLite', () => {
  it('renders one shared capability detail sheet with current state, blocked reason, actions, and recent usage', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkbenchCapabilitySheetLite, {
        isOpen: true,
        capability: {
          kind: 'skill',
          key: 'skill:draft-skill',
          id: 'draft-skill',
          label: 'draft-skill',
          selected: true,
          mounted: false,
          installState: 'available',
          description: 'Draft release notes',
          source: 'community',
          libraryId: 'community',
          available: false,
          blocked: true,
          visibleInWorkbench: true,
          health: 'inactive',
          lifecycle: {
            installState: 'installed',
            mountState: 'unmounted',
            connectionState: 'not_applicable',
          },
          blockedReason: {
            code: 'skill_not_mounted',
            detail: 'Skill draft-skill 已安装但未挂载，本轮不会调用。',
            hint: '去 TaskPanel/Skills 把它挂到当前会话。',
            severity: 'warning',
          },
        },
        historyItem: {
          kind: 'skill',
          id: 'draft-skill',
          label: 'draft-skill',
          count: 2,
          lastUsed: 100,
          topActions: [{ label: 'draft', count: 2 }],
        },
        runningActionKey: null,
        actionError: null,
        completedAction: null,
        onQuickAction: vi.fn(async () => undefined),
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain('draft-skill');
    expect(html).toContain('概览');
    expect(html).toContain('当前状态');
    expect(html).toContain('阻塞原因');
    expect(html).toContain('快速动作');
    expect(html).toContain('最近使用');
    expect(html).toContain('挂载');
    expect(html).toContain('本会话调用 2 次');
    expect(html).toContain('最近动作: draft 2x');
  });

  it('shows authorization probe, openApp, and settings quick actions for an enabled unchecked connector', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkbenchCapabilitySheetLite, {
        isOpen: true,
        capability: {
          kind: 'connector',
          key: 'connector:calendar',
          id: 'calendar',
          label: 'Calendar',
          selected: false,
          connected: false,
          readiness: 'unchecked',
          detail: 'enabled, not checked',
          actions: ['repair_permissions', 'disconnect', 'remove'],
          capabilities: ['list_events'],
          available: false,
          blocked: false,
          visibleInWorkbench: false,
          health: 'inactive',
          lifecycle: {
            installState: 'not_applicable',
            mountState: 'not_applicable',
            connectionState: 'lazy',
          },
        },
        historyItem: null,
        runningActionKey: null,
        actionError: null,
        completedAction: null,
        onQuickAction: vi.fn(async () => undefined),
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain('Calendar');
    expect(html).toContain('阻塞原因');
    expect(html).toContain('Connector Calendar 已启用但还没检查本地授权，本轮不会调用。');
    expect(html).toContain('快速动作');
    expect(html).toContain('修复权限');
    expect(html).toContain('打开本地应用');
    expect(html).toContain('断开');
    expect(html).toContain('移除');
    expect(html).toContain('打开连接器设置');
  });
});
