// @vitest-environment jsdom
// 「进行中」层行为门：voice > surface-execution > upload，断言真实 DOM 互斥。
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { surfaceSession } from './surfaceExecution/fixtures';
import { surfaceExecutionScopeKeyV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';

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
import { SurfaceExecutionComposerStatus } from '../../../src/renderer/components/features/surfaceExecution/SurfaceExecutionRunStatus';
import { VoiceChrome } from '../../../src/renderer/components/features/voice/VoiceChrome';
import { useComposerNoticeStore } from '../../../src/renderer/stores/composerNoticeStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

function startSurfaceExecution(): void {
  const session = surfaceSession({
    id: 'surface-live',
    conversationId: 'conversation-a',
    state: 'running',
  });
  useSurfaceExecutionStore.setState({
    sessionsByScope: { [surfaceExecutionScopeKeyV1(session.scope)]: session },
  });
}

describe('Composer 进行中层互斥', () => {
  beforeEach(() => {
    useComposerNoticeStore.setState({ notices: {}, inProgress: {} });
    useSurfaceExecutionStore.getState().reset();
    useVoiceCallStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useComposerNoticeStore.setState({ notices: {}, inProgress: {} });
    useSurfaceExecutionStore.getState().reset();
    useVoiceCallStore.getState().reset();
  });

  it('Surface 与上传同时在跑时只显示 Surface', async () => {
    startSurfaceExecution();
    render(
      <>
        <ComposerUploadStatus active />
        <SurfaceExecutionComposerStatus conversationId="conversation-a" />
      </>,
    );

    await waitFor(() => expect(screen.queryByTestId('surface-execution-composer-status')).not.toBeNull());
    expect(screen.queryByTestId('composer-upload-status')).toBeNull();
  });

  it('通话在跑时 Surface 与上传都不渲染；通话结束后 Surface 自己恢复', async () => {
    startSurfaceExecution();
    render(
      <>
        <ComposerUploadStatus active />
        <SurfaceExecutionComposerStatus conversationId="conversation-a" />
        <VoiceChrome sessionId="conversation-a" />
      </>,
    );

    await waitFor(() => expect(screen.queryByTestId('surface-execution-composer-status')).not.toBeNull());

    act(() => {
      useVoiceCallStore.getState().dialStarted('conversation-a', 'lanxi', 'server_vad');
      useVoiceCallStore.getState().phaseChanged('live');
    });
    await waitFor(() => expect(screen.queryByTestId('voice-chrome')).not.toBeNull());
    expect(screen.queryByTestId('surface-execution-composer-status')).toBeNull();
    expect(screen.queryByTestId('composer-upload-status')).toBeNull();

    act(() => useVoiceCallStore.getState().reset());
    await waitFor(() => expect(screen.queryByTestId('surface-execution-composer-status')).not.toBeNull());
    expect(screen.queryByTestId('voice-chrome')).toBeNull();
    expect(screen.queryByTestId('composer-upload-status')).toBeNull();
  });
});
