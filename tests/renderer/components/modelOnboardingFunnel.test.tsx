// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngineSourceDescriptor } from '../../../src/shared/contract/agentEngine';

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
    manifestId: 'native',
    kind: 'native',
    label: 'Neo',
    summary: 'Native',
    detected: true,
    selectable: true,
    authState: 'authenticated',
    modelSelection: 'neo_provider',
    iconAsset: '/code-agent/agent-neo-mark.svg',
    evidence: 'production',
    credentialOwner: 'neo',
    auditNotes: [],
  },
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
  {
    manifestId: 'codebuddy_code',
    kind: 'codebuddy_code',
    label: 'WorkBuddy',
    summary: 'Recommendation',
    detected: false,
    selectable: false,
    authState: 'not_checked',
    modelSelection: 'runtime_catalog',
    recommendation: { label: '推荐安装', reason: '复用 WorkBuddy / CodeBuddy 账号' },
    evidence: 'production',
    credentialOwner: 'official_client',
    auditNotes: [],
  },
  {
    manifestId: 'grok_cli',
    kind: 'grok_cli',
    label: 'Grok Build',
    summary: 'Official Grok CLI',
    detected: true,
    selectable: true,
    authState: 'authenticated',
    version: 'grok 0.2.114',
    modelSelection: 'runtime_catalog',
    evidence: 'production',
    credentialOwner: 'official_client',
    auditNotes: [],
  },
  {
    manifestId: 'qoder_work',
    label: 'Qoder Work',
    summary: 'Detected local spike',
    detected: true,
    selectable: false,
    authState: 'needs_login',
    version: '1.0.47',
    modelSelection: 'unavailable',
    recommendation: { label: '需要登录', reason: '登录后继续验证' },
    evidence: 'local_spike',
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
  invokeDomain.mockImplementation((_domain: string, action: string, payload?: unknown) => {
    if (action === 'listSources') return Promise.resolve(sources);
    if (action === 'listModels') {
      return Promise.resolve({
        catalog: {
          version: 'fixture',
          updatedAt: '2026-07-30T00:00:00.000Z',
          engines: [{
            kind: 'codex_cli',
            defaultModel: 'gpt-5.5',
            models: [
              { id: 'gpt-5.5', label: 'GPT-5.5', capabilities: ['code'], recommended: true },
              { id: 'gpt-5.4', label: 'GPT-5.4', capabilities: ['code'] },
            ],
          }, {
            kind: 'grok_cli',
            defaultModel: 'grok-4.5',
            models: [
              { id: 'grok-4.5', label: 'Grok 4.5', capabilities: ['code', 'reasoning'], recommended: true },
            ],
          }],
        },
        source: 'local_discovery',
        diagnostics: [],
      });
    }
    if (action === 'test_connection') return Promise.resolve({ success: true, latencyMs: 12 });
    if (action === 'discover_models') {
      return Promise.resolve({
        success: true,
        latencyMs: 8,
        models: [{ id: 'claude-sonnet-4', label: 'Claude Sonnet 4' }],
      });
    }
    if (action === 'set') return Promise.resolve(undefined);
    throw new Error(`Unexpected action: ${action} ${JSON.stringify(payload)}`);
  });
});

afterEach(cleanup);

describe('two-step onboarding', () => {
  it('contains only source and default-model steps', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await screen.findByTestId('onboarding-subscription-sources');

    expect(screen.getByTestId('onboarding-step-source').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('onboarding-step-model')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-step-connectors')).toBeNull();
    expect(screen.queryByTestId('onboarding-done')).toBeNull();
    expect(screen.queryByText('Neo')).toBeNull();
    expect(screen.getByTestId('onboarding-route-subscription').getAttribute('role')).toBe('tab');
    expect(screen.getByTestId('onboarding-route-subscription').getAttribute('aria-selected')).toBe('true');
  });

  it('selects a detected official client by clicking the whole card and enters chat directly', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    fireEvent.click(await screen.findByTestId('onboarding-subscription-sources')
      .then((section) => section.querySelector('[data-onboarding-engine="codex_cli"]')!));

    expect(screen.getByTestId('onboarding-step-model').getAttribute('data-active')).toBe('true');
    expect(screen.getByText('GPT-5.5')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));

    await waitFor(() => expect(updateSessionEngine).toHaveBeenCalledWith('session-1', expect.objectContaining({
      kind: 'codex_cli',
      model: 'gpt-5.5',
      permissionProfile: 'read_only',
    })));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('onboarding-done')).toBeNull();
  });

  it('selects detected Grok Build with its discovered model', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    fireEvent.click(await screen.findByTestId('onboarding-subscription-sources')
      .then((section) => section.querySelector('[data-onboarding-engine="grok_cli"]')!));

    expect(screen.getByText('Grok 4.5')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));

    await waitFor(() => expect(updateSessionEngine).toHaveBeenCalledWith('session-1', expect.objectContaining({
      kind: 'grok_cli',
      model: 'grok-4.5',
      permissionProfile: 'read_only',
    })));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('completes a quick conversation without bypassing the external workspace gate', async () => {
    sessionState.sessions[0].workingDirectory = undefined;
    appState.workingDirectory = undefined;
    const onComplete = vi.fn();

    render(<ModelOnboardingModal onComplete={onComplete} />);
    fireEvent.click(await screen.findByTestId('onboarding-subscription-sources')
      .then((section) => section.querySelector('[data-onboarding-engine="codex_cli"]')!));
    fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(updateSessionEngine).not.toHaveBeenCalled();

  });

  it('shows missing recommendations without making them selectable', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await screen.findByText('WorkBuddy');
    const card = document.querySelector('[data-onboarding-recommendation="codebuddy_code"]');

    expect(card).toBeTruthy();
    expect(card?.querySelector('button')).toBeNull();
    expect(card?.textContent).toContain('Adapter 已开放');
    expect(card?.textContent).toContain('未安装');
  });

  it('shows a detected Qoder Work CLI as login-gated without making it selectable', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await screen.findByText('Qoder Work');
    const card = document.querySelector('[data-onboarding-engine-status="qoder_work"]');

    expect(card).toBeTruthy();
    expect(card?.querySelector('button')).toBeNull();
    expect(card?.textContent).toContain('CLI 未登录');
    expect(card?.textContent).toContain('生产 Adapter 未开放');
    expect(card?.textContent).toContain('需登录');
  });

  it('offers Anthropic-compatible API and forwards the claude protocol to probing and saving', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('onboarding-route-api'));
    expect(screen.getByTestId('onboarding-route-api').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByText('Anthropic 兼容接口'));
    expect(screen.getByRole('heading', { name: 'Anthropic 兼容接口' })).toBeTruthy();
    expect(screen.getAllByText(/Anthropic Messages/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/OpenAI 兼容中转站/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('https://example.com/v1'), {
      target: { value: 'https://anthropic-gateway.example/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText(text.apiKeyPlaceholder), {
      target: { value: 'sk-test' },
    });
    fireEvent.click(screen.getByText('验证并选择模型'));

    await screen.findByText('Claude Sonnet 4');
    expect(invokeDomain).toHaveBeenCalledWith(
      expect.any(String),
      'test_connection',
      expect.objectContaining({ provider: 'custom', protocol: 'claude' }),
    );
    fireEvent.click(screen.getByTestId('onboarding-continue-to-chat'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom',
      model: 'claude-sonnet-4',
      protocol: 'claude',
    })));
  });
});
