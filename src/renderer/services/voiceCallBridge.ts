// ============================================================================
// voiceCallBridge —— 实时通话的 WS 唯一消费者（Phase 1 批 B）
//
// VoiceSpikePanel 的组件内 WS 管理改写为模块级单例：入口按钮、VoiceChrome、
// 字幕行、成员条高亮分处不同组件树，通话寿命不能绑在任何一个组件上。
// 保留了 spike 真机踩出来的三条教训：
//   1) 拨号前必须显式关旧 WS（否则被 host 单路互斥挡成 VOICE_SESSION_BUSY）；
//   2) WebSocket error 事件不带原因，要自己记「有没有 open 过」区分握手失败；
//   3) server_vad 要持续推流（静音也发帧），门控在管线里做不在 WS 层做。
//
// 字幕落库只有 host 一个生产者（§7.5）：final 落库后这里只做「重新拉消息」，
// 绝不在 renderer 手搓 message 塞进 sessionStore。
// ============================================================================

import type { VoiceMessageCode } from '@shared/contract/voice';
import { VOICE_FOCUS_REPORT_MIN_INTERVAL_MS, VOICE_RECONNECT_BACKOFF_MS, VOICE_STREAM_WS_PATH, VOICE_TEARDOWN_DRAIN_MS, VOICE_WS_CLOSE_TERMINAL } from '@shared/constants/voice';
import type { AppSettings, Message } from '@shared/contract';
import type { VoiceClientCommand, VoiceEvent } from '@shared/contract/voice';
import { IPC_DOMAINS } from '@shared/ipc';
import { languages } from '../i18n';
import { readActiveAgentSessionMap } from '../stores/activeAgentSessionMap';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useVoiceCallStore, type VoiceInterruptMode } from '../stores/voiceCallStore';
import ipcService from './ipcService';
import { isNativeDesktopAvailable } from './nativeDesktop';
import { NativeVoiceAudioPipeline } from './nativeVoiceAudioPipeline';
import { maybeShowSpeakerEchoHint, showVoiceAecFallbackWarning } from './voiceEchoHint';
import { VoiceAudioPipeline, type VoiceAudioPipelineLike } from './voiceAudioPipeline';
import { resolvePartialRelease } from '../utils/voicePartialOverlay';
import { selectVoiceFocusContext } from './voiceFocusContext';
import { normalizeInterruptMode } from '../components/features/voice/voiceSettingsDerivation';

function getT() {
  return languages[useAppStore.getState().language] ?? languages.zh;
}

function buildStreamUrl(sessionId: string, agentId?: string): string {
  const token = (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ sessionId });
  if (typeof token === 'string') params.set('token', token);
  if (agentId) params.set('agentId', agentId);
  return `${scheme}://${window.location.host}${VOICE_STREAM_WS_PATH}?${params.toString()}`;
}

async function readVoiceRuntimeSettings(): Promise<{
  interruptMode: VoiceInterruptMode;
  echoCancellation: 'auto' | 'off';
}> {
  try {
    const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
    return {
      interruptMode: normalizeInterruptMode(settings.voice?.live?.interrupt),
      echoCancellation: settings.voice?.live?.echoCancellation ?? 'auto',
    };
  } catch {
    return { interruptMode: 'server_vad', echoCancellation: 'auto' };
  }
}

/** final 落库是 host 的事；renderer 只重新拉一次消息让气泡/摘要卡自然进流。 */
async function reloadVoiceSessionMessages(sessionId: string): Promise<void> {
  if (useSessionStore.getState().currentSessionId !== sessionId) return;
  try {
    const response = await window.domainAPI?.invoke<{ messages?: Message[] }>(IPC_DOMAINS.SESSION, 'load', { sessionId });
    if (!response?.success || useSessionStore.getState().currentSessionId !== sessionId) return;
    const messages = response.data?.messages;
    if (Array.isArray(messages)) useSessionStore.getState().setMessages(messages);
  } catch {
    // 拉取失败不致命：下一次 final / 挂断还会再拉
  }
}

class VoiceCallBridge {
  private ws: WebSocket | null = null;
  private audio: VoiceAudioPipelineLike | null = null;
  private audioReady: Promise<'native_aec' | 'headphones'> | null = null;
  private fallbackWarningShown = false;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** 用户显式挂断 vs 网络断开——只有后者才该重连。 */
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private store() {
    return useVoiceCallStore.getState();
  }

  private send(command: VoiceClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(command));
  }

  /**
   * final 到了不立刻清 partial——清了就有一段「哪里都没有这句话」的空窗
   * （落库是异步的，这里还要等 500ms 才去拉消息）。partial 现在渲染成流尾的临时气泡，
   * 空窗会变成肉眼可见的闪断。所以：临时气泡先顶着 final 文本，等真消息上屏后再撤。
   */
  private settledPartials: { user?: string; assistant?: string } = {};

  private scheduleReload(sessionId: string, settled?: 'user' | 'assistant', delayMs = 500): void {
    if (settled) {
      this.settledPartials[settled] = settled === 'user'
        ? this.store().partialUser
        : this.store().partialAssistant;
    }
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(async () => {
      this.reloadTimer = null;
      await reloadVoiceSessionMessages(sessionId);
      this.releaseSettledPartials();
    }, delayMs);
  }

  private releaseSettledPartials(): void {
    const state = this.store();
    const patch = resolvePartialRelease(this.settledPartials, {
      user: state.partialUser,
      assistant: state.partialAssistant,
    });
    this.settledPartials = {};
    if (Object.keys(patch).length > 0) state.eventApplied(patch);
  }

  /**
   * 挂断后的第二次拉消息（现象 3·摘要卡延迟的根因）：
   * host teardown 要等 VOICE_TEARDOWN_DRAIN_MS（1500ms）排水窗才把摘要卡落库，
   * 而挂断时那次 reload 固定在 800ms——拉回来的消息里还没有摘要，之后又没有任何人
   * 再拉，于是「第一通挂断不显示，第二通挂断才把第一通的顶出来」。
   * 800ms 那次照留（字幕尾巴尽早上屏），排水窗之后再补一次拿摘要卡。
   */
  private hangupReloadTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleHangupSummaryReload(sessionId: string): void {
    if (this.hangupReloadTimer) clearTimeout(this.hangupReloadTimer);
    this.hangupReloadTimer = setTimeout(() => {
      this.hangupReloadTimer = null;
      void reloadVoiceSessionMessages(sessionId);
    }, VOICE_TEARDOWN_DRAIN_MS + 500);
  }

  /**
   * 焦点上报（§6.5）：只在通话中订阅，节流 ≥1s，内容没变不发。
   * 不通话时零开销——这是 appStore 的高频订阅，常开会让每次面板切换都过一遍。
   */
  private focusUnsubscribe: (() => void) | null = null;
  private lastFocusSentAt = 0;
  private lastFocusKey = '';
  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  private startFocusReporting(): void {
    if (this.focusUnsubscribe) return;
    const push = () => {
      const context = selectVoiceFocusContext(useAppStore.getState());
      const key = JSON.stringify(context);
      if (key === this.lastFocusKey) return;
      const elapsed = Date.now() - this.lastFocusSentAt;
      if (elapsed < VOICE_FOCUS_REPORT_MIN_INTERVAL_MS) {
        // 节流窗内的变化不能直接丢：丢了就永远停在旧焦点上（用户切走再没动过）。
        if (this.focusTimer) return;
        this.focusTimer = setTimeout(() => {
          this.focusTimer = null;
          push();
        }, VOICE_FOCUS_REPORT_MIN_INTERVAL_MS - elapsed);
        return;
      }
      this.lastFocusKey = key;
      this.lastFocusSentAt = Date.now();
      this.send({ type: 'focus', context });
    };
    this.focusUnsubscribe = useAppStore.subscribe(push);
    push(); // 建连即报一次当前焦点，别等用户去切面板
  }

  private stopFocusReporting(): void {
    this.focusUnsubscribe?.();
    this.focusUnsubscribe = null;
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.lastFocusKey = '';
    this.lastFocusSentAt = 0;
  }

  async dial(sessionId: string): Promise<void> {
    const { phase } = this.store();
    if (phase === 'connecting' || phase === 'live') return;

    // 旧连接必须先关：error 态下上一条 WS 往往还开着，不关会被 host 单路互斥
    // 挡成 VOICE_SESSION_BUSY（spike 真机 2026-07-26）。
    this.ws?.close();
    this.ws = null;
    this.audio?.stop();
    this.audio = null;
    this.settledPartials = {};
    this.audioReady = null;
    this.fallbackWarningShown = false;

    const activeAgentId = readActiveAgentSessionMap()[sessionId];
    const { interruptMode, echoCancellation } = await readVoiceRuntimeSettings();
    if (useVoiceCallStore.getState().phase !== 'idle') return; // await 期间状态被改，别抢
    this.store().dialStarted(sessionId, activeAgentId, interruptMode);
    this.intentionalClose = false;
    this.reconnectAttempt = 0;

    this.openSocket(sessionId, activeAgentId, interruptMode, echoCancellation);
  }

  /**
   * 建一条媒体面 WS 并接管它。首次拨号和断线重连共用——重连换的是 socket，
   * 不是通话：store 不 reset，host 侧在宽限窗里认得同一条会话（见 attachVoiceClient）。
   */
  private openSocket(
    sessionId: string,
    activeAgentId: string | undefined,
    interruptMode: VoiceInterruptMode,
    echoCancellation: 'auto' | 'off',
  ): void {
    const ws = new WebSocket(buildStreamUrl(sessionId, activeAgentId));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.audioReady = this.startAudio(ws, interruptMode, echoCancellation);
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.audio?.enqueuePlayback(new Int16Array(event.data));
        this.store().eventApplied({ assistantSpeaking: true });
        return;
      }
      let voiceEvent: VoiceEvent;
      try {
        voiceEvent = JSON.parse(String(event.data)) as VoiceEvent;
      } catch {
        return;
      }
      this.handleEvent(voiceEvent, sessionId);
    };

    ws.onerror = () => {
      // 重连尝试失败不算「握手失败」——它由 onclose 走退避，别在这里先把 phase 打成 error
      // 把重连路径掐死（那样第一次抖动就直接变成不可恢复）。
      if (!opened && !this.store().reconnecting) {
        this.store().phaseChanged('error');
        this.store().eventApplied({ error: { code: 'HANDSHAKE_FAILED', message: getT().voice.error.handshake } });
      }
    };

    ws.onclose = (closeEvent) => {
      this.audio?.stop();
      this.audio = null;
      this.audioReady = null;
      if (this.ws === ws) this.ws = null;
      const { phase } = this.store();
      if (phase === 'idle') return;
      // 首次握手就没成：这不是断线，是压根没连上，重连也没意义。
      if (!opened && !this.store().reconnecting) {
        if (phase === 'connecting') {
          this.store().phaseChanged('error');
          this.store().eventApplied({ error: { code: 'HANDSHAKE_FAILED', message: getT().voice.error.handshake } });
        }
        return;
      }
      this.stopFocusReporting();
      // host 说「这通电话结束了」（模型挂断 / watchdog / 上游死 / 互斥抢占）带终止 close code。
      // 它不是抖动，重连等于当场拨出一通新电话——2026-07-30 真机就是这么在挂断 2 秒后
      // 冒出一通 16 秒空通话，通话条不落、计时继续走，用户以为压根没挂断。
      const hostTerminated = closeEvent.code === VOICE_WS_CLOSE_TERMINAL;
      // 用户没挂断却断了 = 网络抖动，试着接回同一通电话（host 侧有宽限窗）。
      if (!hostTerminated && !this.intentionalClose && phase !== 'error' && this.scheduleReconnect(sessionId, activeAgentId, interruptMode, echoCancellation)) return;
      // host 侧关闭（挂断/上游死/超时）：摘要落库有一点延迟，稍后再拉一次。
      this.scheduleReload(sessionId, undefined, 800);
      this.scheduleHangupSummaryReload(sessionId);
      // error 态不 reset：把错误留在 chrome 上给用户看，由 End 按钮显式收尾；
      // 否则上游报错一闪而过，用户只看到通话凭空消失。
      if (phase !== 'error') this.store().reset();
    };
  }

  /**
   * 排一次重连。返回 true = 已接管（调用方别再收尾）。
   * 退避用完还没回来就如实报断线——**不许静默假装还在通话**。
   */
  private scheduleReconnect(
    sessionId: string,
    activeAgentId: string | undefined,
    interruptMode: VoiceInterruptMode,
    echoCancellation: 'auto' | 'off',
  ): boolean {
    const delay = VOICE_RECONNECT_BACKOFF_MS[this.reconnectAttempt];
    if (delay === undefined) {
      this.store().phaseChanged('error');
      this.store().eventApplied({
        error: { code: 'RECONNECT_FAILED', message: getT().voice.error.reconnectFailed },
      });
      return true;
    }
    this.reconnectAttempt += 1;
    // 上限必须从退避表推导——UI 不许另写数字，否则改退避表的人不会记得回来改 UI。
    this.store().reconnectingChanged(true, {
      attempt: this.reconnectAttempt,
      maxAttempts: VOICE_RECONNECT_BACKOFF_MS.length,
    });
    this.store().phaseChanged('connecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 期间用户自己挂了 / 切走了就别再连
      if (this.store().phase === 'idle' || this.intentionalClose) return;
      this.openSocket(sessionId, activeAgentId, interruptMode, echoCancellation);
    }, delay);
    return true;
  }

  private webAudioCallbacks(ws: WebSocket) {
    return {
      onFrame: (pcm16k: Int16Array) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm16k.buffer as ArrayBuffer);
      },
      onLevels: (mic: number, playback: number) => this.store().levelsChanged(mic, playback),
      onError: (code: VoiceMessageCode, detail?: string) => {
        this.store().phaseChanged('error');
        // message 只作兜底/排查；给用户看的文案由 resolveVoiceMessage 按 code 查 i18n。
        this.store().eventApplied({ error: { code, message: detail ?? code } });
      },
    };
  }

  private warnAecFallback(): void {
    if (this.fallbackWarningShown) return;
    this.fallbackWarningShown = true;
    showVoiceAecFallbackWarning(getT().voice.echoHint.fallback);
  }

  /**
   * @param involuntary 非自愿降级（原生 AEC 本该可用却没用上）才报警告。
   *   用户在设置里显式选了「强制关」不是降级——那是他的选择，每通电话报一次
   *   「原生回声消除当前不可用」等于把用户的设置说成故障。
   */
  private async startWebAudio(
    ws: WebSocket,
    interruptMode: VoiceInterruptMode,
    involuntary: boolean,
  ): Promise<'headphones'> {
    const pipeline = new VoiceAudioPipeline(this.webAudioCallbacks(ws));
    pipeline.setCaptureOpen(interruptMode === 'server_vad');
    this.audio = pipeline;
    if (involuntary) this.warnAecFallback();
    await pipeline.start();
    // 与 native 分支同款的 post-await 竞态复查：getUserMedia 期间 WS 可能已关
    // （真机降级到耳机模式走的正是这条路），不复查的话管线会漏到通话外继续占麦。
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      pipeline.stop();
      return 'headphones';
    }
    return 'headphones';
  }

  /**
   * 本次通话音频管线的判定原因（批 X §5）。原生 AEC 的失败此前被 catch 静默吞掉，
   * 真机「AEC 没起来」在任何日志里都查不到。记下原因，live 后经 audio_mode 命令
   * 送 host 落日志——renderer 自己的 logger 只进 console，事后取不到证。
   */
  private audioModeReason = '';

  private async startAudio(
    ws: WebSocket,
    interruptMode: VoiceInterruptMode,
    echoCancellation: 'auto' | 'off',
  ): Promise<'native_aec' | 'headphones'> {
    // 用户显式关掉 = 自愿走耳机模式，不报降级；非 macOS/原生壳不可用 = 非自愿，要报。
    if (echoCancellation === 'off') {
      this.audioModeReason = 'user-off';
      return this.startWebAudio(ws, interruptMode, false);
    }
    if (!isNativeDesktopAvailable()) {
      this.audioModeReason = 'no-native-shell';
      return this.startWebAudio(ws, interruptMode, true);
    }

    const pipeline = new NativeVoiceAudioPipeline({
      onFrame: (pcm16k) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm16k.buffer as ArrayBuffer);
      },
      onLevels: (mic, playback) => this.store().levelsChanged(mic, playback),
      onError: () => {
        void this.fallbackFromNative(ws, interruptMode, pipeline);
      },
    });
    pipeline.setCaptureOpen(interruptMode === 'server_vad');
    this.audio = pipeline;
    try {
      await pipeline.start();
      this.audioModeReason = 'native-aec-started';
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        pipeline.stop();
        return 'native_aec';
      }
      return 'native_aec';
    } catch (error) {
      // 失败原因是「环境还是代码」判因的唯一证据，绝不再静默吞。
      this.audioModeReason = `native-start-failed: ${error instanceof Error ? error.message : String(error)}`;
      if (this.audio === pipeline) {
        pipeline.stop();
        this.audio = null;
      }
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return 'headphones';
      return this.startWebAudio(ws, interruptMode, true);
    }
  }

  private async fallbackFromNative(
    ws: WebSocket,
    interruptMode: VoiceInterruptMode,
    failedPipeline: NativeVoiceAudioPipeline,
  ): Promise<void> {
    if (this.audio !== failedPipeline || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    failedPipeline.stop();
    this.audio = null;
    // 运行中降级同样要留痕（start 成功后原生管线半路死掉这一档）。
    this.audioModeReason = 'native-runtime-error';
    this.send({ type: 'audio_mode', mode: 'headphones', reason: this.audioModeReason });
    await this.startWebAudio(ws, interruptMode, true);
    if (this.ws !== ws || this.store().phase !== 'live') return;
    const text = getT().voice.echoHint;
    void maybeShowSpeakerEchoHint({ message: text.message, dontShowAgain: text.dontShowAgain });
  }

  private handleEvent(event: VoiceEvent, sessionId: string): void {
    switch (event.type) {
      case 'state':
        if (event.state === 'live') {
          this.store().phaseChanged('live');
          // 接回来了：退避计数归零，下次抖动重新拿满次数。
          this.reconnectAttempt = 0;
          this.store().reconnectingChanged(false);
          this.startFocusReporting();
          // 耳机提示只在真走了 WebView 管线（没有原生 AEC）时才有意义。
          const ready = this.audioReady;
          void (async () => {
            const mode = await ready;
            // 管线判定结果送 host 落日志（批 X §5）：ws 此刻已 live，正是能送的时点。
            if (mode) this.send({ type: 'audio_mode', mode, reason: this.audioModeReason || 'unknown' });
            if (mode !== 'headphones' || this.store().phase !== 'live') return;
            const text = getT().voice.echoHint;
            await maybeShowSpeakerEchoHint({ message: text.message, dontShowAgain: text.dontShowAgain });
          })();
        } else if (event.state === 'connecting') {
          this.store().phaseChanged('connecting');
        }
        // closed 由 ws.onclose 统一收尾（host 关上游后会关 client）
        break;
      case 'speech.started':
        this.audio?.clearPlayback(); // barge-in：用户开口就掐掉正在播的回答
        this.store().eventApplied({
          userSpeaking: true,
          assistantSpeaking: false,
          // 已经收到 final、正顶着等真消息上屏的那句不能在这里抹掉（会闪断）；
          // 只清「说到一半被打断」的在途文本。
          ...(this.settledPartials.assistant === undefined ? { partialAssistant: '' } : {}),
        });
        break;
      case 'user.transcript':
        if (event.done) {
          // 顶着 final 文本等真消息上屏（见 scheduleReload）；这里不清空
          this.store().eventApplied({ userSpeaking: false, partialUser: event.text });
          this.scheduleReload(sessionId, 'user');
        } else {
          this.store().eventApplied({ partialUser: event.text });
        }
        break;
      case 'assistant.transcript':
        if (event.done) {
          this.store().eventApplied({ partialAssistant: event.text });
          this.scheduleReload(sessionId, 'assistant');
        } else {
          this.store().eventApplied({
            assistantSpeaking: true,
            partialAssistant: this.store().partialAssistant + event.text,
          });
        }
        break;
      case 'response.done':
        this.store().eventApplied({
          assistantSpeaking: false,
          ttfa: { modelMs: event.ttfaModelMs, perceivedMs: event.ttfaPerceivedMs },
        });
        break;
      case 'work.upsert':
        this.store().eventApplied({ workItem: event.item });
        break;
      case 'notice':
        this.store().eventApplied({
          notice: { code: event.code, message: event.message, ...(event.detail ? { detail: event.detail } : {}) },
        });
        break;
      case 'error':
        this.store().phaseChanged('error');
        this.store().eventApplied({
          error: { code: event.code, message: event.message, ...(event.detail ? { detail: event.detail } : {}) },
        });
        break;
      default:
        break;
    }
  }

  hangUp(): void {
    this.intentionalClose = true;
    this.stopFocusReporting();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.send({ type: 'end' });
    this.ws?.close();
    this.ws = null;
    this.audio?.stop();
    this.audio = null;
    this.audioReady = null;
    const { sessionId } = this.store();
    if (sessionId) {
      this.scheduleReload(sessionId, undefined, 800);
      this.scheduleHangupSummaryReload(sessionId);
    }
    this.store().reset();
  }

  toggleMute(): void {
    const muted = !this.store().muted;
    this.audio?.setMuted(muted);
    this.store().muteChanged(muted);
  }

  /** PTT：按住开始推流。 */
  pttDown(): void {
    if (this.store().phase !== 'live') return;
    this.audio?.setCaptureOpen(true);
    this.store().pttCaptureChanged(true);
  }

  /** PTT：松开即提交这一轮（turn_detection=null 路径，批 A 已可配置）。 */
  pttUp(): void {
    if (!this.store().pttCaptureOn) return;
    this.audio?.setCaptureOpen(false);
    this.store().pttCaptureChanged(false);
    this.send({ type: 'commit' });
  }

  /** manual 模式：点按开始、再点按提交。 */
  manualTap(): void {
    if (this.store().pttCaptureOn) this.pttUp();
    else this.pttDown();
  }
}

export const voiceCallBridge = new VoiceCallBridge();
