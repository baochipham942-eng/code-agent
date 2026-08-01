import type { TraceTurn } from '@shared/contract/trace';
import type { StreamRecoverySnapshot } from '@shared/contract/session';
import type { Translations } from '../i18n';

export type RuntimeSessionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'queued'
  | 'cancelling'
  | 'cancelled'
  | 'error';

export type StreamingUiStatus =
  | 'idle'
  | 'drafting'
  | 'using_tools'
  | 'waiting_tool'
  | 'cancelling'
  | 'resumable'
  | 'stale'
  | 'completed'
  | 'cancelled'
  | 'blocked';

export type StreamingUiTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface StreamingUiState {
  status: StreamingUiStatus;
  label: string;
  detail: string;
  tone: StreamingUiTone;
  shouldAnimate: boolean;
  showResumeHint: boolean;
  showCancelCleanup: boolean;
}

export interface BuildStreamingUiStateInput {
  turn: TraceTurn;
  t: Translations;
  isActiveTurn: boolean;
  sessionStatus?: RuntimeSessionStatus | null;
  isSessionProcessing?: boolean;
  streamSnapshot?: StreamRecoverySnapshot | null;
  runningToolStartTime?: number;
  now?: number;
}

const TOOL_WAIT_THRESHOLD_MS = 20_000;
const STALE_STREAM_THRESHOLD_MS = 120_000;

const idleState: StreamingUiState = {
  status: 'idle',
  label: '',
  detail: '',
  tone: 'neutral',
  shouldAnimate: false,
  showResumeHint: false,
  showCancelCleanup: false,
};

/**
 * 快照是否属于「这一轮」的未完成流式。
 * snapshot.turnId 是 host 每轮流式开始时现铸的 UUID，投影 turnId 是位置序号
 * `turn-N`（useTurnProjection），两者永不相等——按 turnId 相等匹配恒 false（F4
 * 期间 banner/resumable 从不工作的根因）。重水化会把 snapshot 回填成
 * id=snapshot.turnId 的 assistant 消息（streamRecoveryMessage），所以真正的归属
 * 关系体现在投影节点上：节点 messageId / 节点 id 前缀命中 snapshot.turnId。
 */
export function hasIncompleteStreamSnapshot(
  snapshot: StreamRecoverySnapshot | null | undefined,
  turn: TraceTurn,
): boolean {
  if (snapshot?.streamStatus !== 'incomplete' || snapshot.isFinal !== false) {
    return false;
  }
  return turn.nodes.some((node) =>
    node.messageId === snapshot.turnId ||
    node.id === snapshot.turnId ||
    node.id.startsWith(`${snapshot.turnId}-`),
  );
}

export function hasCancelledRunMarker(turn: TraceTurn): boolean {
  return turn.nodes.some(
    (node) => node.metadata?.workbench?.runCancellation?.status === 'cancelled',
  );
}

function hasRunningTool(turn: TraceTurn): boolean {
  return turn.nodes.some((node) => {
    const toolCall = node.toolCall;
    if (!toolCall) return false;
    if (toolCall._streaming) return true;
    return toolCall.success === undefined && toolCall.result === undefined;
  });
}

export function buildStreamingUiState({
  turn,
  t,
  isActiveTurn,
  sessionStatus = null,
  isSessionProcessing = false,
  streamSnapshot = null,
  runningToolStartTime,
  now = Date.now(),
}: BuildStreamingUiStateInput): StreamingUiState {
  if (sessionStatus === 'cancelling') {
    return {
      status: 'cancelling',
      label: t.turnRun.status.cancelling,
      detail: t.turnRun.detail.cancelling,
      tone: 'warning',
      shouldAnimate: true,
      showResumeHint: false,
      showCancelCleanup: true,
    };
  }

  if (turn.status === 'error' || sessionStatus === 'error') {
    return {
      status: 'blocked',
      label: t.turnRun.status.blocked,
      detail: t.turnRun.detail.blocked,
      tone: 'error',
      shouldAnimate: false,
      showResumeHint: false,
      showCancelCleanup: false,
    };
  }

  // 会话仍在处理中时，被中断轮已由 drafting/using_tools 等活跃状态表达，partial 也
  // 已回填上屏并在续跑——snapshot 只在流真正断掉（会话不再处理）时才升级为 resumable。
  if (sessionStatus === 'paused' || (!isSessionProcessing && hasIncompleteStreamSnapshot(streamSnapshot, turn))) {
    return {
      status: 'resumable',
      label: t.turnRun.status.resumable,
      detail: t.turnRun.detail.resumable,
      tone: 'warning',
      shouldAnimate: false,
      showResumeHint: true,
      showCancelCleanup: false,
    };
  }

  if (sessionStatus === 'cancelled' || hasCancelledRunMarker(turn)) {
    return {
      status: 'cancelled',
      label: t.turnRun.status.cancelled,
      detail: t.turnRun.detail.cancelled,
      tone: 'warning',
      shouldAnimate: false,
      showResumeHint: false,
      showCancelCleanup: false,
    };
  }

  const streaming = turn.status === 'streaming';
  const runningTool = hasRunningTool(turn);
  if (streaming && runningTool) {
    const isWaitingTool =
      typeof runningToolStartTime === 'number' &&
      now - runningToolStartTime >= TOOL_WAIT_THRESHOLD_MS;
    return {
      status: isWaitingTool ? 'waiting_tool' : 'using_tools',
      label: isWaitingTool ? t.turnRun.status.waitingTool : t.turnRun.status.usingTools,
      detail: isWaitingTool ? t.turnRun.detail.waitingTool : t.turnRun.detail.usingTools,
      tone: 'neutral',
      shouldAnimate: true,
      showResumeHint: false,
      showCancelCleanup: false,
    };
  }

  if (streaming && isActiveTurn) {
    return {
      status: 'drafting',
      label: t.turnRun.status.running,
      detail: t.turnRun.detail.running,
      tone: 'info',
      shouldAnimate: true,
      showResumeHint: false,
      showCancelCleanup: false,
    };
  }

  if (
    streaming &&
    isSessionProcessing &&
    now - turn.startTime >= STALE_STREAM_THRESHOLD_MS
  ) {
    return {
      status: 'stale',
      label: t.turnRun.status.stale,
      detail: t.turnRun.detail.stale,
      tone: 'neutral',
      shouldAnimate: false,
      showResumeHint: false,
      showCancelCleanup: false,
    };
  }

  if (turn.status === 'completed') {
    return {
      status: 'completed',
      label: t.turnRun.status.completed,
      detail: '',
      tone: 'success',
      shouldAnimate: false,
      showResumeHint: false,
      showCancelCleanup: false,
    };
  }

  return idleState;
}

export function shouldShowStreamingState(state: StreamingUiState): boolean {
  return state.status !== 'idle'
    && state.status !== 'completed'
    && state.status !== 'drafting'
    && state.status !== 'using_tools'
    && state.status !== 'waiting_tool'
    // 取消中不再单独铺一张横幅：顶部 run 徽章已经在说「正在停止 · 本轮已取消」，
    // 底下再来一张大黄卡写「正在清理本轮流式输出和未完成工具」，是同一件事说两遍，
    // 而取消本身只持续几秒——动静远大于信息量（真机反馈 2026-08-01）。
    && state.status !== 'cancelling';
}
