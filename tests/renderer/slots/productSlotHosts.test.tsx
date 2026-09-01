// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UI_SLOT_CONTRACTS } from '../../../src/shared/contract/uiSlots';
import { SETTINGS_TAB_IDS } from '../../../src/renderer/utils/settingsTabs';

vi.mock('../../../src/renderer/internalFeatures/InternalFeatureHost', () => ({
  InternalFeatureHost: ({ featureId }: { featureId: string }) => (
    <div data-testid="internal-feature-page">{featureId}</div>
  ),
}));

import {
  ConversationTurnTailSlot,
  ConversationTurnTailSlotHost,
  HubTabSlotHost,
  InternalFeatureWorkspaceRegistration,
  NavAccountItemSlotHost,
  SettingsSectionSlotHost,
  ShellOverlaySlotHost,
  WorkspacePageSlotHost,
} from '../../../src/renderer/slots/productSlotHosts';
import {
  activatePluginUi,
  slots,
  unloadPluginUi,
} from '../../../src/renderer/slots/pluginUiSdk';
import { applyPluginUiActivationSettings } from '../../../src/renderer/slots/pluginUiActivationPolicy';

const activePluginIds = new Set<string>();

async function installTestPlugin(
  name: keyof typeof UI_SLOT_CONTRACTS,
  target: { id?: string; key?: string },
  onClose = vi.fn(),
): Promise<{ onClose: ReturnType<typeof vi.fn>; pluginId: string }> {
  const pluginId = `test-plugin-${name}`;
  activePluginIds.add(pluginId);
  const Occupant = (props: Record<string, unknown>) => (
    <button
      type="button"
      data-testid={`occupant-${name}`}
      data-active={String(props.active ?? '')}
      data-session-id={String(props.sessionId ?? '')}
      data-turn-id={String(props.turnId ?? '')}
      onClick={() => {
        if (typeof props.onClose === 'function') props.onClose();
        onClose();
      }}
    >
      {name}
    </button>
  );
  await activatePluginUi(pluginId, () => {
    slots.inject(name, () => slots.register({ name, ...target }, Occupant));
  });
  return { onClose, pluginId };
}

afterEach(async () => {
  cleanup();
  for (const pluginId of activePluginIds) await unloadPluginUi(pluginId);
  activePluginIds.clear();
  vi.restoreAllMocks();
});

describe('ADR-062 六个产品座位', () => {
  it('nav.account.item 真装载在账号菜单条目区，卸载与宿主卸载后都消失', async () => {
    const hostClose = vi.fn();
    const { pluginId } = await installTestPlugin('nav.account.item', { id: 'nav' });
    const view = render(<div data-testid="account-items"><NavAccountItemSlotHost onClose={hostClose} /></div>);

    fireEvent.click(await screen.findByTestId('occupant-nav.account.item'));
    expect(hostClose).toHaveBeenCalledTimes(1);
    expect(slots.get('nav.account.item')?.declaredBy).toBe('SidebarAccountMenu');

    await act(() => unloadPluginUi(pluginId));
    expect(screen.queryByTestId('occupant-nav.account.item')).toBeNull();
    view.unmount();
    expect(slots.get('nav.account.item')).toBeUndefined();
  });

  it('hub.tab 真装载在能力中心页签区，保留 active props，卸载后消失', async () => {
    const { pluginId } = await installTestPlugin('hub.tab', { id: 'hub' });
    const view = render(<nav role="tablist"><HubTabSlotHost active /></nav>);

    const occupant = await screen.findByTestId('occupant-hub.tab');
    expect(occupant.dataset.active).toBe('true');
    expect(slots.get('hub.tab')?.declaredBy).toBe('CapabilityHubPage');

    await act(() => unloadPluginUi(pluginId));
    expect(screen.queryByTestId('occupant-hub.tab')).toBeNull();
    view.unmount();
    expect(slots.get('hub.tab')).toBeUndefined();
  });

  it('settings.section 真装载在设置内容区，卸载后消失', async () => {
    const { pluginId } = await installTestPlugin('settings.section', { id: 'settings' });
    const view = render(<main data-testid="settings-content"><SettingsSectionSlotHost /></main>);

    expect(await screen.findByTestId('occupant-settings.section')).toBeTruthy();
    expect(slots.get('settings.section')?.declaredBy).toBe('SettingsModal');

    await act(() => unloadPluginUi(pluginId));
    expect(screen.queryByTestId('occupant-settings.section')).toBeNull();
    view.unmount();
    expect(slots.get('settings.section')).toBeUndefined();
  });

  it('workspace.page 真装载为 keyed 工作区，卸载后恢复宿主 fallback', async () => {
    const { pluginId } = await installTestPlugin('workspace.page', { key: 'workspace' });
    const view = render(<WorkspacePageSlotHost fallback={<div>WORKSPACE FALLBACK</div>} />);

    expect(await screen.findByTestId('occupant-workspace.page')).toBeTruthy();
    expect(screen.queryByText('WORKSPACE FALLBACK')).toBeNull();
    expect(slots.get('workspace.page')?.declaredBy).toBe('App');

    await act(() => unloadPluginUi(pluginId));
    expect(screen.queryByTestId('occupant-workspace.page')).toBeNull();
    expect(screen.getByText('WORKSPACE FALLBACK')).toBeTruthy();
    view.unmount();
    expect(slots.get('workspace.page')).toBeUndefined();
  });

  it('shell.overlay 真装载在不会随会话切换卸载的全框容器，卸载后消失', async () => {
    const { pluginId } = await installTestPlugin('shell.overlay', { id: 'overlay' });
    const view = render(<ShellOverlaySlotHost />);

    const occupant = await screen.findByTestId('occupant-shell.overlay');
    const overlayHost = occupant.closest('[data-plugin-slot-host="shell.overlay"]');
    expect(overlayHost?.classList.contains('fixed')).toBe(true);
    expect(overlayHost?.classList.contains('inset-0')).toBe(true);
    expect(slots.get('shell.overlay')?.declaredBy).toBe('App');

    await act(() => unloadPluginUi(pluginId));
    expect(screen.queryByTestId('occupant-shell.overlay')).toBeNull();
    view.unmount();
    expect(slots.get('shell.overlay')).toBeUndefined();
  });

  it('conversation.turnTail 真装载在一轮对话之后并收到会话与轮次 props，卸载后消失', async () => {
    const { pluginId } = await installTestPlugin('conversation.turnTail', { id: 'tail' });
    const view = render(
      <>
        <ConversationTurnTailSlotHost />
        <div data-testid="turn-card">TURN</div>
        <div data-testid="turn-tail"><ConversationTurnTailSlot sessionId="session-1" turnId="turn-1" /></div>
      </>,
    );

    const occupant = await screen.findByTestId('occupant-conversation.turnTail');
    expect(occupant.dataset.sessionId).toBe('session-1');
    expect(occupant.dataset.turnId).toBe('turn-1');
    expect(screen.getByTestId('turn-card').compareDocumentPosition(screen.getByTestId('turn-tail')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slots.get('conversation.turnTail')?.declaredBy).toBe('TurnBasedTraceView');

    await act(() => unloadPluginUi(pluginId));
    expect(screen.queryByTestId('occupant-conversation.turnTail')).toBeNull();
    view.unmount();
    expect(slots.get('conversation.turnTail')).toBeUndefined();
  });

  it('evaluation-center 通过 workspace.page 注册出现，关闭后 occupant 与页面一起消失', async () => {
    await applyPluginUiActivationSettings({ pluginUi: { thirdPartyEnabled: false } });
    const view = render(
      <>
        <WorkspacePageSlotHost fallback={<div>CHAT</div>} />
        <InternalFeatureWorkspaceRegistration featureId="evaluation-center" />
      </>,
    );

    expect((await screen.findByTestId('internal-feature-page')).textContent).toBe('evaluation-center');
    expect(slots.get('workspace.page')?.occupants).toEqual([
      { key: 'evaluation-center', pluginId: 'evaluation-center', status: 'active' },
    ]);

    view.rerender(
      <>
        <WorkspacePageSlotHost fallback={<div>CHAT</div>} />
        <InternalFeatureWorkspaceRegistration featureId={null} />
      </>,
    );
    await waitFor(() => expect(screen.queryByTestId('internal-feature-page')).toBeNull());
    expect(screen.getByText('CHAT')).toBeTruthy();
    expect(slots.get('workspace.page')?.occupants).toEqual([]);
  });
});

describe('座位清单与宿主接线防退化', () => {
  const rendererRoot = resolve(process.cwd(), 'src/renderer');
  const slotHostSource = readFileSync(resolve(rendererRoot, 'slots/productSlotHosts.tsx'), 'utf8');

  it('只声明 ADR-062 拍板的六个座位，不声明 root、sidebar 或 tool.call.view', () => {
    const declaredNames = [...slotHostSource.matchAll(/declareSlot\('([^']+)'/gu)].map((match) => match[1]);
    expect(declaredNames).toEqual([
      'nav.account.item',
      'hub.tab',
      'settings.section',
      'workspace.page',
      'shell.overlay',
      'conversation.turnTail',
    ]);
    expect(declaredNames).not.toEqual(expect.arrayContaining(['root', 'sidebar', 'tool.call.view']));
  });

  it('六个公开契约全部保持 replaceRisk none', () => {
    expect(Object.keys(UI_SLOT_CONTRACTS)).toEqual([
      'nav.account.item',
      'hub.tab',
      'settings.section',
      'workspace.page',
      'shell.overlay',
      'conversation.turnTail',
    ]);
    expect(Object.values(UI_SLOT_CONTRACTS).map((contract) => contract.replaceRisk))
      .toEqual(Array(6).fill('none'));
  });

  it('宿主文件把六个座位接在指定产品位置，App 不保留旧内部插件三元', () => {
    const sidebar = readFileSync(resolve(rendererRoot, 'components/features/sidebar/SidebarAccountMenu.tsx'), 'utf8');
    const hub = readFileSync(resolve(rendererRoot, 'components/features/capabilityHub/CapabilityHubPage.tsx'), 'utf8');
    const settings = readFileSync(resolve(rendererRoot, 'components/features/settings/SettingsModal.tsx'), 'utf8');
    const trace = readFileSync(resolve(rendererRoot, 'components/features/chat/TurnBasedTraceView.tsx'), 'utf8');
    const app = readFileSync(resolve(rendererRoot, 'App.tsx'), 'utf8');

    expect(sidebar.indexOf('<NavAccountItemSlotHost')).toBeLessThan(sidebar.indexOf('<div className="my-1 border-t'));
    expect(hub.indexOf('<HubTabSlotHost active />')).toBeGreaterThan(hub.indexOf('BUILT_IN_HUB_TABS.map'));
    expect(settings.indexOf('<SettingsSectionSlotHost />')).toBeGreaterThan(settings.indexOf('<React.Suspense fallback={<SettingsTabSkeleton />}>'));
    expect(trace.indexOf('<ConversationTurnTailSlot')).toBeGreaterThan(trace.indexOf('<TurnCard'));
    expect(app).toContain('<WorkspacePageSlotHost fallback={showInAppValidation');
    expect(app).toContain('<ShellOverlaySlotHost />');
    expect(app).not.toContain('activeInternalFeatureId ?');
  });

  it('能力中心内建项内容与顺序一字不差，插件项只能追加在内建项之后', () => {
    const hub = readFileSync(resolve(rendererRoot, 'components/features/capabilityHub/CapabilityHubPage.tsx'), 'utf8');
    const builtIns = [...hub.matchAll(/\{ key: '([^']+)', icon:/gu)].map((match) => match[1]);
    expect(builtIns).toEqual(['experts', 'skills', 'connectors', 'plugins', 'candidates']);
    expect(hub.indexOf('<HubTabSlotHost active />')).toBeGreaterThan(hub.indexOf('BUILT_IN_HUB_TABS.map'));
  });

  it('设置页内建 SETTINGS_TAB_IDS 内容与顺序保持不变', () => {
    expect(SETTINGS_TAB_IDS).toEqual([
      'general', 'conversation', 'search', 'voiceLive', 'voiceInput', 'keybindings', 'doctor',
      'model', 'visualModels', 'voiceModel', 'agentEngine', 'appearance', 'soul', 'workspace',
      'automation', 'appshots', 'cache', 'capabilities', 'plugins', 'mcp', 'skills', 'roles',
      'channels', 'hooks', 'memory', 'openchronicle', 'privacy', 'update', 'about',
    ]);
  });
});
