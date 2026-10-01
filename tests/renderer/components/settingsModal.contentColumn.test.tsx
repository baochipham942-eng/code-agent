// @vitest-environment jsdom
// ============================================================================
// FB-215：设置页内容列左锚定（mr-auto 而非 mx-auto），宽 tab（model，max-w-6xl）
// 与窄 tab（search，max-w-4xl）切换时内容左缘不再跳动。
// 容器带 data-testid="settings-content-column" 供编排者截图量左缘。
// ============================================================================
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../src/renderer/components/features/settings/SettingsSearch', () => ({
  SettingsSearch: () => null,
}));

vi.mock('../../../src/renderer/slots/productSlotHosts', () => ({
  SettingsSectionSlotHost: () => null,
}));

vi.mock('../../../src/renderer/components/composites/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('../../../src/renderer/components/UpdateNotification', () => ({
  UpdateNotification: () => null,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/ModelSettings', () => ({
  ModelSettings: () => <div data-testid="stub-model-settings" />,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/SearchSettings', () => ({
  SearchSettings: () => <div data-testid="stub-search-settings" />,
}));

import { SettingsModal } from '../../../src/renderer/components/features/settings/SettingsModal';
import { useAppStore } from '../../../src/renderer/stores/appStore';

afterEach(() => {
  cleanup();
  useAppStore.setState({ settingsInitialTab: null });
});

describe('SettingsModal 内容列左锚定（FB-215）', () => {
  it('宽 tab（model）：内容列 mr-auto、不含 mx-auto，带 data-testid', () => {
    useAppStore.setState({ settingsInitialTab: 'model' });
    render(<SettingsModal />);

    const column = screen.getByTestId('settings-content-column');
    expect(column.classList.contains('mr-auto')).toBe(true);
    expect(column.classList.contains('mx-auto')).toBe(false);
    expect(column.classList.contains('max-w-6xl')).toBe(true);
  });

  it('窄 tab（search）：内容列 mr-auto、不含 mx-auto', () => {
    useAppStore.setState({ settingsInitialTab: 'search' });
    render(<SettingsModal />);

    const column = screen.getByTestId('settings-content-column');
    expect(column.classList.contains('mr-auto')).toBe(true);
    expect(column.classList.contains('mx-auto')).toBe(false);
    expect(column.classList.contains('max-w-4xl')).toBe(true);
  });
});
