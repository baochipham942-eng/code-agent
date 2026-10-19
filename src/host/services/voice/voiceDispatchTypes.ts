// voiceAgentCoordinator 的类型层（N-MAXLINES-MINEFIELD-2-FU1-S3 逐字拆出）：Intent、
// 派活绑定与账本形状。行为零变化，只做代码搬家。
import type { TaskManagerEvent } from '../../task/TaskManager';
import type { ToolResult } from '../../../shared/contract';
import type { VoiceFocusContext, VoiceToolCallOrigin, VoiceWorkItem, VoiceWorkItemStatus, VoiceWorkNarration } from '../../../shared/contract/voice';
import type { AppshotCapture } from '../../../shared/contract/appshot';
import type { VoiceTranscriptEntry } from './voiceTranscriptHandoff';
import type { VoiceSpawnRequest } from './voiceSpawnRequest';
import type { VoiceTaskSlotLedger } from './voiceTaskSlotLedger';
import type { getVoiceTaskManager } from './voiceTaskManagerBridge';

/** 方案 §6.3。share_context 归批 H 的焦点上报（文本焦点，不含像素）。 */
export type VoiceIntent = { origin?: VoiceToolCallOrigin } & (
  | { kind: 'status' }
  | { kind: 'recent_files' }
  /**
   * 看屏（Appshots Phase 3）：采一张用户此刻的屏幕，**不给通话 brain 看**，
   * 挂在账本上等下一次派活捎给执行侧。通话 brain 零写权限的底线没变——
   * 这个动作只往临时目录写一张自己的截图，不碰用户的任何文件。
   */
  | { kind: 'capture_screen' }
  /**
   * `replaceCurrent`：用户说的是「别等 X 了，改做 Y」——弃掉手上那件、换成这件。
   * 与 steer_task（改方向、不弃活）是两件事，路由判别写在 voiceRouting 的 prompt 里。
   */
  | {
      kind: 'delegate_task';
      title: string;
      prompt: string;
      shortName?: string;
      laneKey?: string;
      submissionKey?: string;
      replaceCurrent?: boolean;
    }
  /**
   * `target`：用户点名了要作用在哪一件活上（task_status 列出的编号）。
   * 不给 = 手上正在跑的那件（原语义，零行为变化）。给了但对不上就拒绝，见 rejectMismatchedTarget。
   */
  | { kind: 'steer_task'; instruction: string; target?: string }
  | { kind: 'cancel_task'; target?: string }
  | { kind: 'end_call' }
  | { kind: 'current_time' }
);

export interface VoiceDispatchBinding {
  neoSessionId: string;
  /**
   * 这通电话的 id（`voice-<ts>-<seq>`，合成串不含用户内容）。
   * 只作遥测/日志维度：看屏这类动作发生在派活**之前**，没有 workItemId 可挂，
   * 不给它一个维度就等于这条链在观测上不存在。
   */
  voiceSessionId: string;
  /** 派活时带上的专家身份；undefined = 会话默认 agent（自动路由） */
  activeAgentId?: string;
  /** work item 变化推给 Renderer 的 Active Work 条 */
  onWorkItem: (item: VoiceWorkItem) => void;
  /**
   * 一件活落到 failed。与 onWorkItem **不同寿命**：`onWorkItem` 是通话态的 UI 回流，
   * 挂断即断（emit 置 null）；失败留痕必须活到最后一件活落地——语音派出的 run 常常
   * 比通话活得久，而「挂断之后才死」正是最需要留痕的场景（G1，2026-07-28）。
   */
  onWorkFailed: (item: VoiceWorkItem) => void;
  /**
   * 模型自己收线（end_call 工具）。真机 2026-07-28：用户说「挂断当前通话」，
   * 模型答「好，通话已挂断」——而日志里 `reason: client-end` 说明是用户自己点的 X，
   * 模型只是嘴上说。语音层此前压根没有挂断这个动作，这是第二例「说了没做」。
   */
  onEndCall: () => void;
  /**
   * 发言人协议（W6-1）：一件活落 done/failed 时「该念哪句、以谁的身份念」。
   *
   * 与 onWorkItem **同寿命**（挂断即断）而不是跟着 onWorkFailed：电话都挂了，
   * 念给谁听。挂断之后才死的那种失败仍走 onWorkFailed 落屏，不重复。
   */
  onWorkNarration: (narration: VoiceWorkNarration) => void;
}

export const TERMINAL: readonly VoiceWorkItemStatus[] = ['done', 'unverified', 'failed', 'cancelled'];

/**
 * 一次「先把手上那件停下来」的在途请求（§1 打断原子性）。
 *
 * 存在的唯一理由是那道硬门：**确认旧的落终态之前，绝不 startRun**。所以「要停谁」
 * 和「停稳之后要派什么」必须一起记着，等终态事件来了在同一处兑现——把它拆成
 * 「先 cancel，然后在别处 setTimeout 里派新活」就等于把门开在两个地方。
 */
export interface PendingStop {
  /** 正在等它落终态的那件活 */
  workItemId: string;
  /** 那件活的标题，超时回报时要说清是谁没停稳 */
  title: string;
  /** 停稳后要派的新活；undefined = 纯 cancel_task，不派新活 */
  next?: VoiceSpawnRequest;
  timer: NodeJS.Timeout;
  /** 已重发 cancel 的次数，上限 VOICE_STOP_CONFIRM_RETRIES */
  attempts: number;
}

export interface LedgerState {
  neoSessionId: string;
  voiceSessionId: string;
  activeAgentId?: string;
  /** 通话挂断后置 null：只记账、不再往已关闭的 WS 推。 */
  emit: ((item: VoiceWorkItem) => void) | null;
  /** 失败留痕；**挂断不清**（见 VoiceDispatchBinding.onWorkFailed）。 */
  onFailed: (item: VoiceWorkItem) => void;
  /** 终态回流；与 emit 同寿命，挂断置 null。 */
  narrate: ((narration: VoiceWorkNarration) => void) | null;
  endCall: () => void;
  items: Map<string, VoiceWorkItem>;
  slots: VoiceTaskSlotLedger;
  runRequests: Map<string, VoiceSpawnRequest>;
  pendingStartedAtById: Map<string, number>;
  runConclusions: Map<string, { content: string; messageId: string }>;
  runToolResults: Map<string, ToolResult[]>;
  /** 兼容旧 runtime 不带 taskId 的事件；生产后台 run 一律按事件里的 taskId 路由。 */
  legacyEventFallbackId: string | null;
  /** 旧事件兼容任务的派出时刻；真实任务使用 pendingStartedAtById。 */
  legacyEventFallbackStartedAt: number;
  listener: (event: TaskManagerEvent) => void;
  listenerAttached: boolean;
  /** 绑定 listener 的确切实例；解绑必须回到同一个 manager，避免跨 dispatch 串台。 */
  taskManagerRef: Awaited<ReturnType<typeof getVoiceTaskManager>> | null;
  /** 用户此刻在看什么（§6.5 焦点上报）；决定 get_current_file_summary 答什么。 */
  focus: VoiceFocusContext | null;
  /** 近窗字幕原文（voiceSessionService 每落一条 final 就推一次），派活时随 run 一起交给执行侧。 */
  transcript: VoiceTranscriptEntry[];
  /**
   * 已经采到、还没跟着任何一次派活出去的屏幕截图（Phase 3）。
   *
   * **一次性**：附到某一轮 run 上就清掉。不这么做的话，用户指过一次屏，之后每一件活
   * 都会拖着同一张旧图——执行侧会拿它当「用户现在看的东西」，那是在悄悄喂错事实。
   */
  pendingScreen: AppshotCapture | null;
  /** 在途的「停旧的」请求；同时只可能有一件（通话是单路，手上也只有一件活）。 */
  pendingStops: Map<string, PendingStop>;
  /**
   * 被顶掉的活：终态**不念给用户听**（他刚亲口说「别做那个了」，回头再播一遍它的结局
   * 是噪音）。只压播报——onWorkFailed 留痕与落库照旧，屏幕那一路仍然说实话。
   * 停不下来时会从这里移除：那件活还活着，它的结局就还该被念。
   */
  supersededIds: Set<string>;
  /**
   * 上一次看到的 plan entries 快照（按 content 索引 status）。milestone 靠它做差分。
   *
   * 用 content 当键是因为 `TodoItem` 没有 id（`{content, status, activeForm}`）。
   * 同一轮里两条同文案的 entry 会被折成一条——可接受:代价是少播一条进度,
   * 而不是播一条错的。
   */
  todoSnapshots: Map<string, Map<string, string>>;
  /**
   * 上一次看到的执行侧任务轨快照（按 task id 索引 status）。worth-hearing 靠它认
   * 「刚刚卡住」这个跃迁——task_update 每次带全量列表，不做差分就会把同一条卡点
   * 在后续每个事件里反复念一遍。
   */
  taskSnapshots: Map<string, Map<string, string>>;
  /** milestone 去重键的单调计数器。注入通道按 workItemId 去重，撞键就会静默丢播报。 */
  milestoneSeqById: Map<string, number>;
  /** 同一审批可能从实时、SSE replay、host snapshot 多次到达；电话里只告知一次。 */
  announcedPermissionRequestIds: Set<string>;
  /** agent 事件流的退订函数；与 listener 同寿命，落终态时一起摘。 */
  unobserveAgentEvents: (() => void) | null;
}

/** 会被念出来 / 落屏 / 发通知的那三档终态。cancelled 不在其中（用户自己叫停的）。 */
export type SettledOutcome = 'done' | 'unverified' | 'failed';
