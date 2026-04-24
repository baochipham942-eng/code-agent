import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectorStatusSummary,
  NativeConnectorInventoryItem,
} from '../../../src/shared/ipc';
import {
  NativeConnectorItems,
  RuntimeConnectorItems,
  buildNativeConnectorRows,
  buildRuntimeConnectorRows,
  getNativeConnectorLifecycleActions,
  getNativeConnectorLifecycleRequest,
  getNativeConnectorReadiness,
  getRuntimeConnectorLifecycleActions,
  getRuntimeConnectorLifecycleRequest,
  getRuntimeConnectorReadiness,
} from '../../../src/renderer/components/features/settings/sections/NativeConnectorsSection';

const inventory: NativeConnectorInventoryItem[] = [
  { id: 'calendar', label: 'Calendar', enabled: true },
  { id: 'mail', label: 'Mail', enabled: false },
];

const statuses: ConnectorStatusSummary[] = [
  {
    id: 'calendar',
    label: 'Calendar',
    connected: false,
    readiness: 'failed',
    detail: 'Calendar 授权/可用性检查失败',
    error: 'Automation denied',
    actions: ['repair_permissions', 'disconnect', 'remove'],
    capabilities: ['list_events'],
    checkedAt: 1_713_456_000_000,
  },
  {
    id: 'browser-workbench',
    label: 'Browser Workbench',
    connected: true,
    readiness: 'ready',
    detail: 'Browser session available',
    actions: ['disconnect'],
    capabilities: ['open_page', 'screenshot'],
    checkedAt: 1_713_456_100_000,
  },
  {
    id: 'recipe-runner',
    label: 'Recipe Runner',
    connected: false,
    readiness: 'failed',
    error: 'Recipe runtime unavailable',
    capabilities: ['run_recipe'],
  },
];

describe('NativeConnectorsSection helpers', () => {
  it('joins native inventory with connector statuses and keeps disabled items visible', () => {
    const rows = buildNativeConnectorRows(inventory, statuses);

    expect(rows[0]).toMatchObject({
      id: 'calendar',
      enabled: true,
      status: {
        readiness: 'failed',
        error: 'Automation denied',
      },
    });
    expect(rows[1]).toMatchObject({
      id: 'mail',
      enabled: false,
      status: undefined,
    });
  });

  it('extracts runtime connector statuses that are not part of the native inventory', () => {
    const rows = buildRuntimeConnectorRows(inventory, statuses);

    expect(rows.map((row) => row.id)).toEqual(['browser-workbench', 'recipe-runner']);
    expect(rows[0]).toMatchObject({
      label: 'Browser Workbench',
      readiness: 'ready',
      capabilities: ['open_page', 'screenshot'],
    });
  });

  it('maps readiness and lifecycle actions for enabled native connectors', () => {
    const [calendar, mail] = buildNativeConnectorRows(inventory, statuses);

    expect(getNativeConnectorReadiness(calendar).label).toBe('检查失败');
    expect(getNativeConnectorLifecycleActions(calendar)).toEqual([
      'probe',
      'repair_permissions',
      'disconnect',
      'remove',
    ]);
    expect(getNativeConnectorReadiness(mail).label).toBe('已停用');
    expect(getNativeConnectorLifecycleActions(mail)).toEqual([]);
  });

  it('maps readiness and safe lifecycle actions for runtime connectors', () => {
    const [browser, recipe] = buildRuntimeConnectorRows(inventory, statuses);

    expect(getRuntimeConnectorReadiness(browser).label).toBe('可用');
    expect(getRuntimeConnectorLifecycleActions(browser)).toEqual(['retry', 'probe']);
    expect(getRuntimeConnectorReadiness(recipe).label).toBe('检查失败');
    expect(getRuntimeConnectorLifecycleActions(recipe)).toEqual(['retry', 'probe']);
  });

  it('does not expose native-only lifecycle actions for runtime connectors', () => {
    const rows = buildRuntimeConnectorRows(inventory, statuses);
    const actions = rows.flatMap((row) => getRuntimeConnectorLifecycleActions(row));

    expect(actions).toEqual(['retry', 'probe', 'retry', 'probe']);
    expect(actions).not.toContain('disconnect');
    expect(actions).not.toContain('remove');
  });

  it('only enables runtime safe actions when the status is actionable', () => {
    const idle: ConnectorStatusSummary = {
      id: 'idle',
      label: 'Idle Runtime',
      connected: false,
      readiness: 'ready',
      actions: [],
      capabilities: [],
    };

    expect(getRuntimeConnectorLifecycleActions(idle)).toEqual([]);
    expect(getRuntimeConnectorLifecycleActions({ ...idle, readiness: 'unchecked' })).toEqual(['retry', 'probe']);
  });

  it('maps UI lifecycle actions to existing connector IPC actions', () => {
    expect(getNativeConnectorLifecycleRequest('calendar', 'probe')).toEqual({
      ipcAction: 'probe',
      payload: { connectorId: 'calendar' },
    });
    expect(getNativeConnectorLifecycleRequest('calendar', 'repair_permissions')).toEqual({
      ipcAction: 'repairPermission',
      payload: { connectorId: 'calendar' },
    });
    expect(getNativeConnectorLifecycleRequest('calendar', 'disconnect')).toEqual({
      ipcAction: 'disconnect',
      payload: { connectorId: 'calendar' },
    });
    expect(getNativeConnectorLifecycleRequest('calendar', 'remove')).toEqual({
      ipcAction: 'remove',
      payload: { connectorId: 'calendar' },
    });
  });

  it('maps runtime lifecycle actions to retry/probe connector IPC actions', () => {
    expect(getRuntimeConnectorLifecycleRequest('browser-workbench', 'retry')).toEqual({
      ipcAction: 'retry',
      payload: { connectorId: 'browser-workbench' },
    });
    expect(getRuntimeConnectorLifecycleRequest('browser-workbench', 'probe')).toEqual({
      ipcAction: 'probe',
      payload: { connectorId: 'browser-workbench' },
    });
  });

  it('keeps disconnect/remove available when an enabled status has no native actions', () => {
    const [row] = buildNativeConnectorRows(
      [{ id: 'calendar', label: 'Calendar', enabled: true }],
      [{
        id: 'calendar',
        label: 'Calendar',
        connected: false,
        readiness: 'unavailable',
        actions: [],
        capabilities: [],
      }],
    );

    expect(getNativeConnectorLifecycleActions(row)).toEqual(['probe', 'disconnect', 'remove']);
  });
});

describe('NativeConnectorItems', () => {
  it('renders readiness, available actions and lifecycle buttons', () => {
    const rows = buildNativeConnectorRows(inventory, statuses);
    const html = renderToStaticMarkup(React.createElement(NativeConnectorItems, {
      rows,
      busyKey: null,
      onToggle: vi.fn(),
      onLifecycleAction: vi.fn(),
    }));

    expect(html).toContain('Calendar');
    expect(html).toContain('检查失败');
    expect(html).toContain('可用动作: 检查、修复权限、断开、移除');
    expect(html).toContain('Automation denied');
    expect(html).toContain('检查');
    expect(html).toContain('修复权限');
    expect(html).toContain('断开');
    expect(html).toContain('移除');
    expect(html).toContain('Mail');
    expect(html).toContain('已停用');
  });

  it('marks the active action as loading and disables controls for the same connector', () => {
    const [row] = buildNativeConnectorRows([inventory[0]], statuses);
    const html = renderToStaticMarkup(React.createElement(NativeConnectorItems, {
      rows: [row],
      busyKey: 'calendar:probe',
      onToggle: vi.fn(),
      onLifecycleAction: vi.fn(),
    }));

    expect(html).toContain('检查中');
    expect(html).toContain('disabled=""');
  });

  it('does not render lifecycle buttons for disabled connectors', () => {
    const rows = buildNativeConnectorRows([inventory[1]], []);
    const html = renderToStaticMarkup(React.createElement(NativeConnectorItems, {
      rows,
      busyKey: null,
      onToggle: vi.fn(),
      onLifecycleAction: vi.fn(),
    }));

    expect(html).toContain('Mail');
    expect(html).toContain('已停用');
    expect(html).not.toContain('<button');
  });
});

describe('RuntimeConnectorItems', () => {
  it('renders readiness, details, capabilities and safe lifecycle buttons', () => {
    const rows = buildRuntimeConnectorRows(inventory, statuses);
    const html = renderToStaticMarkup(React.createElement(RuntimeConnectorItems, {
      rows,
      busyKey: null,
      onLifecycleAction: vi.fn(),
    }));

    expect(html).toContain('Browser Workbench');
    expect(html).toContain('可用');
    expect(html).toContain('已连接');
    expect(html).toContain('能力: open_page、screenshot');
    expect(html).toContain('Browser session available');
    expect(html).toContain('Recipe Runner');
    expect(html).toContain('检查失败');
    expect(html).toContain('Recipe runtime unavailable');
    expect(html).toContain('可用动作: 重试、检查');
    expect(html).toContain('重试');
    expect(html).toContain('检查');
  });

  it('does not render disconnect or remove buttons for runtime connectors', () => {
    const rows = buildRuntimeConnectorRows(inventory, statuses);
    const html = renderToStaticMarkup(React.createElement(RuntimeConnectorItems, {
      rows,
      busyKey: null,
      onLifecycleAction: vi.fn(),
    }));

    expect(html).not.toContain('断开');
    expect(html).not.toContain('移除');
  });

  it('marks runtime actions as loading and disables controls for the same connector', () => {
    const [row] = buildRuntimeConnectorRows(inventory, statuses);
    const html = renderToStaticMarkup(React.createElement(RuntimeConnectorItems, {
      rows: [row],
      busyKey: 'browser-workbench:retry',
      onLifecycleAction: vi.fn(),
    }));

    expect(html).toContain('重试中');
    expect(html).toContain('disabled=""');
  });
});
