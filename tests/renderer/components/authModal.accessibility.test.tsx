// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: () => ({
    signInWithEmail: vi.fn(),
    signUpWithEmail: vi.fn(),
    resetPassword: vi.fn(),
    isLoading: false,
    error: null,
    showAuthModal: true,
    setShowAuthModal: vi.fn(),
    setError: vi.fn(),
  }),
}));

import { AuthModal } from '../../../src/renderer/components/AuthModal';

describe('AuthModal accessibility', () => {
  it('exposes the login dialog with its title as the accessible name', () => {
    render(<AuthModal />);
    expect(screen.getByRole('dialog', { name: '登录' })).toBeTruthy();
  });
});
