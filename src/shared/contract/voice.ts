// ============================================================================
// 实时语音（Realtime Voice）合同
//
// 已落地 Qwen-Omni（WebSocket 流式，Host 持 key + 内存中继 = relay 形态）。
// VoiceTransport 的签名同时为 OpenAI WebRTC 形态（direct）留了形状：connect()
// 返回判别联合的 handle——relay 侧必须实现 sendAudio（媒体经 Host），direct 侧
// 必须给出 clientBootstrap（ephemeral client secret + SDP 交换信息，Renderer
// 直连上游）。见方案 §9.1/§9.2 与 §13.3 第 1 条。
// ============================================================================

export type VoiceProviderId = 'qwen-omni' | 'dashscope-qwen-omni' | 'openai-realtime' | (string & {});

export type VoiceTurnDetectionConfig =
  | { type: 'server_vad'; threshold?: number; prefixPaddingMs?: number; silenceDurationMs?: number }
  | { type: 'semantic_vad'; eagerness?: 'low' | 'medium' | 'high' | 'auto' }
  | null;

/**
 * 派活失败的结构化成因。生产者在 throw 处带上，一路带到用户可见文案的统一出口
 * （describeWorkFailure）——认不出的一律走兜底，绝不从 detail 文本反推。
 */
export type VoiceWorkFailureMarker =
  | import('./project').ProjectSourceTrustFailureMarker
  | import('./model').ModelAuthFailureMarker;

/**
 * 通话里派出的一件活。
 *
 * Phase 2 批 H 补齐全生命周期：此前只有 queued / failed 两态——run 干完了不发任何事件，
 * Active Work 条上它永远停在「排队中」，通话 brain 也拿不到「做完了」的依据。
 * 状态迁移由 TaskManager 的 task_started / task_completed / task_error / task_cancelled 驱动。
 */
/**
 * `unverified`（X5.5-A2）：run 正常跑完，但这一轮**没留下任何产物证据**
 * （没改文件、没产出工件、没跑过通过的校验命令）。
 *
 * 「派活成功 ≠ 用户目标完成」——run 终态只证明循环退出了，不证明用户要的事做成了。
 * 模型最后那句「已经建好了」不算证据，它正是要防的那样东西。所以 done 与 unverified
 * 之间只有一条判据：ADR-050 意义上的机器产物证据（见 voiceWorkEvidence.ts）。
 */
export type VoiceWorkItemStatus = 'queued' | 'running' | 'done' | 'unverified' | 'failed' | 'cancelled';

export interface VoiceWorkItem {
  id: string;
  title: string;
  status: VoiceWorkItemStatus;
  /** 失败原因，供 UI 显示；其余状态没有 */
  detail?: string;
  /** 自有错误生产者给出的稳定分类；不从 detail 文本反推。 */
  failure?: VoiceWorkFailureMarker;
}

/**
 * 发言人协议（W6）：一件活落终态后，「该念哪句、以谁的身份念」的唯一载体。
 *
 * 只在终态或「用户刚要求的那个动作办完了」时产生——排队/开始跑不是结论，念了就是噪音（W6-6 门）。
 * 播不播、什么时候播由 voiceSessionService 的节制闸决定（W6-4），
 * 这里只负责把「念什么」算准。
 */
export interface VoiceWorkNarration {
  workItemId: string;
  /**
   * 终态三档 + 一档播报。
   *
   * 终态：`cancelled` 是用户自己叫停的，他知道，不用回头念给他听。
   * `unverified` 必须自成一档而不是并进 done——耳朵这一路和屏幕那一路要么一起说实话，
   * 要么就是「卡片写着待核验、耳机里说已经做完了」。
   *
   * `announcement`（§1 打断异步确认）不是某件活的结局，是「刚才那个动作办完了没有」的
   * 回报（停稳了 / 没停稳 / 停稳后新活开始了）。它复用同一条注入通道与节制闸，所以
   * 走同一个类型；台词整句由 voiceNarration 的 buildStopNarration 算好放进 `summary`，
   * formatNarration 不再按状态拼词——**避免同一句话的措辞散在两个模块里各写一半**。
   *
   * `milestone`（§2 中途进度）与 announcement 的区别**不在措辞，在过期语义**——
   * 它是过程量：被压住一分钟之后再播，说的是一分钟前的事，而用户关心的是现在。
   * 所以节制闸对它多三条规矩：每件活最多三条、间隔下限、用户一开口就把排队的**全部丢掉**
   * （终态只排队不丢）。单独成档就是为了让闸能一眼判出「这条过期了能丢」。
   */
  status: 'done' | 'unverified' | 'failed' | 'announcement' | 'milestone';
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
  /**
   * 执行侧标记「这条值得听」（R3）。**只加权，不新开出口**——带标记的仍是一条
   * `milestone`，仍然走同一条队列、同一个注入通道，只是节制闸对它松两格：
   * 可以豁免首条延迟窗与最小间隔，per-item 上限允许超一格（超额必留痕）。
   *
   * **绝不豁免 userSpeaking 抢占**：用户正在说话时它照样被压住 / 被丢弃。
   * 「重要」是相对其它播报而言的，不是相对用户而言的——插用户的话没有任何一档重要性
   * 配得上。这条是本标记的硬边界，改了它这个功能就从「让转折被听见」变成「抢麦」。
   *
   * 什么才配打这个标记见 voiceAgentCoordinator 的打标处：默认不标，只有
   * 「方案不可行 / 要花钱 / 被外部阻塞 / 需要用户决策」这类转折才标。
   */
  worthHearing?: true;
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

export type VoiceCallFailureCode =
  | 'VOICE_UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_SOCKET'
  | 'UPSTREAM_ERROR'
  | 'VOICE_PROVIDER_UNCONFIGURED'
  | 'VOICE_SESSION_BUSY'
  | 'HANDSHAKE_FAILED'
  | 'RECONNECT_FAILED';

export type VoiceCallFailurePhase =
  | 'admission'
  | 'configuration'
  | 'handshake'
  | 'upstream'
  | 'reconnect';

/** Renderer 只能上报自身产生、且媒体 WS 已不可用的两种拨号失败。 */
export interface RendererVoiceFailureReport {
  neoSessionId: string;
  code: 'HANDSHAKE_FAILED' | 'RECONNECT_FAILED';
  phase: 'handshake' | 'reconnect';
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

export type VoiceInterruptClassification =
  | 'pending'
  | 'no_playback'
  | 'background'
  | 'acknowledgement'
  | 'supplement'
  | 'short_fragment'
  | 'true_interrupt';

/** Provider 在 response.done 上报的 token 用量，统一成与协议字段名无关的内部形状。 */
export interface VoiceTokenUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  inputAudioTokens: number;
  inputTextTokens: number;
  outputAudioTokens: number;
  outputTextTokens: number;
}

/** GET /api/voice/status 的响应：LiveVoiceButton 可见性与占用态的 host 真相。 */
export interface VoiceStatusResponse {
  provider: VoiceProviderId;
  /** 所选 Provider 的 key 是否已配置（secureStorage 或 env，host 侧判） */
  configured: boolean;
  /** 全局单路互斥：当前是否有通话进行中 */
  active: boolean;
  /** 本月通话用量（只记账不设限，方案 §5.4；设置页展示用） */
  usage: {
    monthSeconds: number;
    monthCalls: number;
    monthFailedAttempts: number;
    /** 可缺失：存量账本没有 token 字段，上游没报告 usage 时也不伪造 0。 */
    monthTokens?: VoiceTokenUsage;
  };
}

/** 设置页「实时通话」组保存后广播的窗口事件（对齐 VOICE_INPUT_SETTINGS_UPDATED_EVENT 先例）。 */
export const VOICE_LIVE_SETTINGS_UPDATED_EVENT = 'voice-live-settings-updated';

/** 上游 → Host 归一化后的事件。Renderer 只认这一套，换 provider 不改前端。 */
export type VoiceEvent =
  | { type: 'state'; state: 'connecting' | 'live' | 'closed' }
  /** 通话自然结束；与需要用户处理的 error 分流。 */
  | { type: 'session.ended'; reason: 'idle-timeout' }
  /** 用户说的话（上游 ASR），final 时 done=true */
  | { type: 'user.transcript'; text: string; done: boolean; itemId?: string; candidateId?: string }
  /** 助手说的话的字幕 */
  | { type: 'assistant.transcript'; text: string; done: boolean; responseId?: string; itemId?: string }
  | { type: 'response.created'; responseId: string; narrationId?: string }
  | { type: 'response.cancelled'; responseId: string; reason: 'interrupt' }
  /** 声学 onset 只是候选：Renderer 暂停播放，语义闸决策后再恢复或丢弃。 */
  | { type: 'speech.started'; candidateId?: string }
  | { type: 'speech.stopped'; candidateId?: string; durationMs: number }
  | {
      type: 'interrupt.decision';
      candidateId: string;
      classification: VoiceInterruptClassification;
      action: 'resume' | 'cancel_discard';
      responseId?: string;
    }
  | {
      type: 'response.done';
      responseId?: string;
      ttfaModelMs?: number;
      ttfaPerceivedMs?: number;
      /** 可缺失：上游未给或形状不认识时不把未知写成 0。 */
      usage?: VoiceTokenUsage;
    }
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
  | 'VOICE_MODEL_UNRESPONSIVE'
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
  | {
      type: 'interrupt.playback';
      candidateId: string;
      playing: boolean;
      playedMs: number;
      queuedMs: number;
    }
  /** Renderer 的播放管线已经接收该播报的首帧；Host 以此作为送达确认。 */
  | { type: 'narration.playback_started'; narrationId: string }
  /** 焦点变化上报。节流后发；host 据此增量刷新 instructions（§6.5）。 */
  | { type: 'focus'; context: VoiceFocusContext }
  /**
   * 手动提交（turn_detection = null 的 PTT/点按模式）：把缓冲音频切成一轮并请求回复。
   * server_vad 模式下上游自动断句，发这个帧是合法的 no-op 上游行为，但 Renderer 只在
   * 手动模式下发它。
   */
  | { type: 'commit' }
  /**
   * 音频管线诊断上报（批 X §5）：Renderer 走了哪条采集管线、为什么。
   * 原生 AEC 的降级链此前全程零日志（start 失败被 catch 吞掉、renderer logger 只进
   * console），真机「AEC 没起来」在 host 日志里查不到任何痕迹。host 收到只落日志。
  */
  | { type: 'audio_mode'; mode: 'native_aec' | 'headphones'; reason: string }
  /** 原生 AEC sidecar 的受控生命周期诊断码；不传音频、字幕或本地路径。 */
  | { type: 'audio_diagnostic'; code: string };

/** Renderer 忙态打字注入通话的 host 决策。fallback 由 renderer 复用 durable queue。 */
export type VoiceUserTextInjectionResult =
  | { outcome: 'injected' }
  | {
      outcome: 'fallback';
      reason:
        | 'empty_text'
        | 'no_active_call'
        | 'tools_unavailable'
        | 'transport_unavailable'
        | 'injection_rejected';
    };

interface VoiceTransportHandleBase {
  readonly provider: VoiceProviderId;
  /** 打断当前回复，并返回被取消的上游 response identity。 */
  interrupt(): string | null;
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
       * server VAD 只切轮，不自动建回复；Host 在 final 语义决策后显式调用。
       * instructions 只约束这一次 response，避免取消后的旧回复目标压过最新用户要求。
       */
      respond(instructions?: string): void;
      /**
       * 把一条外部消息塞进实时会话并让模型就它开口（发言人协议回流，W6-2）。
       *
       * 走会话项而不是改 instructions：instructions 是「你是谁」，一件活的结论是
       * 「刚发生了什么」，塞进 instructions 会让它变成永久人设的一部分，下一轮还在。
       * 角色用 user 而不是 assistant——模型只会顺着自己说过的话往下说，不会去转述它。
      */
      injectItem(text: string, narrationId?: string): void;
      /**
       * 注入一条外部用户文字并等待上游确认 response.create 已被接受。
       * 只有 relay transport 提供这个确认面；拒绝或挂断会 reject，调用方必须回退，不能丢话。
       */
      injectItemWithAck?: (text: string) => Promise<void>;
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
