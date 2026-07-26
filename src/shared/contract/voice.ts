// ============================================================================
// 实时语音（Realtime Voice）合同
//
// Phase 0 只落地 Qwen-Omni（WebSocket 流式，Host 持 key + 内存中继）。
// VoiceTransport 的签名同时为 Phase 1 的 OpenAI WebRTC 形态留了形状：
// connect() 返回的 handle 里 `clientBootstrap` 是给 Renderer 的建连材料——
// WS 形态下它是 null（媒体面已由 Host 代管），WebRTC 形态下它装 ephemeral
// client secret 与 SDP 交换所需信息，由 Renderer 直连上游。见方案 §9.1/§9.2。
// ============================================================================

export type VoiceProviderId = 'qwen-omni' | 'openai-realtime';

export interface VoiceSessionConfig {
  /** 绑定的 Neo 会话，字幕落到这条会话的消息流。 */
  neoSessionId: string;
  model?: string;
  voice?: string;
  language?: string;
  instructions?: string;
}

/**
 * Renderer 直连上游所需的建连材料。WS 形态返回 null。
 * WebRTC 形态在 Phase 1 填 `{ kind: 'webrtc', clientSecret, sdpUrl, expiresAt }`。
 */
export type VoiceClientBootstrap = { kind: 'webrtc'; clientSecret: string; sdpUrl: string; expiresAt: number } | null;

/** 上游 → Host 归一化后的事件。Renderer 只认这一套，换 provider 不改前端。 */
export type VoiceEvent =
  | { type: 'state'; state: 'connecting' | 'live' | 'closed' }
  /** 用户说的话（上游 ASR），final 时 done=true */
  | { type: 'user.transcript'; text: string; done: boolean }
  /** 助手说的话的字幕 */
  | { type: 'assistant.transcript'; text: string; done: boolean }
  /** 用户开口 —— Renderer 据此清空播放队列做 barge-in */
  | { type: 'speech.started' }
  | { type: 'response.done'; ttfaMs?: number }
  | { type: 'error'; code: string; message: string };

/** Renderer → Host 的控制帧（媒体帧走二进制，不走这里）。 */
export type VoiceClientCommand = { type: 'end' } | { type: 'interrupt' };

export interface VoiceTransportHandle {
  readonly provider: VoiceProviderId;
  readonly clientBootstrap: VoiceClientBootstrap;
  /** 推一帧麦克风 PCM16@16k 单声道。WS 形态转 base64 发上游；WebRTC 形态是 no-op。 */
  sendAudio(frame: Buffer): void;
  /** 打断当前回复。 */
  interrupt(): void;
  close(): Promise<void>;
}

export interface VoiceTransport {
  readonly id: VoiceProviderId;
  connect(input: {
    apiKey: string;
    config: VoiceSessionConfig;
    /** 归一化事件回调。 */
    onEvent: (event: VoiceEvent) => void;
    /** 下行助手音频 PCM16@24k 单声道。WebRTC 形态不会调用（音频不经 Host）。 */
    onAudio: (frame: Buffer) => void;
  }): Promise<VoiceTransportHandle>;
}
