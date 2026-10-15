// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngineSourceDescriptor } from '../../../src/shared/contract/agentEngine';

const openCapabilitySettingsTarget = vi.fn();
const appState = {
  modelConfig: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
  },
  workingDirectory: '/workspace' as string | undefined,
  language: 'zh' as const,
  setLanguage: vi.fn(),
  cloudUIStrings: null,
  openCapabilitySettingsTarget,
};
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
}));

const updateSessionEngine = vi.fn();
const sessionState = {
  currentSessionId: 'session-1',
  sessions: [{
    id: 'session-1',
    workingDirectory: '/workspace' as string | undefined,
    engine: { kind: 'native' },
  }],
  updateSessionEngine,
};
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof sessionState) => unknown) => selector ? selector(sessionState) : sessionState,
}));

const sources: AgentEngineSourceDescriptor[] = [
  {
    manifestId: 'codex_cli',
    kind: 'codex_cli',
    label: 'Codex CLI',
    summary: 'Official CLI',
    detected: true,
    selectable: true,
    authState: 'authenticated',
    version: 'codex-cli 1.0.0',
    modelSelection: 'runtime_catalog',
    evidence: 'production',
    credentialOwner: 'official_client',
    auditNotes: [],
  },
];

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args) },
}));

import { ModelOnboardingModal } from '../../../src/renderer/components/onboarding/ModelOnboardingModal';
import { onboardingZh } from '../../../src/renderer/i18n/onboarding';
import { interpolate } from '../../../src/renderer/i18n/interpolate';

const text = onboardingZh.onboarding;

// jsdom 的 navigator.platform 是 ''（非 mac）——本机连接器行按平台门控（返工 r2），
// 本文件用例默认按 macOS 渲染，保持与本机（darwin）一致的行为面。
const originalPlatform = navigator.platform;
function stubNavigatorPlatform(value: string) {
  Object.defineProperty(navigator, 'platform', { configurable: true, value });
}

/** 默认 IPC 桩：探测到 codex_cli 订阅引擎；连接器步本机行按"授权通过"回包 */
function defaultInvoke(_domain: string, action: string): Promise<unknown> {
  if (action === 'listSources') return Promise.resolve(sources);
  if (action === 'listModels') {
    return Promise.resolve({
      catalog: {
        version: 'fixture',
        updatedAt: '2026-07-30T00:00:00.000Z',
        engines: [{
          kind: 'codex_cli',
          defaultModel: 'gpt-5.5',
          models: [{ id: 'gpt-5.5', label: 'GPT-5.5', capabilities: ['code'], recommended: true }],
        }],
      },
      source: 'local_discovery',
      diagnostics: [],
    });
  }
  if (action === 'get') return Promise.resolve({});
  if (action === 'set') return Promise.resolve(undefined);
  if (action === 'repairPermission') {
    return Promise.resolve([{
      id: 'mail',
      label: 'Mail',
      connected: true,
      readiness: 'ready',
      capabilities: [],
    }]);
  }
  if (action === 'listStatuses') return Promise.resolve([]);
  throw new Error(`Unexpected action: ${action}`);
}

beforeEach(() => {
  stubNavigatorPlatform('MacIntel');
  appState.workingDirectory = '/workspace';
  sessionState.sessions[0].workingDirectory = '/workspace';
  updateSessionEngine.mockReset();
  updateSessionEngine.mockResolvedValue(undefined);
  invokeDomain.mockReset();
  invokeDomain.mockImplementation(defaultInvoke);
  openCapabilitySettingsTarget.mockReset();
});

afterEach(() => {
  stubNavigatorPlatform(originalPlatform);
  cleanup();
});

/** 选订阅引擎进模型步，再点到连接器步 */
async function goToConnectorsStep() {
  fireEvent.click(await screen.findByTestId('onboarding-subscription-sources')
    .then((section) => section.querySelector('[data-onboarding-engine="codex_cli"]')!));
  fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));
  return screen.findByTestId('onboarding-connectors-step');
}

describe('onboarding connectors step', () => {
  it('sits between the model step and the voice-hotkey step', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await goToConnectorsStep();

    expect(screen.queryByTestId('onboarding-model-step')).toBeNull();
    expect(screen.queryByTestId('onboarding-voice-hotkey-step')).toBeNull();
    // 漏斗两步在这时候都算已完成
    expect(screen.getByTestId('onboarding-step-source').textContent).toContain('✓');
    expect(screen.getByTestId('onboarding-step-model').textContent).toContain('✓');

    fireEvent.click(screen.getByTestId('onboarding-connectors-next'));
    await screen.findByTestId('onboarding-voice-hotkey-step');
    expect(screen.queryByTestId('onboarding-connectors-step')).toBeNull();
  });

  it('lists the commonly used existing connectors with i18n copy', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await goToConnectorsStep();

    expect(screen.getByText(text.connectorsTitle)).toBeTruthy();
    expect(screen.getByText(text.connectorsDescription)).toBeTruthy();
    for (const id of ['feishu', 'google-calendar', 'mail', 'calendar', 'reminders']) {
      expect(document.querySelector(`[data-onboarding-connector="${id}"]`)).toBeTruthy();
    }
    expect(screen.getByText(text.connectorRows.feishu.name)).toBeTruthy();
    expect(screen.getByText(text.connectorRows.mail.name)).toBeTruthy();
  });

  it('records the connect intent without deep-linking while the modal is up, then fires once after finishing', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToConnectorsStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-feishu'));
    // 返工 10-12 契约：modal 开着时一次深链都不能发（早发会被遮罩挡住，
    // 且 App 侧 onComplete 收尾的 setShowSettings(false) 会把刚开的面板关掉）
    expect(openCapabilitySettingsTarget).not.toHaveBeenCalled();
    expect(screen.getByText(interpolate(text.connectorsOpenedHint, { name: text.connectorRows.feishu.name }))).toBeTruthy();
    // 步不因点击 Connect 而离开
    expect(screen.getByTestId('onboarding-connectors-step')).toBeTruthy();

    fireEvent.click(screen.getByTestId('onboarding-connectors-next'));
    await screen.findByTestId('onboarding-voice-hotkey-step');
    expect(openCapabilitySettingsTarget).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('onboarding-voice-hotkey-skip'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(openCapabilitySettingsTarget).toHaveBeenCalledTimes(1);
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({
      kind: 'connector',
      id: 'feishu',
      source: 'onboarding',
    });
    // 深链在 onComplete 之后才发：App 侧 setShowSettings(false) 已同步跑完
    expect(openCapabilitySettingsTarget.mock.invocationCallOrder[0])
      .toBeGreaterThan(onComplete.mock.invocationCallOrder[0]);
  });

  it('local row connects inline; a ready mail needs no landing so feishu stays the target', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToConnectorsStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-feishu'));
    fireEvent.click(screen.getByTestId('onboarding-connect-mail'));
    // mail 行内授权通过：展示已连接，不再出现"稍后打开"提示
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-mail').textContent).toBe(text.connectorReadyHint);
    });
    expect(screen.getByText(interpolate(text.connectorsOpenedHint, { name: text.connectorRows.feishu.name }))).toBeTruthy();

    fireEvent.click(screen.getByTestId('onboarding-connectors-skip'));
    await screen.findByTestId('onboarding-voice-hotkey-step');
    fireEvent.click(screen.getByTestId('onboarding-voice-hotkey-skip'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    // mail 已连上无需落页，深链仍指向待办的 feishu
    expect(openCapabilitySettingsTarget).toHaveBeenCalledTimes(1);
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({
      kind: 'connector',
      id: 'feishu',
      source: 'onboarding',
    });
  });

  it('a failed local connect retargets the pending deep-link to that connector', async () => {
    invokeDomain.mockImplementation((domain: string, action: string) => {
      if (action === 'repairPermission') {
        return Promise.resolve([{
          id: 'mail',
          label: 'Mail',
          connected: false,
          readiness: 'failed',
          error: 'Not authorized (-1743)',
          capabilities: [],
        }]);
      }
      return defaultInvoke(domain, action);
    });
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToConnectorsStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-feishu'));
    fireEvent.click(screen.getByTestId('onboarding-connect-mail'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-connect-result-mail').textContent)
        .toBe(interpolate(text.connectorDeniedHint, { name: text.connectorRows.mail.name }));
    });

    fireEvent.click(screen.getByTestId('onboarding-connectors-skip'));
    await screen.findByTestId('onboarding-voice-hotkey-step');
    fireEvent.click(screen.getByTestId('onboarding-voice-hotkey-skip'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    // 失败的 mail 是最新待办：深链改指向 mail（落页高亮它的卡片）
    expect(openCapabilitySettingsTarget).toHaveBeenCalledTimes(1);
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({
      kind: 'connector',
      id: 'mail',
      source: 'onboarding',
    });
  });

  it('never deep-links when finishing without any connect click', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToConnectorsStep();

    fireEvent.click(screen.getByTestId('onboarding-connectors-skip'));
    await screen.findByTestId('onboarding-voice-hotkey-step');
    fireEvent.click(screen.getByTestId('onboarding-voice-hotkey-skip'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(openCapabilitySettingsTarget).not.toHaveBeenCalled();
  });

  // 返工 r2：非 macOS 上本机连接器行不渲染——既不会触发注定 unavailable 的
  // repairPermission，也不会把深链目标改指到平台上不存在的 native 卡。
  it('on non-mac platforms the local rows are absent and the deep-link can only target SaaS', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToConnectorsStep();

    for (const id of ['mail', 'calendar', 'reminders']) {
      expect(document.querySelector(`[data-onboarding-connector="${id}"]`)).toBeNull();
    }
    fireEvent.click(screen.getByTestId('onboarding-connect-feishu'));
    fireEvent.click(screen.getByTestId('onboarding-connectors-next'));
    await screen.findByTestId('onboarding-voice-hotkey-step');
    fireEvent.click(screen.getByTestId('onboarding-voice-hotkey-skip'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(openCapabilitySettingsTarget).toHaveBeenCalledTimes(1);
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({
      kind: 'connector',
      id: 'feishu',
      source: 'onboarding',
    });
    expect(invokeDomain.mock.calls.some((call) => call[1] === 'repairPermission')).toBe(false);
  });

  it('skip and next both land on the voice step and complete exactly as before', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToConnectorsStep();

    fireEvent.click(screen.getByTestId('onboarding-connectors-skip'));
    await screen.findByTestId('onboarding-voice-hotkey-step');
    fireEvent.click(screen.getByTestId('onboarding-voice-hotkey-skip'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('completes through the connectors next path as well', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToConnectorsStep();

    fireEvent.click(screen.getByTestId('onboarding-connectors-next'));
    await screen.findByTestId('onboarding-voice-hotkey-step');
    fireEvent.click(screen.getByTestId('onboarding-voice-hotkey-skip'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('goes back to the model step, and the voice step goes back to connectors', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await goToConnectorsStep();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await screen.findByTestId('onboarding-model-step');
    expect(screen.queryByTestId('onboarding-connectors-step')).toBeNull();

    fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));
    await screen.findByTestId('onboarding-connectors-step');
    fireEvent.click(screen.getByTestId('onboarding-connectors-next'));
    await screen.findByTestId('onboarding-voice-hotkey-step');

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await screen.findByTestId('onboarding-connectors-step');
    expect(screen.queryByTestId('onboarding-voice-hotkey-step')).toBeNull();
  });
});
