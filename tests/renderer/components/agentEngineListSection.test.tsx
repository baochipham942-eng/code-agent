// @vitest-environment jsdom
// ============================================================================
// AgentEngineListSection — 设置页执行引擎列表：
//   初始 listSources+list；检测 detect→listSources；
//   正式 kind 可切换，Qoder/Comate/Cursor 禁用。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEngineDescriptor,
  AgentEngineSourceDescriptor,
} from '../../../src/shared/contract/agentEngine';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeDomainMock = vi.hoisted(() => vi.fn());
const updateSessionEngine = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomainMock(...args) },
}));

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{
    id: 'session-1',
    workingDirectory: '/workspace' as string | undefined,
    engine: { kind: 'native' as const },
  }],
  updateSessionEngine,
};

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));

const appState = {
  workingDirectory: '/workspace' as string | undefined,
};

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

import { AgentEngineListSection } from '../../../src/renderer/components/features/settings/tabs/AgentEngineListSection';

function makeSource(
  overrides: Partial<AgentEngineSourceDescriptor> & Pick<AgentEngineSourceDescriptor, 'manifestId' | 'label'>,
): AgentEngineSourceDescriptor {
  return {
    summary: `${overrides.label} summary`,
    detected: false,
    selectable: false,
    authState: 'not_checked',
    modelSelection: 'unavailable',
    evidence: 'none',
    credentialOwner: 'official_client',
    auditNotes: ['never show secrets'],
    ...overrides,
  };
}

function makeDescriptor(
  kind: AgentEngineDescriptor['kind'],
  overrides: Partial<AgentEngineDescriptor> = {},
): AgentEngineDescriptor {
  return {
    manifestId: kind,
    kind,
    label: kind === 'native' ? 'Neo' : kind,
    summary: 'summary',
    installState: kind === 'native' ? 'builtin' : 'installed',
    runtimeState: 'ready',
    executable: true,
    capabilities: [],
    defaultPermissionProfile: 'read_only',
    cwdPolicy: 'workspace_only',
    riskTier: 'medium',
    detectedAt: 1,
    modelSelection: kind === 'native' ? 'neo_provider' : 'runtime_catalog',
    ...overrides,
  };
}

const sources: AgentEngineSourceDescriptor[] = [
  makeSource({
    manifestId: 'native',
    kind: 'native',
    label: 'Neo',
    detected: true,
    selectable: true,
    authState: 'authenticated',
    evidence: 'production',
    modelSelection: 'neo_provider',
    credentialOwner: 'neo',
  }),
  makeSource({
    manifestId: 'codebuddy_code',
    kind: 'codebuddy_code',
    label: 'WorkBuddy',
    detected: true,
    selectable: true,
    authState: 'authenticated',
    evidence: 'production',
    modelSelection: 'client_default',
  }),
  makeSource({
    manifestId: 'grok_cli',
    kind: 'grok_cli',
    label: 'Grok Build',
    detected: true,
    selectable: true,
    authState: 'authenticated',
    evidence: 'production',
    modelSelection: 'runtime_catalog',
  }),
  makeSource({
    manifestId: 'qoder_work',
    label: 'Qoder Work',
    detected: true,
    authState: 'needs_login',
    evidence: 'local_spike',
  }),
  makeSource({
    manifestId: 'comate_zulu',
    label: 'Comate / Zulu',
    detected: true,
    evidence: 'local_spike',
  }),
  makeSource({
    manifestId: 'cursor_cli',
    label: 'Cursor CLI',
    recommendation: { label: '推荐了解', reason: '尚无本仓实机协议证据' },
  }),
];

const descriptors: AgentEngineDescriptor[] = [
  makeDescriptor('native', { label: 'Neo', installState: 'builtin' }),
  makeDescriptor('codebuddy_code', {
    label: 'WorkBuddy',
    modelSelection: 'client_default',
  }),
  makeDescriptor('grok_cli', { label: 'Grok Build' }),
];

function mockIpc() {
  invokeDomainMock.mockImplementation((_domain: string, action: string) => {
    if (action === 'listSources') return Promise.resolve(sources);
    if (action === 'list' || action === 'detect') return Promise.resolve(descriptors);
    if (action === 'get') return Promise.resolve({ models: { agentEngines: {} } });
    return Promise.resolve(undefined);
  });
}

describe('AgentEngineListSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIpc();
    sessionState.sessions[0].engine = { kind: 'native' };
  });
  afterEach(() => cleanup());

  it('初始加载并行调用 listSources 与 list，渲染完整探测来源', async () => {
    render(<AgentEngineListSection />);

    await waitFor(() => {
      expect(screen.getByText('WorkBuddy')).toBeTruthy();
      expect(screen.getByText('Qoder Work')).toBeTruthy();
      expect(screen.getByText('Comate / Zulu')).toBeTruthy();
      expect(screen.getByText('Cursor CLI')).toBeTruthy();
    });

    const actions = invokeDomainMock.mock.calls
      .filter(([domain]) => domain === IPC_DOMAINS.AGENT_ENGINE)
      .map(([, action]) => action);
    expect(actions).toEqual(expect.arrayContaining(['listSources', 'list']));
    expect(actions).not.toContain('detect');
  });

  it('检测引擎必须先 detect 再 listSources', async () => {
    render(<AgentEngineListSection />);
    await waitFor(() => expect(screen.getByText('WorkBuddy')).toBeTruthy());
    invokeDomainMock.mockClear();
    mockIpc();

    const callOrder: string[] = [];
    invokeDomainMock.mockImplementation((_domain: string, action: string) => {
      callOrder.push(action);
      if (action === 'listSources') return Promise.resolve(sources);
      if (action === 'list' || action === 'detect') return Promise.resolve(descriptors);
      if (action === 'get') return Promise.resolve({ models: { agentEngines: {} } });
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByTestId('engine-detect-button'));
    await waitFor(() => {
      expect(callOrder.filter((action) => action === 'detect' || action === 'listSources'))
        .toEqual(['detect', 'listSources']);
    });
  });

  it('WorkBuddy / Grok 可切换；Qoder / Comate / Cursor 切换按钮禁用', async () => {
    render(<AgentEngineListSection />);
    await waitFor(() => expect(screen.getByText('Cursor CLI')).toBeTruthy());

    const workbuddyRow = document.querySelector('[data-engine-manifest="codebuddy_code"]');
    const grokRow = document.querySelector('[data-engine-manifest="grok_cli"]');
    const qoderRow = document.querySelector('[data-engine-manifest="qoder_work"]');
    const comateRow = document.querySelector('[data-engine-manifest="comate_zulu"]');
    const cursorRow = document.querySelector('[data-engine-manifest="cursor_cli"]');

    expect(workbuddyRow?.getAttribute('data-engine-switchable')).toBe('true');
    expect(grokRow?.getAttribute('data-engine-switchable')).toBe('true');
    expect(qoderRow?.getAttribute('data-engine-switchable')).toBe('false');
    expect(comateRow?.getAttribute('data-engine-switchable')).toBe('false');
    expect(cursorRow?.getAttribute('data-engine-switchable')).toBe('false');
    expect(cursorRow?.getAttribute('data-engine-recommendation-only')).toBe('true');

    expect(qoderRow?.getAttribute('data-engine-source-status')).toBe('detected_needs_login');
    expect(comateRow?.getAttribute('data-engine-source-status')).toBe('detected_adapter_pending');
    expect(cursorRow?.getAttribute('data-engine-source-status')).toBe('recommended');

    expect((screen.getByTestId('engine-switch-button-codebuddy_code') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('engine-switch-button-grok_cli') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('engine-switch-button-qoder_work') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('engine-switch-button-comate_zulu') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('engine-switch-button-cursor_cli') as HTMLButtonElement).disabled).toBe(true);

    // 状态文案：Qoder 已检测+需要登录；Comate 适配未开放；Cursor 推荐
    expect(screen.getByText(zh.engineCompat.engineSection.sourceStatus.needsLogin)).toBeTruthy();
    expect(screen.getAllByText(zh.engineCompat.engineSection.sourceStatus.adapterPending).length).toBeGreaterThan(0);
    expect(screen.getByText('推荐了解')).toBeTruthy();

    // 不展示 auditNotes / 秘密
    expect(screen.queryByText('never show secrets')).toBeNull();
  });
});
