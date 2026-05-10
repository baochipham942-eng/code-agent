import type { TraceTurn } from '@shared/contract/trace';
import type { StreamRecoverySnapshot } from '@shared/contract/session';

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

export function hasIncompleteStreamSnapshot(
  snapshot: StreamRecoverySnapshot | null | undefined,
  turnId: string,
): boolean {
  return Boolean(
    snapshot?.turnId === turnId &&
      snapshot.streamStatus === 'incomplete' &&
      snapshot.isFinal === false,
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
      label: '取消中',
      detail: '正在清理本轮流式输出和未完成工具',
      tone: 'warning',
      shouldAnimate: true,
      showResumeHint: false,
      showCancelCleanup: true,
    };
  }

  if (turn.status === 'error' || sessionStatus === 'error') {
    return {
      status: 'blocked',
      label: '已阻塞',
      detail: '本轮运行遇到错误，等待恢复或重新执行',
      tone: 'error',
      shouldAnimate: false,
      showResumeHint: false,
      showCancelCleanup: false,
    };
  }

  if (sessionStatus === 'paused' || hasIncompleteStreamSnapshot(streamSnapshot, turn.turnId)) {
    return {
      status: 'resumable',
      label: '可恢复',
      detail: '上次流式输出未完成，可从会话操作里继续',
      tone: 'warning',
      shouldAnimate: false,
      showResumeHint: true,
      showCancelCleanup: false,
    };
  }

  if (sessionStatus === 'cancelled' || hasCancelledRunMarker(turn)) {
    return {
      status: 'cancelled',
      label: '已取消',
      detail: '本轮流式输出已停止，未保留半截内容',
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
      label: isWaitingTool ? '工具等待中' : '正在使用工具',
      detail: isWaitingTool ? '工具调用仍在返回结果' : '工具调用已开始，结果会并入当前回复',
      tone: 'warning',
      shouldAnimate: true,
      showResumeHint: false,
      showCancelCleanup: false,
    };
  }

  if (streaming && isActiveTurn) {
    return {
      status: 'drafting',
      label: '生成草稿中',
      detail: '内容正在流式写入当前回复',
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
      label: '旧流状态',
      detail: '保留现场但不重复播放旧内容',
      tone: 'neutral',
      shouldAnimate: false,
      showResumeHint: false,
      showCancelCleanup: false,
    };
  }

  if (turn.status === 'completed') {
    return {
      status: 'completed',
      label: '已完成',
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
    && state.status !== 'drafting';
}
