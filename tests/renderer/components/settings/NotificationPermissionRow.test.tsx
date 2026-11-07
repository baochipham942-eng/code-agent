// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getOsNotificationPermission = vi.hoisted(() => vi.fn());
const getOsNotificationPermissionSnapshot = vi.hoisted(() => vi.fn());
const openNativeDesktopSystemSettings = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/renderer/utils/osNotification', () => ({
  getOsNotificationPermission,
  getOsNotificationPermissionSnapshot,
}));
vi.mock('../../../../src/renderer/services/nativeDesktop', () => ({ openNativeDesktopSystemSettings }));

import { NotificationPermissionRow } from '../../../../src/renderer/components/features/settings/tabs/NotificationPermissionRow';
import { useAppStore } from '../../../../src/renderer/stores/appStore';

function permissionSnapshot(permission: 'granted' | 'denied' | 'unknown', platform: string | null = 'macos') {
  return { permission, platform };
}

beforeEach(() => {
  useAppStore.setState({ language: 'en' });
  getOsNotificationPermission.mockResolvedValue('unknown');
  getOsNotificationPermissionSnapshot.mockResolvedValue(permissionSnapshot('unknown'));
  openNativeDesktopSystemSettings.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotificationPermissionRow', () => {
  it('shows Off in macOS and opens notification settings when denied', async () => {
    getOsNotificationPermissionSnapshot.mockResolvedValue(permissionSnapshot('denied'));
    render(<NotificationPermissionRow />);

    expect(await screen.findByText('Off in macOS')).toBeTruthy();
    expect(screen.getByText('Task-finished and failure alerts will not pop up.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open system settings' }));
    expect(openNativeDesktopSystemSettings).toHaveBeenCalledWith('notifications');
  });

  it('shows Cannot confirm and opens notification settings when unknown', async () => {
    render(<NotificationPermissionRow />);

    expect(await screen.findByText('Cannot confirm')).toBeTruthy();
    expect(screen.getByText('Neo cannot read the macOS setting; check System Settings.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open system settings' }));
    expect(openNativeDesktopSystemSettings).toHaveBeenCalledWith('notifications');
  });

  it('shows On without a settings button when granted', async () => {
    getOsNotificationPermissionSnapshot.mockResolvedValue(permissionSnapshot('granted'));
    render(<NotificationPermissionRow />);

    expect(await screen.findByText('On')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open system settings' })).toBeNull();
  });

  it('re-reads permission when the window regains focus', async () => {
    getOsNotificationPermissionSnapshot
      .mockResolvedValueOnce(permissionSnapshot('granted'))
      .mockResolvedValueOnce(permissionSnapshot('denied'));
    render(<NotificationPermissionRow />);
    await screen.findByText('On');

    fireEvent.focus(window);

    expect(await screen.findByText('Off in macOS')).toBeTruthy();
    expect(getOsNotificationPermissionSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each(['windows', null])('renders nothing when the native platform is %s', async (platform) => {
    getOsNotificationPermissionSnapshot.mockResolvedValue(permissionSnapshot('unknown', platform));
    const { container } = render(<NotificationPermissionRow />);

    await waitFor(() => expect(getOsNotificationPermissionSnapshot).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(openNativeDesktopSystemSettings).not.toHaveBeenCalled();
  });

  it('handles a rejected system-settings invocation without an unhandled rejection', async () => {
    openNativeDesktopSystemSettings.mockRejectedValue(new Error('settings unavailable'));
    render(<NotificationPermissionRow />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open system settings' }));

    expect((await screen.findByRole('alert')).textContent)
      .toBe('Unable to open System Settings. Open Notifications manually.');
  });
});
