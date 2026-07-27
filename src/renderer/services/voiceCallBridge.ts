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

import { VOICE_STREAM_WS_PATH } from '@shared/constants/voice';
import type { AppSettings, Message } from '@shared/contract';
import type { VoiceClientCommand, VoiceEvent } from '@shared/contract/voice';
import { IPC_DOMAINS } from '@shared/ipc';
import { languages } from '../i18n';
import { readActiveAgentSessionMap } from '../stores/activeAgentSessionMap';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useVoiceCallStore, type VoiceInterruptMode } from '../stores/voiceCallStore';
import ipcService from './ipcService';
import { maybeShowSpeakerEchoHint } from './voiceEchoHint';
import { VoiceAudioPipeline } from './voiceAudioPipeline';
import { resolvePartialRelease } from '../utils/voicePartialOverlay';

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

async function readInterruptMode(): Promise<VoiceInterruptMode> {
  try {
    const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
    return settings.voice?.live?.interrupt ?? 'server_vad';
  } catch {
    return 'server_vad';
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
  private audio: VoiceAudioPipeline | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

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

    const activeAgentId = readActiveAgentSessionMap()[sessionId];
    const interruptMode = await readInterruptMode();
    if (useVoiceCallStore.getState().phase !== 'idle') return; // await 期间状态被改，别抢
    this.store().dialStarted(sessionId, activeAgentId, interruptMode);

    const ws = new WebSocket(buildStreamUrl(sessionId, activeAgentId));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      const pipeline = new VoiceAudioPipeline({
        onFrame: (pcm16k) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm16k.buffer as ArrayBuffer);
        },
        onLevels: (mic, playback) => this.store().levelsChanged(mic, playback),
        onError: (code) => {
          this.store().phaseChanged('error');
          this.store().eventApplied({ error: { code, message: getT().voice.error.micDenied } });
        },
      });
      // PTT/手动模式起步就关采集门：不说话时一帧人声都不该上去（turn_detection=null）。
      pipeline.setCaptureOpen(interruptMode === 'server_vad');
      this.audio = pipeline;
      void pipeline.start();
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
      if (!opened) {
        this.store().phaseChanged('error');
        this.store().eventApplied({ error: { code: 'HANDSHAKE_FAILED', message: getT().voice.error.handshake } });
      }
    };

    ws.onclose = () => {
      this.audio?.stop();
      this.audio = null;
      if (this.ws === ws) this.ws = null;
      const { phase } = this.store();
      if (phase === 'idle') return;
      if (!opened && phase === 'connecting') {
        this.store().phaseChanged('error');
        this.store().eventApplied({ error: { code: 'HANDSHAKE_FAILED', message: getT().voice.error.handshake } });
        return;
      }
      // host 侧关闭（挂断/上游死/超时）：摘要落库有一点延迟，稍后再拉一次。
      this.scheduleReload(sessionId, undefined, 800);
      // error 态不 reset：把错误留在 chrome 上给用户看，由 End 按钮显式收尾；
      // 否则上游报错一闪而过，用户只看到通话凭空消失。
      if (phase !== 'error') this.store().reset();
    };
  }

  private handleEvent(event: VoiceEvent, sessionId: string): void {
    switch (event.type) {
      case 'state':
        if (event.state === 'live') {
          this.store().phaseChanged('live');
          const text = getT().voice.echoHint;
          void maybeShowSpeakerEchoHint({ message: text.message, dontShowAgain: text.dontShowAgain });
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
      case 'error':
        this.store().phaseChanged('error');
        this.store().eventApplied({ error: { code: event.code, message: event.message } });
        break;
      default:
        break;
    }
  }

  hangUp(): void {
    this.send({ type: 'end' });
    this.ws?.close();
    this.ws = null;
    this.audio?.stop();
    this.audio = null;
    const { sessionId } = this.store();
    if (sessionId) this.scheduleReload(sessionId, undefined, 800);
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
