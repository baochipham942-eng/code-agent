// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  requestComposerFocus: vi.fn(),
  setSelectedConnectorIds: vi.fn(),
  setSelectedMcpServerIds: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { createSession: typeof mocks.createSession }) => unknown) => selector({
    createSession: mocks.createSession,
  }),
}));

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector: (state: {
    setSelectedConnectorIds: typeof mocks.setSelectedConnectorIds;
    setSelectedMcpServerIds: typeof mocks.setSelectedMcpServerIds;
  }) => unknown) => selector({
    setSelectedConnectorIds: mocks.setSelectedConnectorIds,
    setSelectedMcpServerIds: mocks.setSelectedMcpServerIds,
  }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: { requestComposerFocus: typeof mocks.requestComposerFocus }) => unknown) => selector({
    requestComposerFocus: mocks.requestComposerFocus,
  }),
}));

import { useConnectorInChat } from '../../../src/renderer/hooks/useConnectorInChat';

describe('useConnectorInChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue({ id: 'new-session' });
  });

  it('creates a new chat before selecting a SaaS connector in the destination composer scope', async () => {
    const { result } = renderHook(() => useConnectorInChat());

    await act(() => result.current({ kind: 'connector', id: 'tmeet' }));

    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.createSession).toHaveBeenCalledWith('新对话', { workingDirectory: null });
    expect(mocks.setSelectedConnectorIds).toHaveBeenCalledOnce();
    expect(mocks.setSelectedConnectorIds).toHaveBeenCalledWith(['tmeet']);
    expect(mocks.setSelectedMcpServerIds).not.toHaveBeenCalled();
    expect(mocks.requestComposerFocus).toHaveBeenCalledOnce();
    expect(mocks.createSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setSelectedConnectorIds.mock.invocationCallOrder[0],
    );
    expect(mocks.setSelectedConnectorIds.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestComposerFocus.mock.invocationCallOrder[0],
    );
  });

  it('routes MCP servers to the MCP selection setter', async () => {
    const { result } = renderHook(() => useConnectorInChat());

    await act(() => result.current({ kind: 'mcp', id: 'tencent-docs' }));

    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.setSelectedMcpServerIds).toHaveBeenCalledOnce();
    expect(mocks.setSelectedMcpServerIds).toHaveBeenCalledWith(['tencent-docs']);
    expect(mocks.setSelectedConnectorIds).not.toHaveBeenCalled();
    expect(mocks.requestComposerFocus).toHaveBeenCalledOnce();
  });

  it('does not mutate or focus the composer when session creation fails', async () => {
    mocks.createSession.mockResolvedValue(null);
    const { result } = renderHook(() => useConnectorInChat());

    await act(() => result.current({ kind: 'connector', id: 'feishu' }));

    expect(mocks.setSelectedConnectorIds).not.toHaveBeenCalled();
    expect(mocks.setSelectedMcpServerIds).not.toHaveBeenCalled();
    expect(mocks.requestComposerFocus).not.toHaveBeenCalled();
  });
});
