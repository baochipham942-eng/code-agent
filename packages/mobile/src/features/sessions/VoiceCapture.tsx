import { useEffect, useRef, useState } from 'react';
import type { PlatformPorts } from '../../platform/ports';
import type { messages } from '../../i18n';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import { AppIcon } from '../../app/AppIcon';

/**
 * 失败必须带阶段和真实错误码：录音阶段（权限/插件/设备被占）与转写阶段（电脑没收到或没转出来）
 * 此前共用一句文案且丢掉 message，ALREADY_RECORDING / MICROPHONE_BEING_USED / 插件初始化失败
 * 在手机上长成同一句话，真机上无从定位（FB-140）。
 */
export type VoiceFailure = { stage: 'record' | 'transcribe'; reason: string; partial?: boolean };
export type VoicePhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'ready' | 'error';

type Audio = { audioData: string; mimeType: string; durationMs: number };

/**
 * 录音状态机 + 分片伪流式上传。
 *
 * 录音期间每 `voiceChunkMs` 切一段传一段，转写结果逐段追加进草稿，说着就能看到字，
 * 不用等松手（N-VOICE-CHUNKED-STREAM）。切段是「停当前文件 → 立刻重开」——
 * AVAudioRecorder 与安卓厂商插件都没有无缝切文件的接口，这中间的间隙就是丢音窗口，
 * 真机实测值记在证据档里。
 *
 * 一切串行：companion 协议一次只允许一条待确认命令（`saved.pending`），第二条会被静默丢弃。
 * 所以录音走一条主循环、上传走一条队列，两边都不并发；`transcribe` 回报「发出去了没有」，
 * 没发出去的分片留在队头等下一拍，不静默丢。
 */
export function useVoiceCapture({ recorder, pending, outcome, errorCode, ready, transcribe, discardPending }: {
  recorder: PlatformPorts['recorder'];
  pending: boolean;
  outcome: 'done' | 'error' | null;
  /** 此刻发得出命令吗（已连上电脑且有可寻址会话）。发不出就不能干等——面板会把输入框锁死。 */
  ready: boolean;
  /** 最近一条命令被拒的真实错误码，用来给「整段都没转出来」配上可定位的原因。 */
  errorCode: string | null;
  transcribe(audio: Audio, continuation: boolean): Promise<boolean>;
  /** 取消录音时调用：在飞那条转写的结果按语音契约当晚到结果丢掉，不进草稿。 */
  discardPending(): void;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [failure, setFailure] = useState<VoiceFailure | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [queued, setQueued] = useState(0);
  const [tick, setTick] = useState(0);

  const queue = useRef<Audio[]>([]);
  const awaiting = useRef<Audio | null>(null);
  const retryable = useRef<Audio[]>([]);
  /** 这次录音里最后一次失败的真实原因（录音阶段/转写阶段都记）——一段都没成文时要靠它报错。 */
  const lastFailure = useRef<{ stage: VoiceFailure['stage']; reason?: string } | null>(null);
  const sending = useRef(false);
  const sentAny = useRef(false);
  const active = useRef(false);
  const ended = useRef(false);
  const stopRequest = useRef<'keep' | 'discard' | null>(null);
  const wake = useRef<(() => void) | null>(null);
  const startedAt = useRef(0);
  /** 每次录音一个代号：取消后立刻再点麦克风时，上一轮 start() 不能接着把面板开回来。 */
  const generation = useRef(0);
  /** 正在跑的那条录音循环。新一轮必须先把它拆干净，否则两条循环抢同一个 recorder。 */
  const running = useRef<Promise<void> | null>(null);

  const syncQueued = () => setQueued(queue.current.length + (awaiting.current ? 1 : 0));
  const fail = (stage: VoiceFailure['stage'], error: unknown) => {
    setFailure({ stage, reason: error instanceof Error && error.message ? error.message : String(error) });
    setPhase('error');
  };
  /** 清掉这次录音的全部在途数据，但不碰 stopRequest——它可能是「正在取消」的唯一记号。 */
  const clearQueue = () => {
    queue.current = []; awaiting.current = null; sending.current = false;
    sentAny.current = false; ended.current = false; lastFailure.current = null;
    setDropped(0); setQueued(0);
  };
  const reset = () => { clearQueue(); active.current = false; stopRequest.current = null; };
  const drop = (failure: { stage: VoiceFailure['stage']; reason?: string }) => { lastFailure.current = failure; setDropped(count => count + 1); };
  const enqueue = (value: Audio) => {
    if (value.audioData.length > L.voiceBase64Limit) { drop({ stage: 'record', reason: 'AUDIO_TOO_LARGE' }); return; }
    queue.current.push(value); syncQueued();
  };
  /** 等一个分片的时长；停止/取消会提前唤醒，不用等满这一段。 */
  const waitChunk = () => new Promise<void>(resolve => {
    const timer = setTimeout(() => done(), L.voiceChunkMs);
    const done = () => { clearTimeout(timer); wake.current = null; resolve(); };
    wake.current = done;
  });

  const run = async () => {
    for (;;) {
      await waitChunk();
      const last = stopRequest.current !== null || Date.now() - startedAt.current >= L.voiceDurationMs;
      let value: Audio | null = null;
      try { value = await recorder!.stop(); }
      catch (error) {
        // 丢弃路径上的失败不该报给用户：录音本来就不要了（切后台时原生侧可能已经自己收了摊，
        // 这时 stop 抛的是 RECORDING_HAS_NOT_STARTED，显示成「录音失败」是假警报）。
        if (stopRequest.current === 'discard') { active.current = false; reset(); setPhase('idle'); return; }
        // 整段静音时插件抛 EMPTY_RECORDING——那只该丢这一段，不该毁掉整次录音。
        if (!(error instanceof Error && error.message === 'EMPTY_RECORDING')) { active.current = false; fail('record', error); return; }
        drop({ stage: 'record', reason: 'EMPTY_RECORDING' });
      }
      if (value && stopRequest.current !== 'discard') enqueue(value);
      // 到 60s 上限是我们自己收的尾：不切 stopping 的话，面板会一直显示「正在听你说」，
      // 而停止键因为 active 已经是 false 点了没反应（grok ai-review Nit，真实死键）。
      if (last) { active.current = false; if (stopRequest.current === null) setPhase('stopping'); break; }
      try { await recorder!.start(); }
      catch (error) { active.current = false; fail('record', error); return; }
    }
    if (stopRequest.current === 'discard') { reset(); setPhase('idle'); return; }
    ended.current = true;
    setTick(count => count + 1);
  };

  const start = async () => {
    if (!recorder) return;
    const mine = ++generation.current;
    // 上一轮还在收尾（取消之后立刻再点麦克风就是这个时序）：先把它拆干净再开新的，
    // 否则两条录音循环会抢同一个 recorder，切段全乱（grok ai-review Nit）。
    if (running.current) { stopRequest.current = 'discard'; wake.current?.(); await running.current; }
    if (generation.current !== mine) return;   // 拆的期间又被点了，让最后那次赢
    reset(); setFailure(null); setPhase('starting');
    retryable.current = [];
    startedAt.current = Date.now(); setElapsedMs(0);
    try {
      await recorder.start();
      if (stopRequest.current || generation.current !== mine) { await recorder.stop().catch(() => {}); if (generation.current === mine) setPhase('idle'); return; }
      active.current = true;
      setPhase('recording');
      running.current = run().finally(() => { running.current = null; });
    } catch (error) { if (generation.current === mine) fail('record', error); }
  };
  const endRecording = (discard: boolean) => {
    if (discard) discardPending();
    // 先立记号：录音可能还停在 recorder.start() 的 await 里（phase='starting'），
    // 那时 active 还是 false，但这次取消必须被 start() 看见，不能当没发生。
    stopRequest.current = discard ? 'discard' : 'keep';
    if (!active.current) { if (discard) { clearQueue(); setFailure(null); setPhase('idle'); } return; }
    setPhase(discard ? 'idle' : 'stopping');
    wake.current?.();
  };

  useEffect(() => {
    const hide = () => { if (document.hidden) endRecording(true); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      stopRequest.current = 'discard'; wake.current?.();
      if (active.current) void recorder?.stop().catch(() => {});
      active.current = false;
    };
  }, [recorder]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 500);
    return () => clearInterval(timer);
  }, [phase]);

  // 队列泵：一次只发一条，发出去了才出队；没发出去（协议在忙）留在队头，下一拍再试。
  // 明知发不出去（没连上电脑）就别空转：每一拍都把 sending 置起，会让收尾那个副作用
  // 永远看到「正在发」而不收尾，面板把输入框锁死在后面。
  useEffect(() => {
    if (!ready || sending.current || awaiting.current || pending || !queue.current.length) return;
    sending.current = true;
    void (async () => {
      const chunk = queue.current[0];
      let sent: boolean;
      try { sent = await transcribe(chunk, sentAny.current); }
      catch (error) {
        // 抛出 = 这条命令这次没戏。记下真实原因、把这段留给重试，别把队列卡死在队头。
        queue.current.shift(); retryable.current.push(chunk); sending.current = false;
        drop({ stage: 'transcribe', reason: error instanceof Error && error.message ? error.message : String(error) });
        syncQueued(); setTick(count => count + 1);
        return;
      }
      sending.current = false;
      if (!sent) { setTimeout(() => setTick(count => count + 1), 500); return; }
      queue.current.shift(); awaiting.current = chunk; syncQueued();
    })();
  }, [ready, pending, queued, tick, transcribe]);

  // 结算：ack 回来才知道这一段成没成文。失败的留着，「重试」按原顺序补发。
  useEffect(() => {
    if (!awaiting.current || pending || outcome === null) return;
    if (outcome === 'done') sentAny.current = true;
    // 原因留到收尾再取：commandError 与 voiceOutcome 是两次 set，结算这一帧读到的可能还是旧值
    // （grok ai-review Nit）。这里只记「是转写阶段失败的」，真实错误码在 surface 时取最新的。
    else { retryable.current.push(awaiting.current); drop({ stage: 'transcribe' }); }
    awaiting.current = null; syncQueued(); setTick(count => count + 1);
  }, [pending, outcome, tick]);

  // 收尾：录音结束且队列排空才关面板；一段都没成文时报一次失败，留出重试入口。
  useEffect(() => {
    if (!ended.current || phase === 'idle' || phase === 'error') return;
    if (pending || sending.current || awaiting.current) return;
    if (queue.current.length) {
      // 还连得上就继续排队发。连不上就**不能干等**：面板替换了输入框，队列永远排不空的话
      // 用户既改不了草稿也发不出字，整块输入区被锁死（grok ai-review Important：
      // 录音中途电脑掉线、再点停止就是这条路）。把没发出去的留给重试，先把输入框还回去。
      if (ready) return;
      const stranded = queue.current.length;
      retryable.current.push(...queue.current); queue.current = [];
      lastFailure.current ??= { stage: 'transcribe' };
      setDropped(count => count + stranded); syncQueued();
    }
    // 这次录音只要有过失败就必须留痕，别管其余几段成没成文：
    // 只在「一段都没成」时报的话，部分成功那条路会把 dropped/retryable 一起 reset 掉——
    // 末段失败的字既没提示也没补传入口，静悄悄没了（grok ai-review 两轮分别指出这两半）。
    if (lastFailure.current) {
      const { stage, reason } = lastFailure.current;
      setFailure({ stage, reason: reason ?? errorCode ?? 'COMPANION_TRANSCRIPTION_FAILED', partial: sentAny.current });
      setPhase('error');
    }
    else { reset(); setPhase('idle'); }
    ended.current = false;
  }, [phase, pending, queued, tick, errorCode, ready]);

  // 失败提示里的兜底码是「还没拿到真原因」的占位：commandError 晚一拍到时把它换掉。
  useEffect(() => {
    if (phase !== 'error' || !errorCode) return;
    setFailure(current => current && current.reason === 'COMPANION_TRANSCRIPTION_FAILED' && current.stage === 'transcribe'
      ? { ...current, reason: errorCode } : current);
  }, [phase, errorCode]);

  const retry = () => {
    if (!retryable.current.length) { void start(); return; }
    setFailure(null); setPhase('ready'); ended.current = true; lastFailure.current = null;
    queue.current.push(...retryable.current); retryable.current = [];
    setDropped(0); syncQueued(); setTick(count => count + 1);
  };
  return {
    phase, failure, elapsedMs, dropped,
    // 面板只在「正在录 / 正在转写」时替换输入框；失败按设计稿落在输入区上方，输入框要留给用户改字。
    panelOpen: phase !== 'idle' && phase !== 'error',
    start, stop: () => endRecording(false), cancel: () => endRecording(true), retry,
    dismissFailure: () => setFailure(null),
  };
}

const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
// 设计稿 design.html 的 .waveform 就是 38 根 CSS 动画条。
// ponytail: 波形是「正在录」的动态示意，不是真实电平——录音插件不给 metering；
// 要接真实电平得先给 NeoVoiceRecorder.swift 加 averagePower 上报。
const BARS = Array.from({ length: 38 }, (_, i) => ({ height: 8 + (i * 17 % 27), delay: (i % 7) * 0.12 }));

/** 录音中的输入区：来源 → 状态与计时 → 识别文字 → 波形 → 控制行（停止键严格居中）。 */
export function VoicePanel({ text, phase, pending, elapsedMs, transcript, dropped, stop, cancel }: {
  text: ReturnType<typeof messages>;
  phase: VoicePhase; pending: boolean; elapsedMs: number; transcript: string; dropped: number;
  stop(): void; cancel(): void;
}) {
  const listening = phase === 'recording';
  return <>
    <div className="voice-source">{text.voiceSource}</div>
    <div className="voice-label" role="status">
      <span className="dot" aria-hidden="true" />
      {listening ? text.voiceListening : pending || phase === 'ready' || phase === 'stopping' ? text.transcribing : text.voicePreparing}
      <span className="flex" /><span className="small">{clock(elapsedMs)}</span>
    </div>
    <div className="transcription">{transcript}{listening && <span className="caret" aria-hidden="true" />}</div>
    {dropped > 0 && <p className="voice-dropped" role="status">{text.voiceChunkDropped}</p>}
    <div className="waveform" aria-hidden="true">
      {BARS.map((bar, i) => <i key={i} style={{ height: `${bar.height}px`, animationDelay: `${bar.delay}s` }} />)}
    </div>
    <div className="voice-controls">
      {/* 取消是这块面板唯一的出口：它替换了输入框，禁用它等于把输入区锁死。 */}
      <button className="text-btn" aria-label={text.cancelRecording} onClick={cancel}>{text.cancel}</button>
      {listening
        ? <button className="record-stop" onClick={stop} aria-label={text.stopRecording}><AppIcon name="stop" /></button>
        : <span className="record-stop-placeholder" aria-hidden="true" />}
      <span className="voice-control-spacer" aria-hidden="true" />
    </div>
  </>;
}
