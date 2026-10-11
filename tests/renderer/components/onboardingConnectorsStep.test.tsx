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

const text = onboardingZh.onboarding;

beforeEach(() => {
  appState.workingDirectory = '/workspace';
  sessionState.sessions[0].workingDirectory = '/workspace';
  updateSessionEngine.mockReset();
  updateSessionEngine.mockResolvedValue(undefined);
  invokeDomain.mockReset();
  invokeDomain.mockImplementation((_domain: string, action: string) => {
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
    throw new Error(`Unexpected action: ${action}`);
  });
  openCapabilitySettingsTarget.mockReset();
});

afterEach(cleanup);

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

  it('reuses the existing capability-hub connect entry with the connector id', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await goToConnectorsStep();

    fireEvent.click(screen.getByTestId('onboarding-connect-feishu'));
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({ kind: 'connector', id: 'feishu' });
    fireEvent.click(screen.getByTestId('onboarding-connect-mail'));
    expect(openCapabilitySettingsTarget).toHaveBeenCalledWith({ kind: 'connector', id: 'mail' });
    // 步不因点击 Connect 而离开
    expect(screen.getByTestId('onboarding-connectors-step')).toBeTruthy();
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
