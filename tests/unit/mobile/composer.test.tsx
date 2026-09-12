// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from '../../../packages/mobile/src/features/sessions/Composer';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');

function mount(overrides: {
  start?: () => Promise<void>;
  stop?: () => Promise<{ audioData: string; mimeType: string; durationMs: number }>;
  transcribe?: (audio: { audioData: string; mimeType: string; durationMs: number }) => Promise<void>;
  draft?: string;
  offline?: boolean;
  modelLabel?: string | null;
  voiceOutcome?: 'done' | 'error' | null;
  attach?: (() => void) | undefined;
  recorder?: boolean;
} = {}) {
  const recorder = {
    start: overrides.start ?? (async () => {}),
    stop: overrides.stop ?? (async () => ({ audioData: 'YXVkaW8=', mimeType: 'audio/aac', durationMs: 1000 })),
  };
  const transcribe = vi.fn(overrides.transcribe ?? (async () => {}));
  const send = vi.fn();
  const openModel = vi.fn();
  const onVoiceState = vi.fn();
  render(<Composer text={text} draft={overrides.draft ?? ''} editDraft={() => {}} offline={overrides.offline ?? false}
    sendDisabled={!(overrides.draft ?? '').trim()} send={send}
    modelLabel={overrides.modelLabel === undefined ? 'DeepSeek V4.1 Flash' : overrides.modelLabel} openModel={openModel}
    attach={'attach' in overrides ? overrides.attach : () => {}} attachDisabled={false}
    recorder={overrides.recorder === false ? undefined : recorder} transcribe={transcribe}
    voiceDisabled={false} voicePending={false} voiceOutcome={overrides.voiceOutcome ?? null} onVoiceState={onVoiceState} />);
  return { transcribe, send, openModel, onVoiceState };
}

const clickMic = () => fireEvent.click(screen.getByRole('button', { name: text.voice }));
const toolbarButtons = () => [...document.querySelectorAll('.composer-tools button')]
  .map(button => button.getAttribute('aria-label') ?? button.className);

describe('Composer 布局契约（design.html composer()）', () => {
  afterEach(cleanup);

  it('工具行是左簇 [添加材料][模型] + 弹性空隙 + 右簇 [麦克风][发送]', () => {
    mount();
    expect(toolbarButtons()).toEqual([text.attach, `${text.model} · DeepSeek V4.1 Flash`, text.voice, text.send]);
    // 空隙必须在模型与麦克风之间——没有它就退回 build 23 那种四按钮均分整行。
    const spacer = document.querySelector('.composer-tools .spacer');
    expect(spacer?.previousElementSibling?.className).toContain('model');
    expect(spacer?.nextElementSibling?.getAttribute('aria-label')).toBe(text.voice);
  });

  it('没有会话模型时不显示模型胶囊，也不拿别的模型冒充', () => {
    mount({ modelLabel: null });
    expect(document.querySelector('.composer-tools .model')).toBeNull();
    expect(toolbarButtons()).toEqual([text.attach, text.voice, text.send]);
  });

  it('未连接电脑时占位文案改成先写下来', () => {
    mount({ offline: true });
    expect(screen.getByTestId('draft').getAttribute('placeholder')).toBe(text.offlinePlaceholder);
  });

  it('转写回填后提示可以改完再发，且不自动发送', () => {
    const { send } = mount({ draft: '帮我整理一下这三家的品牌资料', voiceOutcome: 'done' });
    expect(screen.getByText(text.voiceReviewHint)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('草稿为空时不显示转写提示', () => {
    mount({ draft: '', voiceOutcome: 'done' });
    expect(screen.queryByText(text.voiceReviewHint)).toBeNull();
  });

  it('录音中整块输入框换成语音面板：来源、计时、居中停止键，输入框与工具行不在场', async () => {
    const { onVoiceState } = mount({ draft: '已经写了一半' });
    clickMic();
    await screen.findByRole('button', { name: text.stopRecording });
    expect(screen.getByText(text.voiceSource)).toBeTruthy();
    expect(screen.getByText(text.voiceListening)).toBeTruthy();
    expect(screen.getByText('00:00')).toBeTruthy();
    expect(document.querySelectorAll('.waveform i').length).toBe(38);
    // 识别文字区显示的就是最终会留在输入框里的那段草稿
    expect(document.querySelector('.transcription')?.textContent).toContain('已经写了一半');
    expect(screen.queryByTestId('draft')).toBeNull();
    expect(document.querySelector('.composer-tools')).toBeNull();
    expect(document.querySelector('.composer')?.className).toContain('voice-composer');
    // 录音态要上报给 MobileRoot——右滑打开会话列表在录音时必须失效（design.md §5 手势表）
    expect(onVoiceState).toHaveBeenLastCalledWith({ recording: true, failed: false });
  });
});

describe('VoiceCapture failure reporting', () => {
  afterEach(cleanup);

  it('surfaces the real startRecording error code in the recording-stage copy', async () => {
    mount({ start: async () => { throw new Error('ALREADY_RECORDING'); } });
    clickMic();
    await waitFor(() => expect(screen.getByText(`${text.voiceRecordFailed} · ALREADY_RECORDING`)).toBeTruthy());
    // 录音阶段的失败绝不能显示成转写阶段的文案
    expect(screen.queryByText(new RegExp(text.voiceTranscribeFailed))).toBeNull();
  });

  it('reports a non-Error rejection instead of dropping it', async () => {
    mount({ start: async () => { throw 'PLUGIN_NOT_INITIALIZED'; } });
    clickMic();
    await waitFor(() => expect(screen.getByText(`${text.voiceRecordFailed} · PLUGIN_NOT_INITIALIZED`)).toBeTruthy());
  });

  it('keeps the dedicated permission copy without an error code', async () => {
    mount({ start: async () => { throw new Error('MICROPHONE_DENIED'); } });
    clickMic();
    await waitFor(() => expect(screen.getByText(text.microphoneDenied)).toBeTruthy());
  });

  it('separates a transcription failure from a recording failure', async () => {
    mount({ transcribe: async () => { throw new Error('COMPANION_CHANNEL_CLOSED'); } });
    clickMic();
    fireEvent.click(await screen.findByRole('button', { name: text.stopRecording }));
    await waitFor(() => expect(screen.getByText(`${text.voiceTranscribeFailed} · COMPANION_CHANNEL_CLOSED`)).toBeTruthy());
    expect(screen.queryByText(new RegExp(text.voiceRecordFailed))).toBeNull();
  });

  it('stays quiet when a discarded recording fails to stop', async () => {
    // 切后台时原生侧会自己停录并删音频，之后这次 stop 抛 RECORDING_HAS_NOT_STARTED——
    // 录音本来就不要了，不该弹错误卡
    mount({ stop: async () => { throw new Error('RECORDING_HAS_NOT_STARTED'); } });
    clickMic();
    fireEvent.click(await screen.findByRole('button', { name: text.cancelRecording }));
    await waitFor(() => expect(screen.getByRole('button', { name: text.voice })).toBeTruthy());
    expect(screen.queryByText(new RegExp(text.voiceRecordFailed))).toBeNull();
    expect(screen.queryByText(new RegExp('RECORDING_HAS_NOT_STARTED'))).toBeNull();
  });

  it('records a retry failure instead of swallowing it', async () => {
    let attempt = 0;
    mount({ transcribe: async () => { attempt += 1; throw new Error(attempt === 1 ? 'FIRST' : 'RETRY_FAILED'); } });
    clickMic();
    fireEvent.click(await screen.findByRole('button', { name: text.stopRecording }));
    fireEvent.click(await screen.findByRole('button', { name: text.retry }));
    await waitFor(() => expect(screen.getByText(`${text.voiceTranscribeFailed} · RETRY_FAILED`)).toBeTruthy());
  });

  it('失败落在输入区上方，输入框留给用户继续改字', async () => {
    mount({ draft: '重点看一下它们的定位和', start: async () => { throw new Error('MICROPHONE_DENIED'); } });
    clickMic();
    await screen.findByText(text.microphoneDenied);
    expect(screen.getByTestId('draft')).toBeTruthy();
    expect(document.querySelector('.composer')?.className).not.toContain('voice-composer');
    expect(document.querySelector('.voice-notice')?.compareDocumentPosition(document.querySelector('.composer')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('输入区与连接状态的口径一致', () => {
  afterEach(cleanup);

  it('转写失败在不在场要如实上报——通用提示条据此决定让不让位', async () => {
    const { onVoiceState } = mount({ start: async () => { throw new Error('MICROPHONE_DENIED'); } });
    clickMic();
    await screen.findByText(text.microphoneDenied);
    expect(onVoiceState).toHaveBeenLastCalledWith({ recording: false, failed: true });
  });
});
