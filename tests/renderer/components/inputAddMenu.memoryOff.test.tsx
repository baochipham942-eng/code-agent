// @vitest-environment jsdom
// N-TASK-MEMORY-OFF：「本任务不用记忆」开关的 UI 行为——菜单行、触发器旁的 chip、
// 首句话后的锁定。store 面用可变 mock（sessionStore）+ 真实 composerStore（草稿槽）。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const registryState = {
  skills: [] as any[],
  connectors: [] as any[],
  mcpServers: [] as any[],
};
vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({ ...registryState, items: [] }),
}));
const agentRegistryState = { entries: [] as any[] };
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector: (state: typeof agentRegistryState) => unknown) => selector(agentRegistryState),
}));
const appState = {
  activeAgentId: null as string | null,
  setActiveAgentId: vi.fn(),
  openCapabilityHub: vi.fn(),
  openSettingsTab: vi.fn(),
  syncActiveAgentForSession: vi.fn(),
  activeAgentSessionKey: null as string | null,
  bindAgentForSession: vi.fn(),
};
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof appState) => unknown) => selector(appState),
    {
      getState: () => appState,
      setState: (patch: Partial<typeof appState>) => { Object.assign(appState, patch); },
    },
  ),
}));
const sessionStoreState = {
  currentSessionId: null as string | null,
  sessions: [] as Array<{ id: string; memoryMode?: string; messageCount: number }>,
  messages: [] as Array<{ id: string }>,
  updateSessionMemoryMode: vi.fn(async () => {}),
};
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionStoreState) => unknown) => selector(sessionStoreState),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});
import { InputAddMenu } from '../../../src/renderer/components/features/chat/ChatInput/InputAddMenu';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { DRAFT_SCOPE_KEY } from '../../../src/renderer/stores/composerScopeModel';

function renderMenu() {
  return render(<InputAddMenu onFileSelect={vi.fn()} onSelectCapability={vi.fn()} />);
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: '更多输入选项' }));
}

function memorySwitch() {
  return screen.getByRole('switch', { name: '本任务不用记忆' });
}

beforeEach(() => {
  vi.clearAllMocks();
  registryState.skills = [];
  registryState.connectors = [];
  registryState.mcpServers = [];
  agentRegistryState.entries = [];
  appState.activeAgentId = null;
  sessionStoreState.currentSessionId = null;
  sessionStoreState.sessions = [];
  sessionStoreState.messages = [];
  useComposerStore.getState().activateScope(DRAFT_SCOPE_KEY);
  useComposerStore.getState().setDraftMemoryOff(false);
});
afterEach(cleanup);

describe('InputAddMenu 本任务不用记忆', () => {
  it('菜单行存在且带说明；草稿态点开关 → 草稿槽标记翻 true、chip 出现在 + 旁', () => {
    renderMenu();
    openMenu();
    expect(screen.getByText('本任务不用记忆')).toBeTruthy();
    expect(screen.getByText('不读取也不保存记忆；任务开始后不可更改')).toBeTruthy();
    expect(screen.queryByTestId('input-add-memory-chip')).toBeNull();

    fireEvent.click(memorySwitch());

    expect(useComposerStore.getState().draftMemoryOff).toBe(true);
    expect(screen.getByTestId('input-add-memory-chip')).toBeTruthy();
    expect(screen.getByTestId('input-add-memory-chip').textContent).toContain('本任务不用记忆');
  });

  it('空白会话（0 消息）：点开关走 updateSessionMemoryMode 落 host 档', () => {
    sessionStoreState.currentSessionId = 's-blank';
    sessionStoreState.sessions = [{ id: 's-blank', memoryMode: 'auto', messageCount: 0 }];
    useComposerStore.getState().activateScope('session:s-blank' as `session:${string}`);
    renderMenu();
    openMenu();

    fireEvent.click(memorySwitch());

    expect(sessionStoreState.updateSessionMemoryMode).toHaveBeenCalledWith('s-blank', 'off');
    expect(useComposerStore.getState().draftMemoryOff).toBe(false);
  });

  it('会话有消息：开关禁用、锁定原因可见、点击不触发任何改档', () => {
    sessionStoreState.currentSessionId = 's-started';
    sessionStoreState.sessions = [{ id: 's-started', memoryMode: 'auto', messageCount: 3 }];
    sessionStoreState.messages = [{ id: 'm1' }];
    useComposerStore.getState().activateScope('session:s-started' as `session:${string}`);
    renderMenu();
    openMenu();

    expect(screen.getByText('任务开始后不可更改，请新开一个任务')).toBeTruthy();
    const switchButton = memorySwitch();
    expect((switchButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(switchButton);

    expect(sessionStoreState.updateSessionMemoryMode).not.toHaveBeenCalled();
  });

  it('会话档已是 off：开关呈现开、chip 常驻（含锁定态）', () => {
    sessionStoreState.currentSessionId = 's-off';
    sessionStoreState.sessions = [{ id: 's-off', memoryMode: 'off', messageCount: 2 }];
    sessionStoreState.messages = [{ id: 'm1' }];
    useComposerStore.getState().activateScope('session:s-off' as `session:${string}`);
    renderMenu();

    const chip = screen.getByTestId('input-add-memory-chip');
    expect(chip.title).toBe('任务开始后不可更改，请新开一个任务');

    openMenu();
    expect(memorySwitch().getAttribute('aria-checked')).toBe('true');
    expect((memorySwitch() as HTMLButtonElement).disabled).toBe(true);
  });

  it('草稿态再点一次关掉 → 草稿槽标记回 false、chip 消失', () => {
    renderMenu();
    openMenu();
    fireEvent.click(memorySwitch());
    expect(screen.getByTestId('input-add-memory-chip')).toBeTruthy();

    fireEvent.click(memorySwitch());

    expect(useComposerStore.getState().draftMemoryOff).toBe(false);
    expect(screen.queryByTestId('input-add-memory-chip')).toBeNull();
  });
});
