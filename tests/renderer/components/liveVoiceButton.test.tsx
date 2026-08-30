// @vitest-environment jsdom
//
// LiveVoiceButton 入口门（B1）：可见性（总开关 && idle 相位）、空会话直接开、
// 有消息会话先确认；缺 key（enabled && !configured）降级成可点引导态——
// 按钮在、可点、点击不拨号，而是弹引导层跳设置（2026-07-30，降级提示不消失）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEECH_INPUT_SETTINGS } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import type { UseVoiceInputReturn } from '../../../src/renderer/hooks/useVoiceInput';

const bridgeMock = vi.hoisted(() => ({ dial: vi.fn() }));
const appStoreMock = vi.hoisted(() => ({ openSettingsTab: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/voiceCallBridge', () => ({
  voiceCallBridge: bridgeMock,
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ openSettingsTab: appStoreMock.openSettingsTab }),
}));

import { LiveVoiceButton, type LiveVoiceButtonProps } from '../../../src/renderer/components/features/voice/LiveVoiceButton';
import { resolveComposerCoreActions } from '../../../src/renderer/components/features/chat/ChatInput';
import { ComposerCoreActions } from '../../../src/renderer/components/features/chat/ChatInput/ComposerCoreActions';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';

const IDLE_VOICE = {
  status: 'idle',
  duration: 0,
  isSupported: true,
  isEnabled: true,
  settings: DEFAULT_SPEECH_INPUT_SETTINGS,
  start: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
  retry: vi.fn(),
  canRetry: false,
  clearError: vi.fn(),
  error: null,
  errorCode: null,
  lastResult: null,
  inputLevel: 0,
  partialText: '',
  silenceWarning: false,
} as UseVoiceInputReturn;

function renderButton(props: Partial<LiveVoiceButtonProps> = {}) {
  return render(
    <LiveVoiceButton sessionId="s1" hasMessages={false} configured {...props} />,
  );
}

describe('LiveVoiceButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': true, 'builtin.voice-input': true },
    });
  });
  afterEach(() => {
    cleanup();
    useVoiceCallStore.getState().reset();
  });

  it('故障注入：调度已给 live-voice、占位组件读到非 idle 快照时主位也不能为空', () => {
    const actions = resolveComposerCoreActions({
      hasContent: false,
      isProcessing: false,
      sessionId: 's1',
      enabled: true,
      configured: true,
      phase: 'idle',
      hasMessages: false,
      hadLiveVoice: false,
    });
    expect(actions).toEqual(['voice-input', 'live-voice']);

    // 稳定注入父子两次 store 订阅之间的快照错位：父层按 idle 完成调度后，
    // LiveVoiceButton 再读到 connecting。修复前它会 return null，主位整格为空。
    useVoiceCallStore.getState().dialStarted('s1', undefined, 'server_vad');
    const { container } = render(
      <>
        {actions.includes('live-voice') && (
          <LiveVoiceButton sessionId="s1" hasMessages={false} configured />
        )}
      </>,
    );

    expect(container.querySelector('[data-testid="live-voice-button"]')).not.toBeNull();
  });

  it('渲染层门：完整状态组合下核心操作区恒有恰好 2 个可见按钮', async () => {
    const phases = ['idle', 'connecting', 'live', 'error'] as const;
    const availabilityStates = [
      { enabled: false, configured: false },
      { enabled: false, configured: true },
      { enabled: true, configured: false },
      { enabled: true, configured: true },
    ];
    const booleans = [false, true];

    // 覆盖边界：这条门走生产 resolveComposerCoreActions + 生产 JSX 消费点 +
    // 三个真实按钮组件，能抓「动作表有两项、占位组件却 return null」的缝。
    // 它不声称覆盖：语音转文字能力被用户关闭、CSS 像素级遮挡、VoiceChrome 层叠、
    // Tauri 原生挂断时序。后两项必须由独立 headless / real-runtime 证据补齐。
    for (const phase of phases) {
      for (const availability of availabilityStates) {
        for (const hasContent of booleans) {
          for (const isProcessing of booleans) {
            for (const hasStoppableBackgroundWork of booleans) {
              const state = {
                hasContent,
                isProcessing,
                sessionId: 's1',
                phase,
                hasMessages: false,
                hadLiveVoice: false,
                hasStoppableBackgroundWork,
                ...availability,
              };
              const label = JSON.stringify(state);
              const actions = resolveComposerCoreActions(state);
              const { container, unmount } = render(
                <ComposerCoreActions
                  actions={actions}
                  voice={IDLE_VOICE}
                  sessionId="s1"
                  hasMessages={false}
                  configured={availability.configured}
                  isProcessing={isProcessing}
                  hasContent={hasContent}
                />,
              );
              const core = container.querySelector('[data-testid="composer-core-actions"]');

              // marker 丢失或扫描到 0 个目标会直接报红，避免门的测量范围静默失效。
              expect(core, label).not.toBeNull();
              await waitFor(() => {
                expect(within(core as HTMLElement).getAllByRole('button'), label).toHaveLength(2);
              });
              unmount();
            }
          }
        }
      }
    }
  });

  it('缺 key（enabled && !configured）：降级成可点引导态，不消失、不拨号', () => {
    renderButton({ configured: false });

    const button = screen.getByTestId('live-voice-button-unconfigured');
    // 正常拨号按钮不出现，但引导按钮在原位置
    expect(screen.queryByTestId('live-voice-button')).toBeNull();

    fireEvent.click(button);
    expect(bridgeMock.dial).not.toHaveBeenCalled();
    // 引导层弹出：文案 + 「去配置」
    expect(screen.getByText(zh.voice.live.noKeyTitle)).toBeTruthy();

    fireEvent.click(screen.getByText(zh.voice.live.noKeyAction));
    expect(bridgeMock.dial).not.toHaveBeenCalled();
    expect(appStoreMock.openSettingsTab).toHaveBeenCalledWith('voiceModel');
  });

  it('空会话点击直接拨号', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('live-voice-button'));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
  });

  it('有消息会话先弹确认，确认后才拨号', () => {
    renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    expect(bridgeMock.dial).not.toHaveBeenCalled();
    expect(screen.getByText(zh.voice.live.confirmMessage)).toBeTruthy();

    fireEvent.click(screen.getByText(zh.voice.live.confirmAction));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
  });

  it('确认框取消不拨号', () => {
    renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    fireEvent.click(screen.getByText(zh.common.cancel));
    expect(bridgeMock.dial).not.toHaveBeenCalled();
  });

  it('勾选「不再提示」并确认后：写 localStorage，之后拨号直接进通话不再弹框（现象 1）', () => {
    window.localStorage.removeItem('code-agent:voice-start-dialog-dismissed');

    const { unmount } = renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    fireEvent.click(screen.getByLabelText(zh.voice.live.dontShowAgain));
    fireEvent.click(screen.getByText(zh.voice.live.confirmAction));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
    expect(window.localStorage.getItem('code-agent:voice-start-dialog-dismissed')).toBe('1');
    unmount();

    // 第二次拨号：不弹确认框，直接 dial
    bridgeMock.dial.mockClear();
    renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
    expect(screen.queryByText(zh.voice.live.confirmMessage)).toBeNull();

    window.localStorage.removeItem('code-agent:voice-start-dialog-dismissed');
  });

  it('不勾选「不再提示」：确认后照常拨号但不写 localStorage', () => {
    window.localStorage.removeItem('code-agent:voice-start-dialog-dismissed');
    renderButton({ hasMessages: true });
    fireEvent.click(screen.getByTestId('live-voice-button'));
    fireEvent.click(screen.getByText(zh.voice.live.confirmAction));
    expect(bridgeMock.dial).toHaveBeenCalledWith('s1');
    expect(window.localStorage.getItem('code-agent:voice-start-dialog-dismissed')).toBeNull();
  });

  // ChatInput 在「正在建会话」那段窗口把 disabled 传下来，靠的就是这条：
  // 按钮留在原位置灰，不是消失。它一消失底栏就少一格、旁边全部横移
  // ——2026-07-27 真机「切到新会话时按钮闪变」的其中一半就是这么来的。
  it('disabled 时置灰留在原位，不是整个消失', () => {
    renderButton({ disabled: true });
    const button = screen.getByTestId('live-voice-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).toContain('cursor-not-allowed');

    fireEvent.click(button);
    expect(bridgeMock.dial).not.toHaveBeenCalled();
  });
});
