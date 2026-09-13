// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngineSourceDescriptor } from '../../../src/shared/contract/agentEngine';
import type { AppSettings } from '../../../src/shared/contract';
import { onboardingZh } from '../../../src/renderer/i18n/onboarding';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';

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
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
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

const text = onboardingZh.onboarding;

async function goToVoiceStep() {
  fireEvent.click(await screen.findByTestId('onboarding-subscription-sources')
    .then((section) => section.querySelector('[data-onboarding-engine="codex_cli"]')!));
  fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));
  return screen.findByTestId('onboarding-voice-hotkey-step');
}

function settingsSetCalls() {
  return invokeDomain.mock.calls.filter((call) => call[1] === 'set') as Array<[
    string,
    string,
    Partial<AppSettings>,
  ]>;
}

describe('onboarding speak-anytime hotkey card', () => {
  beforeEach(() => {
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
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    });
  });

  afterEach(() => {
    cleanup();
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    });
  });

  it('shows the follow-up card after the model step and lets the user skip without binding', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToVoiceStep();

    expect(screen.getByText(text.voiceHotkeyTitle)).toBeTruthy();
    expect(screen.getByText(text.voiceHotkeyUnavailableDescription)).toBeTruthy();
    expect(screen.queryByTestId('onboarding-voice-hotkey-bind')).toBeNull();

    fireEvent.click(screen.getByTestId('onboarding-voice-hotkey-skip'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(settingsSetCalls().some(([, , payload]) => payload.keybindings)).toBe(false);
  });

  it('blocks a colliding shortcut and does not persist it', async () => {
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': true, 'builtin.voice-input': false },
    });
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToVoiceStep();

    fireEvent.click(await screen.findByTestId('onboarding-voice-hotkey-bind'));
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true, shiftKey: true });

    const message = await screen.findByTestId('onboarding-voice-hotkey-message');
    expect(message.textContent).toContain('冲突');
    expect(message.className).toContain('text-badge-danger');
    expect(onComplete).not.toHaveBeenCalled();
    expect(settingsSetCalls().some(([, , payload]) => payload.keybindings)).toBe(false);
  });

  it('blocks a system-reserved shortcut with a readable reason', async () => {
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': true, 'builtin.voice-input': false },
    });
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await goToVoiceStep();

    fireEvent.click(await screen.findByTestId('onboarding-voice-hotkey-bind'));
    fireEvent.keyDown(window, { key: 'Tab', altKey: true });

    const message = await screen.findByTestId('onboarding-voice-hotkey-message');
    expect(message.textContent).toContain('系统占用');
    expect(settingsSetCalls().some(([, , payload]) => payload.keybindings)).toBe(false);
  });

  it('persists a free shortcut through the existing keybindings settings path and finishes', async () => {
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': true, 'builtin.voice-input': false },
    });
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await goToVoiceStep();

    fireEvent.click(await screen.findByTestId('onboarding-voice-hotkey-bind'));
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const keybindingSave = settingsSetCalls().find(([, , payload]) => payload.keybindings);
    expect(keybindingSave?.[2].keybindings?.bindings['voice.callToggle']).toEqual({
      enabled: true,
      accelerator: 'Ctrl+Shift+V',
    });
  });
});
