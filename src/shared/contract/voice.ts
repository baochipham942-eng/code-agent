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

/**
 * 通话里派出的一件活。
 *
 * Phase 2 批 H 补齐全生命周期：此前只有 queued / failed 两态——run 干完了不发任何事件，
 * Active Work 条上它永远停在「排队中」，通话 brain 也拿不到「做完了」的依据。
 * 状态迁移由 TaskManager 的 task_started / task_completed / task_error / task_cancelled 驱动。
 */
export type VoiceWorkItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface VoiceWorkItem {
  id: string;
  title: string;
  status: VoiceWorkItemStatus;
  /** 失败原因，供 UI 显示；其余状态没有 */
  detail?: string;
}

/**
 * 发言人协议（W6）：一件活落终态后，「该念哪句、以谁的身份念」的唯一载体。
 *
 * 只在 done / failed 时产生——排队/开始跑不是结论，念了就是噪音（W6-6 门）。
 * 播不播、什么时候播由 voiceSessionService 的节制闸决定（W6-4），
 * 这里只负责把「念什么」算准。
 */
export interface VoiceWorkNarration {
  workItemId: string;
  /** 只有终态；`cancelled` 是用户自己叫停的，他知道，不用回头念给他听。 */
  status: 'done' | 'failed';
  title: string;
  /**
   * 已裁剪成「能用嘴说出来」的结论文本：代码块/表格换成一句指路，
   * 长路径只留文件名，超长截断。原文在屏幕上，不进耳朵。
   */
  summary: string;
  /**
   * 署名。**只有专家团场景才有**——无专家时 undefined，语音层用第一人称说，
   * 不冒充任何人格（W6-6 门）。
   */
  speaker?: { agentId: string; displayName: string };
}

export interface VoiceCallSummary {
  durationSec: number;
  provider: VoiceProviderId;
  conversationModel: string;
  workItemCount: number;
  startedAt: number;
  endedAt: number;
  /** 这通电话落库了多少条字幕。旧记录没有这个字段——字段缺失本身就是「旧版本通话」的判据。 */
  transcriptCount?: number;
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

/** GET /api/voice/status 的响应：LiveVoiceButton 可见性与占用态的 host 真相。 */
export interface VoiceStatusResponse {
  provider: VoiceProviderId;
  /** 所选 Provider 的 key 是否已配置（secureStorage 或 env，host 侧判） */
  configured: boolean;
  /** 全局单路互斥：当前是否有通话进行中 */
  active: boolean;
  /** 本月通话用量（只记账不设限，方案 §5.4；设置页展示用） */
  usage: { monthSeconds: number; monthCalls: number };
}

/** 设置页「实时通话」组保存后广播的窗口事件（对齐 VOICE_INPUT_SETTINGS_UPDATED_EVENT 先例）。 */
export const VOICE_LIVE_SETTINGS_UPDATED_EVENT = 'voice-live-settings-updated';

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
  /** Host 注入的 narration 在 response.create 确认窗内被上游拒绝；通话本身仍然存活。 */
  | { type: 'injection.rejected'; message: string }
  /** 语音派出的任务状态。Active Work 条消费（批 B），host 侧同时用它计通话摘要的 workItemCount。 */
  | { type: 'work.upsert'; item: VoiceWorkItem }
  /**
   * 用户可见的一次性提示（不致命，通话继续）。判据钉在上游真实回显上——
   * 例如注册了 tools 但 session.updated 回显 tools: null（模型不支持 function calling）。
   */
  | { type: 'notice'; code: VoiceMessageCode; message: string; detail?: string }
  | { type: 'error'; code: VoiceMessageCode; message: string; detail?: string };

/**
 * 发给用户看的所有提示/错误的编号（host 与 renderer 两侧都在这里登记）。**新增一条必须加进这里**——
 * renderer 的 i18n 表按这个联合类型定型（`Record<VoiceMessageCode, string>`），
 * 少写一条就是编译错误，不是「以后谁记得补翻译」。
 *
 * 为什么要有这层：host 里那几条 `message` 是硬编码中文，英文用户会原样看到中文。
 * 文案的家在 renderer 的 i18n，host 只负责说「出了哪件事」。
 * `message` 保留作日志与兜底（真出现表外 code 时总比空白强）。
 */
export type VoiceMessageCode =
  | 'VOICE_SESSION_BUSY'
  | 'VOICE_PROVIDER_UNCONFIGURED'
  | 'VOICE_TOOLS_DROPPED'
  /** 语音派出去的活死了。G1（2026-07-28 真机）：失败此前只进日志，通话里的人毫无察觉。 */
  | 'VOICE_WORK_FAILED'
  | 'VOICE_UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_SOCKET'
  | 'UPSTREAM_ERROR'
  // 以下由 renderer 侧产生（建连握手 / 重连 / 麦克风采集），同样要有文案
  | 'HANDSHAKE_FAILED'
  | 'RECONNECT_FAILED'
  | 'MICROPHONE_PERMISSION_DENIED'
  | 'AUDIO_CAPTURE_FAILED'
  | 'NATIVE_AEC_FAILED';

/**
 * 用户此刻在看什么（方案 §6.5 的 `[Context — Focus]`，批 H）。
 *
 * 字段按 **Neo 真实存在的焦点** 定义，不照抄 IDE 词汇：这个产品里没有编辑器文本选区、
 * 也没有 diff 视图，硬编出来只会让通话 brain 一本正经地说不存在的东西。
 */
export interface VoiceFocusContext {
  /** 右栏当前视图：overview / files / browser / design-canvas / preview:<path> */
  view?: string;
  /** 当前打开的文件路径（右栏 preview tab） */
  filePath?: string;
  /** 该文件处于编辑态且有未保存改动 */
  unsaved?: boolean;
  /** 实时预览里用户点选的元素描述 */
  selectedElement?: string;
}

/** Renderer → Host 的控制帧（媒体帧走二进制，不走这里）。 */
export type VoiceClientCommand =
  | { type: 'end' }
  | { type: 'interrupt' }
  /** 焦点变化上报。节流后发；host 据此增量刷新 instructions（§6.5）。 */
  | { type: 'focus'; context: VoiceFocusContext }
  /**
   * 手动提交（turn_detection = null 的 PTT/点按模式）：把缓冲音频切成一轮并请求回复。
   * server_vad 模式下上游自动断句，发这个帧是合法的 no-op 上游行为，但 Renderer 只在
   * 手动模式下发它。
   */
  | { type: 'commit' };

interface VoiceTransportHandleBase {
  readonly provider: VoiceProviderId;
  /** 打断当前回复。 */
  interrupt(): void;
  /**
   * 建连后增量刷新 instructions（焦点变化 / 切专家）。方案 §6.5 的
   * `VoiceContextAssembler` 增量 session.update；调用方负责节流。
   */
  updateInstructions(instructions: string): void;
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
      /**
       * 手动提交一轮：input_audio_buffer.commit + response.create。
       * 只在 turn_detection = null（PTT/点按）路径有意义；server_vad 路径上游自动断句。
       */
      commit(): void;
      /**
       * 把一条外部消息塞进实时会话并让模型就它开口（发言人协议回流，W6-2）。
       *
       * 走会话项而不是改 instructions：instructions 是「你是谁」，一件活的结论是
       * 「刚发生了什么」，塞进 instructions 会让它变成永久人设的一部分，下一轮还在。
       * 角色用 user 而不是 assistant——模型只会顺着自己说过的话往下说，不会去转述它。
       */
      injectItem(text: string): void;
      /** 上游已创建回复、但尚未发出对应 response.done。注入前用它避开 active response 窗口。 */
      isResponding(): boolean;
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
