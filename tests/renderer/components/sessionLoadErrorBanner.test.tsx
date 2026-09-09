// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLoadErrorBanner } from '../../../src/renderer/components/features/chat/SessionLoadErrorBanner';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { zh } from '../../../src/renderer/i18n';
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
afterEach(cleanup);
describe('session load error with explicit saved-history reading', () => {
  it('uses only the ownership-checked getMessages endpoint and retains the execution error', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, data: [{ id: 'old', role: 'user', content: 'Saved request', timestamp: 1 }] });
    window.domainAPI = { invoke } as unknown as Window['domainAPI'];
    useSessionStore.setState({ currentSessionId: 's', error: 'OWNER_MISMATCH', messages: [] });
    const view = render(<SessionLoadErrorBanner />);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(view.getByText('查看已保存记录'));
    await waitFor(() => expect(useSessionStore.getState().messages).toHaveLength(1));
    expect(invoke).toHaveBeenCalledExactlyOnceWith('domain:session', 'getMessages', { sessionId: 's' });
    expect(useSessionStore.getState().error).toBe('OWNER_MISMATCH');
  });
  it('does not read another source when the host denies access', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: false, error: { message: 'Access denied' } });
    window.domainAPI = { invoke } as unknown as Window['domainAPI'];
    useSessionStore.setState({ currentSessionId: 's', error: 'load failed', messages: [] });
    const view = render(<SessionLoadErrorBanner />);
    fireEvent.click(view.getByText('查看已保存记录'));
    await waitFor(() => expect(view.container.textContent).toContain('Access denied'));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().error).toBe('load failed');
  });
});
