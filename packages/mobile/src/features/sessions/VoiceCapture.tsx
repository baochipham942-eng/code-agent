import { useEffect, useRef, useState } from 'react';
import type { PlatformPorts } from '../../platform/ports';
import type { messages } from '../../i18n';
import type { VoiceResult } from '../../stores/companionStore';
import { COMPANION_LIMITS as L } from '../../../../../src/shared/constants/companion';
import { AppIcon } from '../../app/AppIcon';

/**
 * 失败必须带阶段和真实错误码：录音阶段（权限/插件/设备被占）与转写阶段（电脑没收到或没转出来）
 * 此前共用一句文案且丢掉 message，ALREADY_RECORDING / MICROPHONE_BEING_USED / 插件初始化失败
 * 在手机上长成同一句话，真机上无从定位（FB-140）。
 */
export type VoiceFailure = { stage: 'record' | 'transcribe'; reason: string; partial?: boolean };
export type VoicePhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'ready' | 'error';

type Chunk = { audioData: string; mimeType: string; durationMs: number };

/**
 * 「一次录音」——从点麦克风到面板收口之间的全部在途数据，以及它的代号 `id`。
 *
 * 这个对象是本模块**唯一**的身份判据：每个异步续段（`recorder.start/stop` 的 await 之后、
 * 队列泵的 IIFE、结算、取消）回来第一件事都是 `take.current === t`，不是自己的就直接丢。
 * 在此之前这些续段靠电平（`pending` / `voiceOutcome` / `commandError`）反推「我这次还算不算数」，
 * 而那些电平跨录音、跨会话粘着——2026-09-12 那七轮 ai-review 抓出的九条 Important/Nit
 * 全长在这同一个形状上，每修一条就多一道交叉判据。改成显式代号之后，
 * 「取消 / 换一次录音 / 换会话」只需要**摘掉身份**这一个动作，所有在途的东西自动作废。
 */
type Take = {
  id: string;
  queue: Chunk[];
  /** 已进待确认槽、等主机结算的那一段——按 commandId 认领结果，不看粘着的全局 outcome。 */
  awaiting: { chunk: Chunk; commandId: string } | null;
  retry: Chunk[];
  sending: boolean;
  sentAny: boolean;
  /** 这次录音里最后一次失败的真实原因（录音阶段/转写阶段都记）——收尾时要靠它报错。 */
  failure: { stage: VoiceFailure['stage']; reason?: string } | null;
  dropped: number;
  /** 录音口此刻开着。收 recorder 的人先把它落下，避免两处并发 stop 同一次录音。 */
  live: boolean;
  /** 录音循环已结束，只剩队列在排空。 */
  drained: boolean;
  /** 用户按了停止：录完手上这一段就收尾。取消不走这里——取消是直接摘身份。 */
  stopping: boolean;
  startedAt: number;
  wake: (() => void) | null;
};

/** 代号在模块级发，跨 mount 也不重号：Composer 会随会话重挂，计数器从 0 重来会撞上一次的代号。 */
let takeSeq = 0;

/**
 * 录音状态机 + 分片伪流式上传。
 *
 * 录音期间每 `voiceChunkMs` 切一段传一段，转写结果逐段追加进草稿，说着就能看到字，
 * 不用等松手（N-VOICE-CHUNKED-STREAM）。切段是「停当前文件 → 立刻重开」——
 * AVAudioRecorder 与安卓厂商插件都没有无缝切文件的接口，这中间的间隙就是丢音窗口，
 * 真机实测值记在证据档里。
 *
 * 一切串行：companion 协议一次只允许一条待确认命令（`saved.pending`），第二条会被静默丢弃。
 * 所以录音走一条主循环、上传走一条队列，两边都不并发；`transcribe` 回报这条命令的 commandId，
 * 没发出去的分片留在队头等下一拍，不静默丢。
 */
export function useVoiceCapture({ recorder, pending, result, ready, transcribe, discardPending }: {
  recorder: PlatformPorts['recorder'];
  /** 协议此刻有没有待确认命令。这是队列泵的**前置条件**（发不出去就别发），不是相位判据。 */
  pending: boolean;
  /** 最近一条转写命令的结果，带着它是哪一条。认 commandId 才能保证结算的是自己发的那段。 */
  result: VoiceResult | null;
  /** 此刻发得出命令吗（已连上电脑且有可寻址会话）。发不出就不能干等——面板会把输入框锁死。 */
  ready: boolean;
  /** 返回这条命令的 commandId（已进待确认槽）；没发出去回 null，那段留在队头下一拍再试。 */
  transcribe(audio: Chunk, continuation: boolean, take: string): Promise<string | null>;
  /** 取消这次录音：晚到的结果按语音契约丢掉，不进草稿。按代号点名，不是一个粘着的开关。 */
  discardPending(take: string): void;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [failure, setFailure] = useState<VoiceFailure | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  /** 这次录音有字成文了——「可以改完再发」的提示据此显示，不再读跨会话粘着的全局 outcome。 */
  const [transcribed, setTranscribed] = useState(false);
  const [tick, setTick] = useState(0);

  const take = useRef<Take | null>(null);
  const running = useRef<Promise<void> | null>(null);

  /** take 是可变对象，改完必须 bump 一下界面才看得见——全模块只有这一个重渲染触发器。 */
  const bump = () => setTick(count => count + 1);
  const mine = (t: Take) => take.current === t;
  const open = () => {
    const t: Take = { id: `take-${++takeSeq}`, queue: [], awaiting: null, retry: [], sending: false,
      sentAny: false, failure: null, dropped: 0, live: false, drained: false, stopping: false,
      startedAt: Date.now(), wake: null };
    take.current = t;
    return t;
  };
  /**
  * 这次录音不算数了：把录音口收干净，别把麦克风留在开着的状态。先落 live 再 await，才幂等
  * （取消与录音循环可能同时走到这里）。
  * 与它配对的铁律：`recorder.start()` 一 resolve 就立刻置 live，**早于**任何身份判断——
  * 中间插一个 `if (!mine(t)) return` 的话，切段时被取消就会留下一个谁都不认领的开着的麦克风。
  */
  const release = async (t: Take) => { if (t.live) { t.live = false; await recorder?.stop().catch(() => {}); } };

  const fail = (t: Take, stage: VoiceFailure['stage'], error: unknown) => {
    if (!mine(t)) return;
    setFailure({ stage, reason: error instanceof Error && error.message ? error.message : String(error) });
    setPhase('error');
  };
  const drop = (t: Take, reason: { stage: VoiceFailure['stage']; reason?: string }) => {
    t.failure = reason; t.dropped += 1; bump();
  };
  const enqueue = (t: Take, chunk: Chunk) => {
    if (chunk.audioData.length > L.voiceBase64Limit) { drop(t, { stage: 'record', reason: 'AUDIO_TOO_LARGE' }); return; }
    t.queue.push(chunk); bump();
  };
  /** 等一个分片的时长；停止/取消会提前唤醒，不用等满这一段。 */
  const waitChunk = (t: Take) => new Promise<void>(resolve => {
    const timer = setTimeout(() => done(), L.voiceChunkMs);
    const done = () => { clearTimeout(timer); t.wake = null; resolve(); };
    t.wake = done;
  });

  const run = async (t: Take) => {
    try {
      for (;;) {
        await waitChunk(t);
        if (!mine(t)) return;
        const last = t.stopping || Date.now() - t.startedAt >= L.voiceDurationMs;
        let chunk: Chunk | null = null;
        // stop 一发出去，录音口就不再算「开着」：卸载的清理可能正落在这个 await 里，
        // 它的 release 必须看到 live=false，否则两处并发 stop 同一次录音。
        t.live = false;
        try { chunk = await recorder!.stop(); }
        catch (error) {
          if (!mine(t)) return;
          // 整段静音时插件抛 EMPTY_RECORDING——那只该丢这一段，不该毁掉整次录音。
          if (!(error instanceof Error && error.message === 'EMPTY_RECORDING')) { fail(t, 'record', error); return; }
          drop(t, { stage: 'record', reason: 'EMPTY_RECORDING' });
        }
        if (!mine(t)) return;
        if (chunk) enqueue(t, chunk);
        // 到 60s 上限是我们自己收的尾：不切 stopping 的话，面板会一直显示「正在听你说」，
        // 而停止键因为录音已停、点了没反应（grok ai-review Nit，真实死键）。
        // `stopping` 要在 await 之后再读一次：用户按停止时录音口正卡在 recorder.stop() 里
        // （真机 ~320ms）是常态，只认进循环前那一眼的话，这次停止要再等满一整段才生效。
        if (last || t.stopping) { setPhase('stopping'); break; }
        try { await recorder!.start(); t.live = true; }
        catch (error) { fail(t, 'record', error); return; }
        if (!mine(t)) return;   // 取消落在这次切段里：live 已经置起，收尾的 release 会去收它
      }
      t.drained = true;
      bump();
    } finally { await release(t); }
  };

  const start = async () => {
    if (!recorder) return;
    // 先占住身份：上一次录音（以及它所有在途的续段）从这一行起就不算数了。
    const previous = take.current;
    const t = open();
    // 上一轮还在收尾（取消之后立刻再点麦克风就是这个时序）：叫醒它、等它把 recorder 还回来，
    // 否则两条录音循环会抢同一个 recorder，切段全乱（grok ai-review Nit）。
    previous?.wake?.();
    if (running.current) await running.current;
    if (!mine(t)) return;   // 等的期间又被点了，让最后那次赢
    setFailure(null); setTranscribed(false); setPhase('starting');
    t.startedAt = Date.now(); setElapsedMs(0);
    try {
      await recorder.start();
      t.live = true;
      if (!mine(t) || t.stopping) { await release(t); if (mine(t)) { take.current = null; setPhase('idle'); } return; }
      setPhase('recording');
      const loop = run(t);
      running.current = loop;
      void loop.finally(() => { if (running.current === loop) running.current = null; });
    } catch (error) { fail(t, 'record', error); }
  };

  const stop = () => {
    const t = take.current;
    if (!t) return;
    // 录音可能还停在 recorder.start() 的 await 里（phase='starting'）：那一档由 start() 的续段
    // 收尾，这里别抢着切面板；除此之外立刻切，别让「正在听你说」挂在已经按下的停止上。
    t.stopping = true;
    if (phase !== 'starting') setPhase('stopping');
    t.wake?.();
  };
  const cancel = () => {
    const t = take.current;
    if (!t) return;
    // 摘身份就是**就地**丢掉队列——不能等录音循环醒过来：它要先 await recorder.stop()，
    // 真机上这一步就要 ~320ms；这个窗口里在飞那段的 ack 一回来，泵立刻把下一段发出去，
    // 于是「取消掉的话」照样写进输入框（grok ai-review Important）。
    take.current = null;
    discardPending(t.id);
    // 录音口不在这里收：循环的 finally 与 start() 的续段各自负责把自己开的那个还回去，
    // 这里再来一遍只是让「谁负责关麦克风」多一个答案（变异实证：删掉它一条测试都不红）。
    t.wake?.();
    setFailure(null); setPhase('idle');
  };

  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      const t = take.current;
      if (!t) return;
      // 卸载 = 换会话（Composer 的 key 是 hostKey:sessionId）或换录音口，语义与取消一样，
      // 就得跟取消一样点名：只摘身份的话，已进待确认槽的那段照样会写进原会话的草稿
      // ——基线 VoiceInput 在这条路上走 stop(true)，根本不会发起转写（grok ai-review Important）。
      take.current = null;
      discardPending(t.id);
      t.wake?.(); void release(t);
    };
  }, [recorder]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => { const t = take.current; if (t) setElapsedMs(Date.now() - t.startedAt); }, 500);
    return () => clearInterval(timer);
  }, [phase]);

  // 队列泵：一次只发一条，进了待确认槽才出队；没发出去（协议在忙）留在队头，下一拍再试。
  // 明知发不出去（没连上电脑）就别空转：每一拍都把 sending 置起，会让收尾那个副作用
  // 永远看到「正在发」而不收尾，面板把输入框锁死在后面。
  useEffect(() => {
    const t = take.current;
    if (!t || !ready || t.sending || t.awaiting || pending || !t.queue.length) return;
    t.sending = true;
    void (async () => {
      const chunk = t.queue[0];
      let commandId: string | null;
      try { commandId = await transcribe(chunk, t.sentAny, t.id); }
      catch (error) {
        if (!mine(t)) return;
        // 抛出 = 这条命令这次没戏。记下真实原因、把这段留给重试，别把队列卡死在队头。
        t.sending = false; t.queue.shift(); t.retry.push(chunk);
        drop(t, { stage: 'transcribe', reason: error instanceof Error && error.message ? error.message : String(error) });
        return;
      }
      // 取消 / 换会话正落在这个 await 里：这段音频连同它的 commandId 都不再算数，
      // 否则它会被挂进新一轮的 awaiting，重试还会把取消掉的话写进输入框（grok 第七轮 Important）。
      if (!mine(t)) return;
      t.sending = false;
      if (!commandId) { setTimeout(() => { if (mine(t)) bump(); }, 500); return; }
      t.queue.shift(); t.awaiting = { chunk, commandId }; bump();
    })();
  }, [ready, pending, tick, transcribe]);

  // 结算：认 commandId。失败的留着，「重试」按原顺序补发。
  // 依赖里要有 tick：deliver 是在 transcribe 内部 await 掉的，ack 可能比 awaiting 挂上还早，
  // 那时 result 已经不再变化，只有泵那一拍的 bump 能把这次结算带回来。
  useEffect(() => {
    const t = take.current;
    if (!t?.awaiting || !result || result.commandId !== t.awaiting.commandId) return;
    if (result.outcome === 'done') { t.sentAny = true; t.awaiting = null; bump(); return; }
    t.retry.push(t.awaiting.chunk); t.awaiting = null;
    drop(t, { stage: 'transcribe', reason: result.code });
  }, [result, tick]);

  // 收尾：录音结束且队列排空才关面板；这次录音只要有过失败就报一次，留出重试入口。
  useEffect(() => {
    const t = take.current;
    if (!t || !t.drained || t.sending || t.awaiting) return;
    if (t.queue.length) {
      // 还连得上就继续排队发。连不上就**不能干等**：面板替换了输入框，队列永远排不空的话
      // 用户既改不了草稿也发不出字，整块输入区被锁死（grok ai-review Important：
      // 录音中途电脑掉线、再点停止就是这条路）。把没发出去的留给重试，先把输入框还回去。
      if (ready) return;
      t.dropped += t.queue.length;
      t.retry.push(...t.queue); t.queue = [];
      t.failure ??= { stage: 'transcribe' };
    }
    t.drained = false;
    // 有过失败就必须留痕，别管其余几段成没成文：只在「一段都没成」时报的话，部分成功那条路
    // 会把 dropped/retry 一起清掉——末段失败的字既没提示也没补传入口，静悄悄没了
    // （grok ai-review 两轮分别指出这两半）。
    if (t.failure) {
      const { stage, reason } = t.failure;
      // 失败的 take 不摘身份：重试按钮要拿它 retry 里的音频补发。下一次 start() 会把它顶掉。
      setFailure({ stage, reason: reason ?? 'COMPANION_TRANSCRIPTION_FAILED', partial: t.sentAny });
      setPhase('error');
      return;
    }
    setTranscribed(t.sentAny);
    take.current = null;
    setPhase('idle');
  }, [tick, ready]);

  const retry = () => {
    const t = take.current;
    if (!t?.retry.length) { void start(); return; }
    setFailure(null); setPhase('ready');
    t.queue.push(...t.retry); t.retry = [];
    t.dropped = 0; t.failure = null; t.drained = true;
    bump();
  };
  return {
    phase, failure, elapsedMs, transcribed, dropped: take.current?.dropped ?? 0,
    // 面板只在「正在录 / 正在转写」时替换输入框；失败按设计稿落在输入区上方，输入框要留给用户改字。
    panelOpen: phase !== 'idle' && phase !== 'error',
    start, stop, cancel, retry,
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
