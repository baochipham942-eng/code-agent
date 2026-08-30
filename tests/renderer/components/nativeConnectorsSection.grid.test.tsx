// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatusSummary, NativeConnectorInventoryItem } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const { mockInvokeDomain } = vi.hoisted(() => ({
  mockInvokeDomain: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mockInvokeDomain },
}));

import { NativeConnectorsSection } from '../../../src/renderer/components/features/settings/sections/NativeConnectorsSection';

const inventory: NativeConnectorInventoryItem[] = [
  { id: 'calendar', label: '日历', enabled: true },
  { id: 'mail', label: '邮件', enabled: true },
  { id: 'photos', label: '照片', enabled: false },
  { id: 'reminders', label: '提醒事项', enabled: true },
];

const statuses: ConnectorStatusSummary[] = inventory.map((item) => ({
  id: item.id,
  label: item.label,
  connected: item.enabled,
  readiness: item.enabled ? 'ready' : 'unchecked',
  capabilities: [`${item.id}_read`],
}));

describe('NativeConnectorsSection grid presentation', () => {
  afterEach(() => {
    cleanup();
    mockInvokeDomain.mockReset();
  });

  it('shows all four native connectors as ordinary-user cards without runtime diagnostics', async () => {
    mockInvokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listNativeInventory') return Promise.resolve(inventory);
      if (action === 'listStatuses') return Promise.resolve(statuses);
      return Promise.resolve(undefined);
    });

    render(React.createElement(NativeConnectorsSection, { presentation: 'grid' }));

    for (const item of inventory) {
      expect(await screen.findByTestId(`native-connector-card-${item.id}`)).toBeTruthy();
    }
    expect(screen.getByText(zh.settings.nativeConnectors.grid.labels.calendar)).toBeTruthy();
    expect(screen.getByText(zh.settings.nativeConnectors.grid.descriptions.photos)).toBeTruthy();
    expect(screen.getAllByRole('switch')).toHaveLength(4);
    expect(screen.queryByText(zh.settings.nativeConnectors.otherConnectors)).toBeNull();
  });
});
