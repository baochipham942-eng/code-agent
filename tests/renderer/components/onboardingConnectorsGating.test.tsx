// @vitest-environment jsdom
// N-ONBOARD-CONNECTOR-STEP：既有首启 gating 不因新连接器步改变——
// 模型已配置（checkApiKeyConfigured=true）时 onboarding modal（含连接器步）整个不出现。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/utils/platform', () => ({
  isDesktopShellMode: () => false,
  isTauriMode: () => false,
  isWebMode: () => true,
}));

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const authState = {
  isAuthenticated: true,
  user: null,
  isLoading: false,
  error: null,
  sessionTrustState: 'trusted',
  authBackendAvailable: true,
  hasCachedAdminClaim: false,
  syncStatus: 'idle',
  showAuthModal: false,
  showPasswordResetModal: false,
  passwordResetTokens: null,
  setAuthInitialMode: vi.fn(),
  setShowAuthModal: vi.fn(),
};
vi.mock('../../../src/renderer/stores/authStore', () => {
  const useAuthStore = (selector?: (state: typeof authState) => unknown) =>
    selector ? selector(authState) : authState;
  (useAuthStore as unknown as { getState: () => typeof authState }).getState = () => authState;
  (useAuthStore as unknown as { setState: (patch: Partial<typeof authState>) => void }).setState = () => {};
  return {
    useAuthStore,
    initializeAuthStore: vi.fn(() => Promise.resolve()),
  };
});

const invokeDomain = vi.fn();
const invokeChannel = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => {
  const noop = vi.fn();
  const instance = {
    invoke: (...args: unknown[]) => invokeChannel(...args),
    unsafeInvoke: vi.fn(() => Promise.resolve(undefined)),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: noop,
    off: noop,
    getPathForFile: noop,
    extractPdfText: vi.fn(() => Promise.resolve(undefined)),
    extractExcelText: vi.fn(() => Promise.resolve(undefined)),
    extractExcelJson: vi.fn(() => Promise.resolve(undefined)),
    extractDocxHtml: vi.fn(() => Promise.resolve(undefined)),
    transcribeSpeech: vi.fn(() => Promise.resolve(undefined)),
    isAvailable: () => true,
  };
  return {
    default: instance,
    invokeDomain: instance.invokeDomain,
    invoke: instance.invoke,
    unsafeInvoke: instance.unsafeInvoke,
    on: noop,
    off: noop,
    isAvailable: instance.isAvailable,
    ipcService: instance,
  };
});

import { App } from '../../../src/renderer/App';

beforeEach(() => {
  invokeDomain.mockReset();
  invokeChannel.mockReset();
  invokeChannel.mockResolvedValue(undefined);
  authState.setAuthInitialMode.mockReset();
  authState.setShowAuthModal.mockReset();
});

afterEach(cleanup);

function stubApiKeyConfigured(configured: boolean) {
  // 未知的 domain action 一律 reject，与真实 ipcService 在 jsdom（无 bridge）下的行为一致：
  // resolve undefined 会让调用方的 .then(data => data.x) 走进成功分支然后崩树。
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'checkApiKeyConfigured') return Promise.resolve(configured);
    if (action === 'get') return Promise.resolve({});
    return Promise.reject(new Error(`no bridge for ${_domain}:${action}`));
  });
}

async function waitForOnboardingCheck() {
  await waitFor(
    () => expect(invokeDomain).toHaveBeenCalledWith(
      'domain:settings',
      'checkApiKeyConfigured',
      undefined,
    ),
    { timeout: 6_000, interval: 100 },
  );
  // 检查 resolve 后 state 更新在同一微任务链上落盘，留一小段缓冲再下断言
  await new Promise((resolve) => setTimeout(resolve, 400));
}

describe('first-run onboarding gating', () => {
  it('never opens the onboarding modal (connectors step included) when a model is already configured', async () => {
    stubApiKeyConfigured(true);
    render(<App />);

    await waitForOnboardingCheck();
    expect(screen.queryByTestId('onboarding-stepper')).toBeNull();
    expect(screen.queryByTestId('onboarding-connectors-step')).toBeNull();
  });

  it('still opens for a fresh user without a model, proving the gate assertion above bites', async () => {
    stubApiKeyConfigured(false);
    render(<App />);

    await waitFor(() => expect(screen.getByTestId('onboarding-stepper')).toBeTruthy(), {
      timeout: 8_000,
      interval: 150,
    });
  });
});
