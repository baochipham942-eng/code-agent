// voiceSessionService 的会话形状（N-MAXLINES-MINEFIELD-2-FU1-S3 逐字拆出）。
// 行为零变化，只做代码搬家。
import type { WebSocket as WsSocket } from 'ws';
import type { VoiceFocusContext, VoiceTokenUsage, VoiceTransportHandle } from '../../../shared/contract/voice';
import type { VoiceContinuityContext } from './voiceContextAssembler';
import type { VoiceInterruptCandidate } from './voiceInterruptCandidates';
import type { NarrationState } from './voiceNarrationQueue';
import type { NarrationResponseLedger } from './voiceNarrationTranscript';
import type { TranscriptMergeState } from './voiceTranscriptPersistence';
import type { VoiceprintCallState } from './voiceprintService';
import type { VoiceCallRecorder } from './voiceCallRecorder';
import type { VoiceSayDoGuard } from './voiceSayDoGuard';

/** 读设置页「实时通话」组；读不到一律 undefined（= 全部走默认），绝不让设置读写炸掉通话。 */
export interface ActiveSession {
  id: string;
  neoSessionId: string;
  startedAt: number;
  /**
   * 当前这条 Renderer WS。重连会**换掉它**而不换通话——所以上游回调必须通过这个
   * 可变引用发，不能闭包捕获建连那一刻的 socket。
   */
  clientRef: { current: WsSocket };
  upstream: VoiceTransportHandle;
  /** 上游是否真实收下了通话工具；VOICE_TOOLS_DROPPED 后 fail-closed。 */
  voiceToolsAvailable: boolean;
  /** 用户轮、工具账本与语义审计状态；只活在本通电话内。 */
  sayDoGuard: VoiceSayDoGuard;
  /** teardown 已开始时，新的打字注入必须回退，不能再抢这通电话。 */
  ending: boolean;
  maxDurationTimer: NodeJS.Timeout;
  /** 非 null = 客户端断了，正在宽限窗里等它回来 */
  graceTimer: NodeJS.Timeout | null;
  /** relay 媒体面首帧健康探针；重连沿用同一份计数，不重复报警。 */
  inboundAudioFrames: number;
  inboundAudioWatchdogTimer: NodeJS.Timeout | null;
  /** 本次通话派出去的任务数，进通话摘要 */
  workItemCount: number;
  /** 本次通话成功落库的字幕条数，进通话摘要（旧记录没有 = 旧版本通话的判据） */
  transcriptCounter: { count: number };
  /** 助手字幕按 response 隔离；旧轮晚到不能拼进下一轮。 */
  transcriptBuf: { assistantByResponse: Map<string, string> };
  /** 上一条落库的用户字幕，供 R5 连续字幕并入上一条 */
  transcriptMerge: TranscriptMergeState;
  /** 通话身份的短人设，焦点刷新时要和 Focus 段一起重拼；userProfile 同样受声纹闸保护。 */
  personaInstructions: string; userProfile: string;
  /** 当前已下发给上游的完整 instructions，用于语速/焦点刷新去重。 */
  instructions: string;
  /** 本次通话真用的上游模型（设置白名单解析后），挂断摘要如实记它 */
  conversationModel: string;
  /** 新拨号时从 DB + TaskManager 取到的上一通上下文；焦点刷新重拼 instructions 时必须保留。 */
  continuity: VoiceContinuityContext | null;
  /** 用户此刻在看什么（Renderer 节流上报） */
  focus: VoiceFocusContext | null;
  interruption: {
    currentCandidateId: string | null;
    candidates: Map<string, VoiceInterruptCandidate>;
  };
  /** 上游 cancel 后仍可能把旧 delta/final/done 发完；Host 与 Renderer 各自 fail-closed。 */
  cancelledResponseIds: Set<string>;
  /** assistant final 先暂存，到 response.done 且未取消时才落库。 */
  pendingAssistantFinals: Map<string, { text: string; itemId?: string }>;
  /** 注入播报的 responseId → narrationId/source message，供主消息流去重与三 ID 留证。 */
  narrationResponses: NarrationResponseLedger;
  /** 一通电话可有多轮 response；排水窗结束前到达的 provider usage 都归入本通。 */
  tokenUsage: { value?: VoiceTokenUsage; accepting: boolean };
  /** 终态播报只属于这通电话：压住、去重与已播记录都随 active 一起销毁。 */
  narration: NarrationState;
  /** 声纹身份（N-L7-SPK）：全内存，teardown 即丢。生命周期与判定语义见 voiceprintService。 */
  speaker: VoiceprintCallState;
  /** 通话录音（N-L7-REC）：开关关（默认）时为 null；teardown 时收尾并跑一次三重上限。 */
  recorder: VoiceCallRecorder | null;
}
