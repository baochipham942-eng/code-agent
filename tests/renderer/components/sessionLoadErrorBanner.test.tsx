// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLoadErrorBanner } from '../../../src/renderer/components/features/chat/SessionLoadErrorBanner';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { zh } from '../../../src/renderer/i18n';
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
afterEach(cleanup);
describe('session load error with automatic saved-history reading', () => {
  it('uses only the ownership-checked getMessages endpoint and retains the execution error', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, data: [{ id: 'old', role: 'user', content: 'Saved request', timestamp: 1 }] });
    window.domainAPI = { invoke } as unknown as Window['domainAPI'];
    useSessionStore.setState({ currentSessionId: 's', error: 'OWNER_MISMATCH', messages: [] });
    const view = render(<SessionLoadErrorBanner />);
    await waitFor(() => expect(useSessionStore.getState().messages).toHaveLength(1));
    expect(invoke).toHaveBeenCalledExactlyOnceWith('domain:session', 'getMessages', { sessionId: 's' });
    expect(useSessionStore.getState().error).toBe('OWNER_MISMATCH');
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByText(zh.deliveryExperience.savedHistoryOpened)).toBeTruthy();
    expect(view.container.querySelector('details')?.open).toBe(false);
  });
  it('does not read another source when the host denies access', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: false, error: { message: 'Access denied' } });
    window.domainAPI = { invoke } as unknown as Window['domainAPI'];
    useSessionStore.setState({ currentSessionId: 's', error: 'load failed', messages: [] });
    const view = render(<SessionLoadErrorBanner />);
    await waitFor(() => expect(view.container.textContent).toContain('Access denied'));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().error).toBe('load failed');
  });
  it('discards a saved-history response after switching away', async () => {
    let resolve: (value: unknown) => void = () => {};
    const invoke = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
    window.domainAPI = { invoke } as unknown as Window['domainAPI'];
    useSessionStore.setState({ currentSessionId: 'old', error: 'load failed', messages: [] });
    const view = render(<SessionLoadErrorBanner />);
    view.unmount();
    useSessionStore.setState({ currentSessionId: 'new', error: null, messages: [] });
    resolve({ success: true, data: [{ id: 'private', role: 'user', content: 'Old history', timestamp: 1 }] });
    await Promise.resolve();
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().error).toBeNull();
  });
});
