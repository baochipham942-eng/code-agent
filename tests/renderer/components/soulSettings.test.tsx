// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn(async (_domain: string, action: string) => {
  if (action === 'getStatus') return { source: 'builtin', length: 0 };
  if (action === 'getProfile') return { content: '', filePath: '/tmp/SOUL.md' };
  if (action === 'getDefault') return { content: 'Default persona' };
  return {};
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (domain: string, action: string) => invokeDomain(domain, action) },
}));

import { SoulSettings } from '../../../src/renderer/components/features/settings/tabs/SoulSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const user = (isAdmin: boolean) => ({ id: 'u1', email: 'u@example.com', isAdmin });

afterEach(() => {
  cleanup();
  invokeDomain.mockClear();
  useAuthStore.setState({ user: null });
  useAppStore.setState({ showPromptManager: false });
});

describe('SoulSettings prompt manager entry', () => {
  it('opens prompt management from persona settings for admins', async () => {
    useAuthStore.setState({ user: user(true) });
    render(<SoulSettings />);

    const button = await screen.findByTestId('settings-soul-open-prompts');
    fireEvent.click(button);

    expect(useAppStore.getState().showPromptManager).toBe(true);
  });

  it('keeps the admin-only prompt manager hidden from regular users', async () => {
    useAuthStore.setState({ user: user(false) });
    render(<SoulSettings />);

    await waitFor(() => expect(screen.getByDisplayValue('Default persona')).toBeTruthy());
    expect(screen.queryByTestId('settings-soul-open-prompts')).toBeNull();
  });
});
