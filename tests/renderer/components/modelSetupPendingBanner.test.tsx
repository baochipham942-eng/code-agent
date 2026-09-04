// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  invokeDomain: (...args: unknown[]) => invokeDomain(...args),
}));

import { ModelSetupPendingBanner } from '../../../src/renderer/components/onboarding/ModelSetupPendingBanner';

afterEach(() => {
  cleanup();
  invokeDomain.mockReset();
});

// N-FIRSTRUN-SKIP：「跳过」后落主界面，提示条只提示不遮挡；设置页关掉时复查一次，接好了才自己撤。
describe('ModelSetupPendingBanner', () => {
  it('renders as a non-blocking status bar with connect / dismiss actions', async () => {
    invokeDomain.mockResolvedValue(false);
    const onOpenSettings = vi.fn();
    const onDismiss = vi.fn();
    const onConfigured = vi.fn();
    render(
      <ModelSetupPendingBanner
        settingsOpen={false}
        onOpenSettings={onOpenSettings}
        onDismiss={onDismiss}
        onConfigured={onConfigured}
      />,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '去接入' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith('domain:settings', 'checkApiKeyConfigured'));
    expect(onConfigured).not.toHaveBeenCalled();
  });

  it('re-checks when settings closes and retires itself once a model is connected', async () => {
    invokeDomain.mockResolvedValue(false);
    const onConfigured = vi.fn();
    const { rerender } = render(
      <ModelSetupPendingBanner settingsOpen={false} onOpenSettings={() => {}} onDismiss={() => {}} onConfigured={onConfigured} />,
    );
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledTimes(1));

    rerender(
      <ModelSetupPendingBanner settingsOpen onOpenSettings={() => {}} onDismiss={() => {}} onConfigured={onConfigured} />,
    );
    expect(invokeDomain).toHaveBeenCalledTimes(1); // 设置页开着不查

    invokeDomain.mockResolvedValue(true);
    rerender(
      <ModelSetupPendingBanner settingsOpen={false} onOpenSettings={() => {}} onDismiss={() => {}} onConfigured={onConfigured} />,
    );
    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1));
  });
});
