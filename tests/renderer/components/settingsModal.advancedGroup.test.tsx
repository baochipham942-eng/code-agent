// @vitest-environment jsdom
// ============================================================================
// FB-572：「高级」折叠组头是导航入口，不是纯开关——
//   折叠时点它 = 展开 + 落到组内第一个可见 tab（右栏不再滞留无关旧页）；
//   已展开时点它 = 只收起，activeTab 不动；
//   折叠且 activeTab 在组内时，组头顶替子项标出「你在这里」（aria-current）。
// 切 tab 的那半步必须过 guardWhileModelDirty（未保存 Provider 表单先弹丢弃确认）。
// mock 面与 settingsModal.contentColumn.test.tsx 同款（ipcService / Search / SlotHost /
// UpdateNotification / 相关 tab 组件桩）。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));

vi.mock('../../../src/renderer/components/features/settings/SettingsSearch', () => ({
  SettingsSearch: () => null,
}));

vi.mock('../../../src/renderer/slots/productSlotHosts', () => ({
  SettingsSectionSlotHost: () => null,
}));

vi.mock('../../../src/renderer/components/UpdateNotification', () => ({
  UpdateNotification: () => null,
}));

vi.mock('../../../src/renderer/components/composites/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm }: { isOpen: boolean; onConfirm: () => void }) =>
    (isOpen ? <div data-testid="stub-confirm-dialog" onClick={onConfirm} /> : null),
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/ModelSettings', () => ({
  ModelSettings: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => (
    <button type="button" data-testid="stub-model-settings" onClick={() => onDirtyChange(true)}>
      stub-model-settings
    </button>
  ),
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/ChannelsSettings', () => ({
  ChannelsSettings: () => <div data-testid="stub-channels-settings" />,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/AgentEngineSettings', () => ({
  AgentEngineSettings: () => <div data-testid="stub-agent-engine-settings" />,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/DataSettings', () => ({
  DataSettings: () => <div data-testid="stub-cache-settings" />,
}));

import { zh } from '../../../src/renderer/i18n/zh';
import { SettingsModal } from '../../../src/renderer/components/features/settings/SettingsModal';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const ADVANCED_GROUP_LABEL = zh.settings.tabGroups.advanced; // 「高级」
const FIRST_ADVANCED_TAB_LABEL = zh.engineCompat.engineSection.title; // 「执行引擎」
const CHANNELS_TAB_LABEL = zh.settings.tabs.channels; // 「通道」
const MODEL_TAB_LABEL = zh.settings.tabs.model; // 「通用模型」
const CACHE_TAB_LABEL = zh.settings.tabs.cache; // 「数据与存储」

function advancedHeaderButton(): HTMLElement {
  return screen.getByRole('button', { name: ADVANCED_GROUP_LABEL });
}

function navButtons(): HTMLElement[] {
  const nav = document.querySelector('nav');
  expect(nav).toBeTruthy();
  return within(nav as HTMLElement).getAllByRole('button');
}

/** 左 nav 里处于选中态（bg-zinc-800）的子项；折叠组头的高亮是 bg-zinc-800/60，不会被计入 */
function selectedNavChildren(): HTMLElement[] {
  return navButtons().filter((button) => button.classList.contains('bg-zinc-800'));
}

function paneTitle(): string {
  return document.getElementById('settings-page-title')?.textContent ?? '';
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ settingsInitialTab: null });
});

describe('设置页「高级」折叠组头导航（FB-572）', () => {
  it('从非高级 tab（通道）点「高级」组头：展开并落到组内第一个可见 tab，左 nav 该项选中', async () => {
    useAppStore.setState({ settingsInitialTab: 'channels' });
    render(<SettingsModal />);
    await screen.findByTestId('stub-channels-settings');
    expect(paneTitle()).toBe(CHANNELS_TAB_LABEL);

    fireEvent.click(advancedHeaderButton());

    // 右栏切到组内第一个可见 tab（执行引擎），左 nav 恰好一项选中且就是它
    await screen.findByTestId('stub-agent-engine-settings');
    expect(paneTitle()).toBe(FIRST_ADVANCED_TAB_LABEL);
    const selected = selectedNavChildren();
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent?.trim()).toBe(FIRST_ADVANCED_TAB_LABEL);
    expect(advancedHeaderButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('组头展开后始终恰好一个选中子项，且其文案与页标题一致（含再点其他子项后）', async () => {
    useAppStore.setState({ settingsInitialTab: 'channels' });
    render(<SettingsModal />);
    fireEvent.click(advancedHeaderButton());
    await screen.findByTestId('stub-agent-engine-settings');

    let selected = selectedNavChildren();
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent?.trim()).toBe(paneTitle());

    // 组内换一个子项（数据与存储），仍恰好一个选中、与页标题一致
    fireEvent.click(screen.getByRole('button', { name: CACHE_TAB_LABEL }));
    await screen.findByTestId('stub-cache-settings');
    expect(paneTitle()).toBe(CACHE_TAB_LABEL);
    selected = selectedNavChildren();
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent?.trim()).toBe(CACHE_TAB_LABEL);
  });

  it('再点一次组头：只收起不动 activeTab；折叠时组头带 aria-current 高亮顶替子项', async () => {
    useAppStore.setState({ settingsInitialTab: 'channels' });
    render(<SettingsModal />);
    fireEvent.click(advancedHeaderButton());
    await screen.findByTestId('stub-agent-engine-settings');
    // 展开态：子项自己选中，组头不带 current 标记
    expect(advancedHeaderButton().getAttribute('aria-current')).toBeNull();

    fireEvent.click(advancedHeaderButton());

    // 子项收起、页面不换，组头转折叠态并标「你在这里」
    expect(screen.queryByRole('button', { name: FIRST_ADVANCED_TAB_LABEL })).toBeNull();
    expect(paneTitle()).toBe(FIRST_ADVANCED_TAB_LABEL);
    expect(advancedHeaderButton().getAttribute('aria-expanded')).toBe('false');
    expect(advancedHeaderButton().getAttribute('aria-current')).toBe('true');
    expect(advancedHeaderButton().classList.contains('text-zinc-200')).toBe(true);
  });

  it('「通用模型」表单未保存时点组头：弹既有丢弃确认而不是直接切页；确认丢弃后才展开并切换', async () => {
    useAppStore.setState({ settingsInitialTab: 'model' });
    render(<SettingsModal />);
    fireEvent.click(await screen.findByTestId('stub-model-settings')); // 上报 onDirtyChange(true)

    fireEvent.click(advancedHeaderButton());

    // 拦截生效：确认框出现，页仍停在通用模型，高级组未展开
    expect(screen.getByTestId('stub-confirm-dialog')).toBeTruthy();
    expect(paneTitle()).toBe(MODEL_TAB_LABEL);
    expect(advancedHeaderButton().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: FIRST_ADVANCED_TAB_LABEL })).toBeNull();

    // 确认丢弃 → 被拦下的导航（展开 + 切第一个可见 tab）执行
    fireEvent.click(screen.getByTestId('stub-confirm-dialog'));
    await screen.findByTestId('stub-agent-engine-settings');
    expect(paneTitle()).toBe(FIRST_ADVANCED_TAB_LABEL);
    expect(advancedHeaderButton().getAttribute('aria-expanded')).toBe('true');
  });
});
