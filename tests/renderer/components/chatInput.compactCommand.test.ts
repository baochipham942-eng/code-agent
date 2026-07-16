// @vitest-environment jsdom

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const compactCommandMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: compactCommandMocks.invoke,
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: compactCommandMocks.toast,
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      agentCommand: {
        notFoundPrefix: 'unknown agent ',
        restoredAuto: 'restored',
        switchedToPrefix: 'switched ',
      },
    },
  }),
}));

import {
  parseCompactCommand,
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '/compact 保留大纲',
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: 'session-1',
    isProcessing: false,
    disabled: false,
    isUploading: false,
    onSend: vi.fn(),
    agentEntries: [],
    buildEnvelope: vi.fn(),
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: { current: { focus: vi.fn() } } as React.RefObject<any>,
    setValue: vi.fn(),
    setAttachments: vi.fn(),
    setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(),
    closeGoalConfirm: vi.fn(),
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
}

describe('/compact command submit handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    compactCommandMocks.invoke.mockResolvedValue({ success: true });
  });

  it('parses only the compact slash command and optional focus text', () => {
    expect(parseCompactCommand('/compact')).toEqual({});
    expect(parseCompactCommand('/compact 文字')).toEqual({ focusText: '文字' });
    expect(parseCompactCommand('/compact   ')).toEqual({});
    expect(parseCompactCommand('/compactx')).toBeNull();
  });

  it('submits /compact through compact IPC without sending a chat message', async () => {
    const onSend = vi.fn();
    const addToInputHistory = vi.fn();
    const setValue = vi.fn();
    const params = makeParams({ onSend, addToInputHistory, setValue });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any);
    });

    expect(compactCommandMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.CONTEXT_COMPACT_CURRENT,
      'session-1',
      '保留大纲',
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(addToInputHistory).toHaveBeenCalledWith('/compact 保留大纲');
    expect(setValue).toHaveBeenCalledWith('');
  });
});
