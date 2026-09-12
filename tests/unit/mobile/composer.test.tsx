// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from '../../../packages/mobile/src/features/sessions/Composer';
import type { VoiceResult } from '../../../packages/mobile/src/stores/companionStore';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');

function mount(overrides: {
  start?: () => Promise<void>;
  stop?: () => Promise<{ audioData: string; mimeType: string; durationMs: number }>;
  transcribe?: (audio: { audioData: string; mimeType: string; durationMs: number }) => Promise<string | null>;
  draft?: string;
  offline?: boolean;
  modelLabel?: string | null;
  attach?: (() => void) | undefined;
  recorder?: boolean;
} = {}) {
  const recorder = {
    start: overrides.start ?? (async () => {}),
    stop: overrides.stop ?? (async () => ({ audioData: 'YXVkaW8=', mimeType: 'audio/aac', durationMs: 1000 })),
  };
  const transcribe = vi.fn(overrides.transcribe ?? (async () => 'cmd-1'));
  const discardPendingTranscript = vi.fn();
  const send = vi.fn();
  const openModel = vi.fn();
  const onVoiceState = vi.fn();
  render(<Composer text={text} draft={overrides.draft ?? ''} editDraft={() => {}} offline={overrides.offline ?? false}
    sendDisabled={!(overrides.draft ?? '').trim()} send={send}
    modelLabel={overrides.modelLabel === undefined ? 'DeepSeek V4.1 Flash' : overrides.modelLabel} openModel={openModel}
    attach={'attach' in overrides ? overrides.attach : () => {}} attachDisabled={false}
    recorder={overrides.recorder === false ? undefined : recorder} transcribe={transcribe} discardPendingTranscript={discardPendingTranscript}
    voiceDisabled={false} voicePending={false} voiceResult={null} voiceReady onVoiceState={onVoiceState} />);
  return { transcribe, send, openModel, onVoiceState, discardPendingTranscript };
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

  it('转写回填后提示可以改完再发，且不自动发送', async () => {
    vi.useFakeTimers();
    render(<ChunkHarness sent={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(5_000);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(1_000);
    expect(screen.getByText(text.voiceReviewHint)).toBeTruthy();
    // 草稿被清掉（发出去了）之后提示自然收起
    fireEvent.change(screen.getByTestId('draft'), { target: { value: '' } });
    expect(screen.queryByText(text.voiceReviewHint)).toBeNull();
    vi.useRealTimers();
  });

  it('上一次录音成文不该留给下一次：重录后取消，提示不许还挂在那儿', async () => {
    // 提示以前读的是 store 里那个粘着的 voiceOutcome==='done'，它跨录音、跨会话都不清，
    // 于是下一次录音取消之后、甚至换一个会话之后，只要草稿非空就照样说「已转成文字」。
    vi.useFakeTimers();
    render(<ChunkHarness sent={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(5_000);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(1_000);
    expect(screen.getByText(text.voiceReviewHint)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(1_000);
    fireEvent.click(screen.getByRole('button', { name: text.cancelRecording }));
    await advance(500);
    expect((screen.getByTestId('draft') as HTMLTextAreaElement).value).toContain('段1');
    expect(screen.queryByText(text.voiceReviewHint)).toBeNull();
    vi.useRealTimers();
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

// ——— 分片伪流式（N-VOICE-CHUNKED-STREAM）———
// 这个 Harness 照搬 companionStore 的真实时序：transcribe 进了待确认槽就回 commandId、
// pending=true，主机结算后才 pending=false + 一条**认 commandId** 的 result。
// 协议一次只允许一条在飞，所以队列必须串行。
function ChunkHarness({ sent, verdict = () => 'done' as const, refuseFirst = false, refuseAll = false, ackDelay = 10, ready = true, onStart, stopDelay = 0, sendDelay = 0 }: {
  sent: (audioData: string, continuation: boolean, take?: string) => void; verdict?: (seq: number) => 'done' | 'error';
  refuseFirst?: boolean; refuseAll?: boolean; ackDelay?: number; ready?: boolean; onStart?: () => void;
  /** recorder.stop() 的耗时（真机切口 ~0.32s）。 */
  stopDelay?: number;
  /** 命令进待确认槽的耗时——取消正落在这个 await 里，就是 grok 第七轮那条 Important 的窗口。 */
  sendDelay?: number;
}) {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<VoiceResult | null>(null);
  const [draft, setDraft] = React.useState('');
  const seq = React.useRef(0);
  const refused = React.useRef(false);
  /** 照搬 companionStore 的取消语义：被取消的那**次录音**，晚到结果一律不写进草稿。 */
  const discarded = React.useRef<string | null>(null);
  // 录音口必须是稳定引用（生产里是 ports.recorder 单例）：每渲染换一个新对象会让
  // useVoiceCapture 的清理副作用把正在录的这次当作「录音口换了」收掉。
  const recorder = React.useRef({
    start: async () => { onStart?.(); },
    stop: async () => { if (stopDelay) await new Promise(resolve => setTimeout(resolve, stopDelay)); return { audioData: `chunk${seq.current + 1}`, mimeType: 'audio/aac', durationMs: 4000 }; },
  }).current;
  const transcribe = async (audio: { audioData: string }, continuation: boolean, take: string) => {
    sent(audio.audioData, continuation, take);
    if (refuseAll) return null;
    if (refuseFirst && !refused.current) { refused.current = true; return null; }
    const n = ++seq.current;
    const commandId = `cmd-${n}`;
    setPending(true);
    if (sendDelay) await new Promise(resolve => setTimeout(resolve, sendDelay));
    const settle = () => {
      const outcome = verdict(n);
      if (outcome === 'done' && discarded.current !== take) setDraft(previous => previous + `段${n}`);
      setResult({ commandId, outcome }); setPending(false);
    };
    // ackDelay=0 走真机常态那条路：deliver 当场就把 ack 带回来，结果比 commandId 还早进 store，
    // 队列这时还没把 awaiting 挂上——认 commandId 的结算必须照样领得到。
    if (ackDelay) setTimeout(settle, ackDelay); else settle();
    return commandId;
  };
  return <Composer text={text} draft={draft} editDraft={setDraft} offline={false} sendDisabled={!draft} send={() => {}}
    modelLabel="DeepSeek V4.1 Flash" openModel={() => {}} attach={() => {}} attachDisabled={false}
    recorder={recorder} transcribe={transcribe} discardPendingTranscript={take => { discarded.current = take; }} voiceReady={ready} voiceDisabled={false} voicePending={pending}
    voiceResult={result} onVoiceState={() => {}} />;
}


// React 只在 act 退出时冲刷渲染与副作用，队列泵就活在副作用里：一次性推进 13 秒
// 只会在最后冲刷一次（实测只发出 1 段）。按小步推进才等价于真机上的时间流逝。
const advance = async (ms: number, step = 250) => {
  for (let passed = 0; passed < ms; passed += step) {
    await act(async () => { await vi.advanceTimersByTimeAsync(step); });
  }
};

describe('分片伪流式语音输入', () => {
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('说话期间每个分片就传一段，草稿逐段追加，不用等松手', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(0);
    // 三个分片的时长过去：还没点停止，字就应该已经在草稿里了
    await advance(13_000);
    expect(sent.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector('.transcription')?.textContent).toContain('段1');
    expect(document.querySelector('.transcription')?.textContent).toContain('段2');
    // 第一段另起一行，后续分片接着上一段写
    expect(sent.mock.calls[0][1]).toBe(false);
    expect(sent.mock.calls[1][1]).toBe(true);
    // 录音还在继续：停止键还在
    expect(screen.getByRole('button', { name: text.stopRecording })).toBeTruthy();
  });

  it('任一分片失败只丢那一段：其余照常成文，面板标出来', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} verdict={n => (n === 2 ? 'error' : 'done')} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(13_000);
    expect(screen.getByText(text.voiceChunkDropped)).toBeTruthy();
    expect(document.querySelector('.transcription')?.textContent).toContain('段1');
    expect(document.querySelector('.transcription')?.textContent).toContain('段3');
    // 整段没有被判失败：不弹「转写未完成」
    expect(screen.queryByText(new RegExp(text.voiceTranscribeFailed))).toBeNull();
  });

  it('协议在忙时分片不丢，下一拍补发', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} refuseFirst />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(6_000);
    // 第一次被拒（没发出去），同一段必须再来一次，不能悄悄丢
    expect(sent.mock.calls.filter(([id]) => id === 'chunk1').length).toBeGreaterThanOrEqual(2);
  });

  it('点停止后收尾：最后一段传完、面板关闭、文字留在输入框', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(5_000);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(1_000);
    expect(screen.getByTestId('draft')).toBeTruthy();
    expect(document.querySelector('.composer')?.className).not.toContain('voice-composer');
    expect((screen.getByTestId('draft') as HTMLTextAreaElement).value).toContain('段1');
  });
});

// ——— grok ai-review #1764 的五条，逐条钉住 ———
describe('ai-review #1764 回归', () => {
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('Important·每段都录空时不许静悄悄关掉面板，要带真实错误码报出来', async () => {
    // 点一下麦克风就停、或插件把每段都判空：队列和 retryable 都是空的，
    // 旧写法直接 reset 回 idle，用户点了麦克风什么都没发生（相对基线 VoiceInput 是回归）。
    mount({ stop: async () => { throw new Error('EMPTY_RECORDING'); } });
    clickMic();
    fireEvent.click(await screen.findByRole('button', { name: text.stopRecording }));
    await waitFor(() => expect(screen.getByText(`${text.voiceRecordFailed} · EMPTY_RECORDING`)).toBeTruthy());
    expect(screen.getByTestId('draft')).toBeTruthy();
  });

  it('Nit·满上限自动收尾后不再显示「正在听你说」，停止键不留成死键', async () => {
    // 判据必须落在「录音已到点、队列还没排空」那段窗口里：等排空了面板本来就关了，
    // 两种写法都看不出差别（第一版测试就是这么写的，变异没转红）。
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} ackDelay={30_000} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(61_000, 1_000);
    expect(document.querySelector('.voice-composer')).toBeTruthy();
    expect(screen.queryByText(text.voiceListening)).toBeNull();
    expect(screen.queryByRole('button', { name: text.stopRecording })).toBeNull();
  });

  it('Nit·取消录音要把在飞那条的结果当晚到结果丢掉', async () => {
    const { discardPendingTranscript } = mount();
    clickMic();
    fireEvent.click(await screen.findByRole('button', { name: text.cancelRecording }));
    expect(discardPendingTranscript).toHaveBeenCalled();
  });
});

describe('ai-review #1764 第二轮 Nit', () => {
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('部分成功时末段失败也要留痕，并留出补传入口', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    // 前两段成文、第三段失败：面板关掉之后，失败那段不能静悄悄没了
    render(<ChunkHarness sent={sent} verdict={n => (n >= 3 ? 'error' : 'done')} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(13_000);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(2_000);
    expect(screen.getByText(new RegExp(text.voiceChunkDropped))).toBeTruthy();
    expect(screen.getByRole('button', { name: text.retry })).toBeTruthy();
    // 成文的那几段照常留在输入框里
    expect((screen.getByTestId('draft') as HTMLTextAreaElement).value).toContain('段1');
  });

  it('部分成功的提示不说成整次转写失败', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} verdict={n => (n >= 3 ? 'error' : 'done')} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(13_000);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(2_000);
    expect(screen.queryByText(new RegExp(text.voiceTranscribeFailed))).toBeNull();
  });
});

describe('ai-review #1764 第三轮 Important：断网不许把输入区锁死', () => {
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('录音中途连不上电脑，点停止后面板要收尾，把输入框还给用户', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    // transcribe 恒回 false = 协议此刻发不出去（断网时 companionStore 就是静默 return）
    render(<ChunkHarness sent={sent} refuseAll ready={false} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(5_000);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(2_000);
    // 输入框必须回来，而不是停在「正在转写」的面板上
    expect(screen.getByTestId('draft')).toBeTruthy();
    expect(document.querySelector('.voice-composer')).toBeNull();
    // 录下来的音频没丢：给了重试入口
    expect(screen.getByRole('button', { name: text.retry })).toBeTruthy();
  });

  it('取消键任何时候都能点——它是这块面板唯一的出口', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} refuseAll />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(5_000);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(1_000);
    const cancel = screen.getByRole('button', { name: text.cancelRecording });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cancel);
    await advance(500);
    expect(screen.getByTestId('draft')).toBeTruthy();
  });
});

describe('ai-review #1764 第五轮 Nit', () => {
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('转写失败在不在场要如实上报——通用提示条据此决定让不让位', async () => {
    const { onVoiceState } = mount({ start: async () => { throw new Error('MICROPHONE_DENIED'); } });
    clickMic();
    await screen.findByText(text.microphoneDenied);
    expect(onVoiceState).toHaveBeenLastCalledWith({ recording: false, failed: true });
  });

  it('取消后立刻再点麦克风不会开出两条录音循环', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    let starts = 0;
    render(<ChunkHarness sent={sent} onStart={() => { starts += 1; }} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(250);
    fireEvent.click(screen.getByRole('button', { name: text.cancelRecording }));
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(9_000);
    // 两条循环抢同一个 recorder 的话，同一段时间里 stop→start 的次数会翻倍
    expect(starts).toBeLessThanOrEqual(4);
    expect(document.querySelectorAll('.voice-composer').length).toBeLessThanOrEqual(1);
  });
});

describe('ai-review #1764 第六轮：录音中途取消不许再漏字', () => {
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('取消时就地清队列——不等录音循环 stop 完（真机那一步就要 ~320ms）', async () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    // 复现真实时序：主机慢（ack 9s > 段长 4s）⇒ 取消那一刻队列里确实压着后面的分片；
    // recorder.stop() 也慢（2s，真机实测切口 ~0.32s，这里放大成可观察窗口）。
    // 旧写法要等录音循环醒来才清队列，而在飞那段的 ack 恰好落在这个窗口里，
    // 泵立刻把队头发出去——取消掉的话照样进输入框。
    render(<ChunkHarness sent={sent} stopDelay={2_000} ackDelay={7_500} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(12_500);
    const before = sent.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: text.cancelRecording }));
    await advance(4_000);
    // 取消之后一段都不许再发出去
    expect(sent.mock.calls.length).toBe(before);
    expect(screen.getByTestId('draft')).toBeTruthy();
  });
});

describe('一次录音是显式对象 + 代号：所有异步续段先比代号', () => {
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('ack 比 commandId 还早回来（deliver 当场结算）也要认领得到，不许永远挂着 awaiting', async () => {
    // 真机常态：结算发生在 transcribe 内部的 deliver 里，result 进 store 时队列还没挂 awaiting。
    // 结算只盯 result 变化的话，这一拍之后 result 不再变，那段音频就永远等不到结论——面板收不了口。
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} ackDelay={0} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(9_000);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(1_000);
    expect(screen.getByTestId('draft')).toBeTruthy();
    expect(document.querySelector('.voice-composer')).toBeNull();
    expect((screen.getByTestId('draft') as HTMLTextAreaElement).value).toContain('段1');
  });

  it('取消正落在 transcribe 的 await 里：那段音频不算数，也不许被算进下一轮', async () => {
    // grok 第七轮 Important：在飞的 IIFE 在 await 返回后无条件 shift/挂 awaiting。
    // 队列/awaiting 以前是整个 hook 共用的 ref，于是上一次录音的续段会把已取消的音频
    // 挂进新一轮，重试再把它写进输入框。现在这些数据长在 take 上，续段回来先比代号。
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} sendDelay={3_000} ackDelay={1_000} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(4_500);                       // 第一段已切出来，transcribe 正卡在 await 里
    expect(sent).toHaveBeenCalledTimes(1);
    const cancelledTake = sent.mock.calls[0][2];
    fireEvent.click(screen.getByRole('button', { name: text.cancelRecording }));
    // 取消当场就把输入框还回来，不等 await 回来
    expect(screen.getByTestId('draft')).toBeTruthy();
    await advance(6_000);
    expect((screen.getByTestId('draft') as HTMLTextAreaElement).value).toBe('');

    // 紧接着再录一次：上一轮那段绝不能顶着新代号混进来
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(9_000);
    const takes = sent.mock.calls.map(call => call[2]);
    expect(takes.filter(take => take === cancelledTake).length).toBe(1);
    expect(new Set(takes).size).toBe(2);
    // 新一轮的第一段必须是「另起一行」，没有继承上一次录音的续写状态
    expect(sent.mock.calls[1][1]).toBe(false);
  });

  it('取消落在切段的 recorder.start() 里：麦克风不许留在开着的状态', async () => {
    // 切段是「停当前文件 → 立刻重开」，重开那一步在真机上是有耗时的。
    // 取消正落在这个窗口里时，录音口是**后**开出来的：谁负责关它取决于 live 什么时候置起。
    // 置在身份判断之后的话，续段一看「这次不算数了」就直接返回，麦克风谁都不认领、一直开着。
    vi.useFakeTimers();
    let open = 0;
    const recorder = {
      start: async () => { await new Promise(resolve => setTimeout(resolve, 1_000)); open += 1; },
      stop: async () => { open -= 1; return { audioData: 'chunk', mimeType: 'audio/aac', durationMs: 4000 }; },
    };
    render(<Composer text={text} draft="" editDraft={() => {}} offline={false} sendDisabled send={() => {}}
      modelLabel="DeepSeek V4.1 Flash" openModel={() => {}} attach={() => {}} attachDisabled={false}
      recorder={recorder} transcribe={async () => 'cmd-1'} discardPendingTranscript={() => {}}
      voiceReady voiceDisabled={false} voicePending={false} voiceResult={null} onVoiceState={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(1_500);
    expect(open).toBe(1);
    // 第一段在 5s 切出来（停），第二次 start 要到 6s 才 resolve——取消打在这中间
    await advance(4_000);
    expect(open).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: text.cancelRecording }));
    await advance(3_000);
    expect(open).toBe(0);
  });

  it('停止按在切段的 recorder.stop() 里：这一次录音当场收尾，不再多录一整段', async () => {
    // 切段那 ~320ms 里录音口已经在停了、t.live 是 false，界面上却还是「正在听你说」，
    // 用户按停止就落在这个窗口。循环若只认进循环前那一眼的 stopping，这次停止要等满
    // 下一整段（4s）才生效——用户看到的是「按了没反应」。
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} stopDelay={2_000} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(5_000);   // 第一段 4s 切出来，recorder.stop() 要到 6s 才回
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(2_000);
    expect(screen.getByTestId('draft')).toBeTruthy();
    expect(document.querySelector('.voice-composer')).toBeNull();
  });

  it('结算必须认 commandId：上一段的结论不许替下一段签字', async () => {
    // 结果在 store 里是留着的——下一段的 ack 还没回来时，读到的就是上一段那条。
    // 不认 commandId 的话，第二段刚挂上 awaiting 就被上一段的 'done' 当场结算掉；
    // 它真正的 'error' 回来时已经没人接，失败既不留痕、也没有补传入口。
    vi.useFakeTimers();
    const sent = vi.fn();
    render(<ChunkHarness sent={sent} ackDelay={1_000} verdict={n => (n >= 2 ? 'error' : 'done')} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(10_000);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(3_000);
    expect(screen.getByText(new RegExp(text.voiceChunkDropped))).toBeTruthy();
    // 成文的第一段照常留在输入框里
    expect((screen.getByTestId('draft') as HTMLTextAreaElement).value).toContain('段1');
    // 判据落在「进重试队列的是几段」上：只看有没有失败提示是区分不开的——
    // 晚签一段的写法同样会报失败，只是报的是别人的失败，而失败的那段被顶成了成功。
    const before = sent.mock.calls.length;
    expect(before).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: text.retry }));
    await advance(6_000);
    expect(sent.mock.calls.length - before).toBe(2);
  });
});
