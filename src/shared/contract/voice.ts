// ============================================================================
// 实时语音（Realtime Voice）合同
//
// 已落地 Qwen-Omni（WebSocket 流式，Host 持 key + 内存中继 = relay 形态）。
// VoiceTransport 的签名同时为 OpenAI WebRTC 形态（direct）留了形状：connect()
// 返回判别联合的 handle——relay 侧必须实现 sendAudio（媒体经 Host），direct 侧
// 必须给出 clientBootstrap（ephemeral client secret + SDP 交换信息，Renderer
// 直连上游）。见方案 §9.1/§9.2 与 §13.3 第 1 条。
// ============================================================================

export type VoiceProviderId = 'qwen-omni' | 'openai-realtime';

export type VoiceTurnDetectionConfig =
  | { type: 'server_vad'; threshold?: number; prefixPaddingMs?: number; silenceDurationMs?: number }
  | { type: 'semantic_vad'; eagerness?: 'low' | 'medium' | 'high' | 'auto' }
  | null;

/** 通话里派出的一件活。Phase 1 批 A 只有 queued / failed 两个真实终态，进度细分留给 Phase 2。 */
export interface VoiceWorkItem {
  id: string;
  title: string;
  status: 'queued' | 'failed';
  /** 失败原因，供 UI 显示；成功排上队时没有 */
  detail?: string;
}

export interface VoiceCallSummary {
  durationSec: number;
  provider: VoiceProviderId;
  conversationModel: string;
  workItemCount: number;
  startedAt: number;
  endedAt: number;
}

/** 注册给通话 brain 的窄工具（方案 §6.2 模式 A）。JSON Schema 直接透给上游。 */
export interface VoiceToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

export interface VoiceSessionConfig {
  /** 绑定的 Neo 会话，字幕落到这条会话的消息流。 */
  neoSessionId: string;
  model?: string;
  voice?: string;
  language?: string;
  instructions?: string;
  tools?: VoiceToolDefinition[];
}

/** Renderer 直连上游所需的建连材料。只有 direct 形态才有。 */
export type VoiceClientBootstrap = { kind: 'webrtc'; clientSecret: string; sdpUrl: string; expiresAt: number };

/** 上游 → Host 归一化后的事件。Renderer 只认这一套，换 provider 不改前端。 */
export type VoiceEvent =
  | { type: 'state'; state: 'connecting' | 'live' | 'closed' }
  /** 用户说的话（上游 ASR），final 时 done=true */
  | { type: 'user.transcript'; text: string; done: boolean }
  /** 助手说的话的字幕 */
  | { type: 'assistant.transcript'; text: string; done: boolean }
  /** 用户开口 —— Renderer 据此清空播放队列做 barge-in */
  | { type: 'speech.started' }
  | { type: 'response.done'; ttfaModelMs?: number; ttfaPerceivedMs?: number }
  /** 语音派出的任务状态。Active Work 条消费（批 B），host 侧同时用它计通话摘要的 workItemCount。 */
  | { type: 'work.upsert'; item: VoiceWorkItem }
  | { type: 'error'; code: string; message: string };

/** Renderer → Host 的控制帧（媒体帧走二进制，不走这里）。 */
export type VoiceClientCommand = { type: 'end' } | { type: 'interrupt' };

interface VoiceTransportHandleBase {
  readonly provider: VoiceProviderId;
  /** 打断当前回复。 */
  interrupt(): void;
  close(): Promise<void>;
}

/**
 * 判别联合而不是「带 no-op 方法的宽接口」：Phase 0 的 handle 上，WS 形态的
 * `clientBootstrap` 恒为 null、WebRTC 形态的 `sendAudio` 恒为 no-op——两个
 * 「永远不该被调用/读取」的成员就是 fail-open 的温床（方案 §13.3 第 1 条）。
 * 拆开后调用方必须先分支，少写一个分支是类型错误而不是静默空转。
 */
export type VoiceTransportHandle =
  /** 媒体经 Host 内存中继（Qwen-Omni 等 WS 形态）。 */
  | (VoiceTransportHandleBase & {
      readonly kind: 'relay';
      /** 推一帧麦克风 PCM16@16k 单声道，转 base64 发上游。 */
      sendAudio(frame: Buffer): void;
    })
  /** Renderer 直连上游（OpenAI Realtime 等 WebRTC 形态），媒体不经 Host。 */
  | (VoiceTransportHandleBase & {
      readonly kind: 'direct';
      readonly clientBootstrap: VoiceClientBootstrap;
    });

export interface VoiceTransport {
  readonly id: VoiceProviderId;
  connect(input: {
    apiKey: string;
    config: VoiceSessionConfig;
    /** 归一化事件回调。 */
    onEvent: (event: VoiceEvent) => void;
    /** 下行助手音频 PCM16@24k 单声道。WebRTC 形态不会调用（音频不经 Host）。 */
    onAudio: (frame: Buffer) => void;
    /**
     * 上游 function call 的执行出口，返回的文本原样回灌给通话 brain。
     * 未提供时 transport 不注册任何工具——「没接执行出口却把工具告诉模型」
     * 会让模型调了个永远没有结果的工具，比不给工具更糟。
     */
    onToolCall?: (call: { callId: string; name: string; arguments: string }) => Promise<string>;
  }): Promise<VoiceTransportHandle>;
}
