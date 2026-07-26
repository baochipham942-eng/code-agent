// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../src/renderer/components/features/evalCenter/EvalReplayExplorer', () => ({
  EvalReplayExplorer: () => <div data-testid="eval-replay-explorer-mock" />,
}));
vi.mock('../../../src/renderer/components/features/inAppValidation/InAppValidationWorkspace', () => ({
  InAppValidationWorkspace: () => <div data-testid="in-app-validation-workspace-mock" />,
}));
vi.mock('../../../src/renderer/components/features/evalCenter/EvalTelemetryTab', () => ({
  EvalTelemetryTab: () => <div data-testid="eval-telemetry-tab-mock" />,
}));
vi.mock('../../../src/renderer/components/features/evalCenter/EvalBenchmarksTab', () => ({
  EvalBenchmarksTab: () => <div data-testid="eval-benchmarks-tab-mock" />,
}));

import { EvalCenterPage } from '../../../src/renderer/components/features/evalCenter/EvalCenterPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const user = (isAdmin: boolean) => ({ id: 'u1', email: 'u@example.com', isAdmin });

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
  useAppStore.setState({
    showEvalCenter: false,
    evalCenterTab: 'replay',
    pendingInAppValidationRequest: null,
  });
});

describe('EvalCenterPage', () => {
  it('渲染回放 / 验证 / 遥测 / 基准四个 tab，默认回放', async () => {
    useAuthStore.setState({ user: user(true) });
    render(<EvalCenterPage />);

    expect(screen.getByTestId('eval-center-tab-replay')).toBeTruthy();
    expect(screen.getByTestId('eval-center-tab-validation')).toBeTruthy();
    expect(screen.getByTestId('eval-center-tab-telemetry')).toBeTruthy();
    expect(screen.getByTestId('eval-center-tab-benchmarks')).toBeTruthy();
    expect(await screen.findByTestId('eval-replay-explorer-mock')).toBeTruthy();
  });

  it('非 admin 只见门禁提示，不渲染 tab', () => {
    useAuthStore.setState({ user: user(false) });
    render(<EvalCenterPage />);

    expect(screen.queryByTestId('eval-center-tab-replay')).toBeNull();
    expect(screen.getByText('评测中心仅管理员可用。')).toBeTruthy();
  });

  it('切到验证 tab 渲染验证工作台', async () => {
    useAuthStore.setState({ user: user(true) });
    render(<EvalCenterPage />);

    fireEvent.click(screen.getByTestId('eval-center-tab-validation'));

    expect(useAppStore.getState().evalCenterTab).toBe('validation');
    expect(await screen.findByTestId('in-app-validation-workspace-mock')).toBeTruthy();
  });

  it('切到遥测 / 基准 tab 渲染对应内容', async () => {
    useAuthStore.setState({ user: user(true) });
    render(<EvalCenterPage />);

    fireEvent.click(screen.getByTestId('eval-center-tab-telemetry'));
    expect(useAppStore.getState().evalCenterTab).toBe('telemetry');
    expect(await screen.findByTestId('eval-telemetry-tab-mock')).toBeTruthy();

    fireEvent.click(screen.getByTestId('eval-center-tab-benchmarks'));
    expect(useAppStore.getState().evalCenterTab).toBe('benchmarks');
    expect(await screen.findByTestId('eval-benchmarks-tab-mock')).toBeTruthy();
  });

  it('有 pending 验证请求且用户停在别的 tab 时显示角标，切入后消失', async () => {
    useAuthStore.setState({ user: user(true) });
    useAppStore.setState({
      pendingInAppValidationRequest: { requestId: 'r1', html: '<html/>', steps: [], timeoutMs: 1000 },
    });
    render(<EvalCenterPage />);

    expect(screen.getByTestId('eval-center-validation-badge')).toBeTruthy();

    fireEvent.click(screen.getByTestId('eval-center-tab-validation'));
    expect(screen.queryByTestId('eval-center-validation-badge')).toBeNull();
  });
});
