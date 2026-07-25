// @vitest-environment jsdom
// ============================================================================
// onboarding 三步漏斗：模型 → 连上日常工具 → 开始干活（C1）
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerStateSummary } from '../../../src/renderer/hooks/useMcpServerStates';

let mockMcpServerStates: MCPServerStateSummary[] = [];
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => mockMcpServerStates,
}));

const setShowCronCenter = vi.fn();
const openSettingsTab = vi.fn();
// useI18n 也从 appStore 取语言，无参调用要拿到整份 state
const appState = {
  setShowCronCenter,
  openSettingsTab,
  language: 'zh' as const,
  setLanguage: vi.fn(),
  cloudUIStrings: null,
};
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: unknown) => unknown) => (selector ? selector(appState) : appState),
}));

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args) },
}));

import { ModelOnboardingModal } from '../../../src/renderer/components/onboarding/ModelOnboardingModal';

function connected(name: string): MCPServerStateSummary {
  return { status: 'connected', config: { name } } as unknown as MCPServerStateSummary;
}

/** 走完第一步：填 key → 测试并保存 → 落到步② */
async function completeModelStep(): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText('粘贴该 Provider 的 API Key'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('测试并保存'));
  await waitFor(() => expect(screen.getByTestId('onboarding-connectors')).toBeTruthy());
}

beforeEach(() => {
  mockMcpServerStates = [];
  setShowCronCenter.mockClear();
  openSettingsTab.mockClear();
  invokeDomain.mockReset();
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'test_connection') return Promise.resolve({ success: true, latencyMs: 12 });
    if (action === 'discover_models') return Promise.resolve({ success: true, models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }], latencyMs: 8 });
    return Promise.resolve({});
  });
});

afterEach(cleanup);

describe('三步漏斗', () => {
  it('保存模型后不直接关闭，而是走到「连上你的日常工具」', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);

    expect(screen.getByTestId('onboarding-step-model').getAttribute('data-active')).toBe('true');
    await completeModelStep();

    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-step-connectors').getAttribute('data-active')).toBe('true');
  });

  it('步②按真实连接状态渲染：连上的显示已连接，没连的给出连接入口', async () => {
    mockMcpServerStates = [connected('lark')];
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await completeModelStep();

    expect(screen.getByTestId('onboarding-connector-lark').getAttribute('data-connected')).toBe('true');
    expect(screen.getByTestId('onboarding-connector-notion').getAttribute('data-connected')).toBe('false');

    // 未连接的走现状授权流：跳能力中心，不在 onboarding 里另造一套授权
    fireEvent.click(screen.getByTestId('onboarding-connector-notion').querySelector('button')!);
    expect(openSettingsTab).toHaveBeenCalledWith('mcp');
  });

  it('步②可以先不连，直接到完成页', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} />);
    await completeModelStep();

    fireEvent.click(screen.getByTestId('onboarding-connectors-skip'));
    expect(screen.getByTestId('onboarding-done')).toBeTruthy();
  });

  it('完成页「开始工作」交回模型配置并关闭，不开自动化面板', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await completeModelStep();
    fireEvent.click(screen.getByTestId('onboarding-connectors-next'));

    fireEvent.click(screen.getByTestId('onboarding-cta-start'));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(setShowCronCenter).not.toHaveBeenCalled();
  });

  it('完成页「建你的第一个自动化」同时关弹窗并打开自动化面板', async () => {
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} />);
    await completeModelStep();
    fireEvent.click(screen.getByTestId('onboarding-connectors-next'));

    fireEvent.click(screen.getByTestId('onboarding-cta-automation'));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(setShowCronCenter).toHaveBeenCalledWith(true);
  });
});

describe('跳过分支', () => {
  it('第一步跳过走老路径（去设置页），不进后面两步', () => {
    const onSkip = vi.fn();
    const onComplete = vi.fn();
    render(<ModelOnboardingModal onComplete={onComplete} onSkip={onSkip} />);

    fireEvent.click(screen.getByText('跳过，稍后在设置里配置'));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.queryByTestId('onboarding-connectors')).toBeNull();
  });

  it('进入步②后不再出现第一步的跳过按钮（避免把人退回起点）', async () => {
    render(<ModelOnboardingModal onComplete={vi.fn()} onSkip={vi.fn()} />);
    await completeModelStep();

    expect(screen.queryByText('跳过，稍后在设置里配置')).toBeNull();
  });
});
