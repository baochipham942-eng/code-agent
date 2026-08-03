// @vitest-environment jsdom
// 「进行中」层行为门：voice > upload，断言真实 DOM 互斥。
// 2026-08-02 起 surface-execution 退出这一层——composer 上方那条常驻状态条已删，
// 因为对话流里的 SurfaceExecutionCompactBar 报的是同一件事且更具体（操作到哪一步）。
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/voiceCallBridge', () => ({
  voiceCallBridge: { hangUp: vi.fn(), toggleMute: vi.fn(), manualTap: vi.fn() },
}));
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector: (state: { entries: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ entries: [{ id: 'lanxi', name: '岚析' }] }),
}));
vi.mock('../../../src/renderer/components/features/expert/SessionMemberBar', () => ({
  useSessionMembers: () => [],
}));

import { ComposerUploadStatus } from '../../../src/renderer/components/features/chat/ChatInput/ComposerUploadStatus';
import { VoiceChrome } from '../../../src/renderer/components/features/voice/VoiceChrome';
import { useComposerNoticeStore } from '../../../src/renderer/stores/composerNoticeStore';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

describe('Composer 进行中层互斥', () => {
  beforeEach(() => {
    useComposerNoticeStore.setState({ notices: {}, inProgress: {} });
    useVoiceCallStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useComposerNoticeStore.setState({ notices: {}, inProgress: {} });
    useVoiceCallStore.getState().reset();
  });

  it('只有上传在跑时显示上传', async () => {
    render(<ComposerUploadStatus active />);
    await waitFor(() => expect(screen.queryByTestId('composer-upload-status')).not.toBeNull());
  });

  it('通话在跑时上传不渲染；通话结束后上传自己恢复', async () => {
    render(
      <>
        <ComposerUploadStatus active />
        <VoiceChrome sessionId="conversation-a" />
      </>,
    );

    await waitFor(() => expect(screen.queryByTestId('composer-upload-status')).not.toBeNull());

    act(() => {
      useVoiceCallStore.getState().dialStarted('conversation-a', 'lanxi', 'server_vad');
      useVoiceCallStore.getState().phaseChanged('live');
    });
    await waitFor(() => expect(screen.queryByTestId('voice-chrome')).not.toBeNull());
    expect(screen.queryByTestId('composer-upload-status')).toBeNull();

    act(() => useVoiceCallStore.getState().reset());
    await waitFor(() => expect(screen.queryByTestId('composer-upload-status')).not.toBeNull());
    expect(screen.queryByTestId('voice-chrome')).toBeNull();
  });
});
