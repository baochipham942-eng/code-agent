// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn().mockResolvedValue(undefined), on: () => () => {} },
}));
vi.mock('../../../src/renderer/components/SessionActionsMenu', () => ({
  SessionActionsMenu: () => null,
}));

import { TitleBar } from '../../../src/renderer/components/TitleBar';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { en } from '../../../src/renderer/i18n/en';

beforeEach(() => {
  useAppStore.setState({ language: 'en', workbenchCollapsed: false, workbenchTabs: [], activeWorkbenchTab: null });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh', workbenchCollapsed: false });
});

describe('TitleBar 右栏开关', () => {
  it('管的是整栏，不是「概览」这一个面板', () => {
    render(<TitleBar />);

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.collapsePanel));
    expect(useAppStore.getState().workbenchCollapsed).toBe(true);
    // 旧行为是往 workbenchTabs 里塞/删 overview；换成整栏开关后它不该再被动过。
    expect(useAppStore.getState().workbenchTabs).toEqual([]);

    fireEvent.click(screen.getByLabelText(en.workbenchTabs.expandPanel));
    expect(useAppStore.getState().workbenchCollapsed).toBe(false);
  });
});
