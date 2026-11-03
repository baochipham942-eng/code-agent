// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getOsNotificationPermission = vi.hoisted(() => vi.fn());
const openNativeDesktopSystemSettings = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/renderer/utils/osNotification', () => ({ getOsNotificationPermission }));
vi.mock('../../../../src/renderer/services/nativeDesktop', () => ({ openNativeDesktopSystemSettings }));

import { NotificationPermissionRow } from '../../../../src/renderer/components/features/settings/tabs/NotificationPermissionRow';
import { useAppStore } from '../../../../src/renderer/stores/appStore';

beforeEach(() => {
  useAppStore.setState({ language: 'en' });
  getOsNotificationPermission.mockResolvedValue('unknown');
  openNativeDesktopSystemSettings.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotificationPermissionRow', () => {
  it('shows Off in macOS and opens notification settings when denied', async () => {
    getOsNotificationPermission.mockResolvedValue('denied');
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
    getOsNotificationPermission.mockResolvedValue('granted');
    render(<NotificationPermissionRow />);

    expect(await screen.findByText('On')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open system settings' })).toBeNull();
  });

  it('re-reads permission when the window regains focus', async () => {
    getOsNotificationPermission.mockResolvedValueOnce('granted').mockResolvedValueOnce('denied');
    render(<NotificationPermissionRow />);
    await screen.findByText('On');

    fireEvent.focus(window);

    expect(await screen.findByText('Off in macOS')).toBeTruthy();
    expect(getOsNotificationPermission).toHaveBeenCalledTimes(2);
  });
});
