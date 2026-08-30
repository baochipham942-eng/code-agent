import type {
  EvalCaseListItem,
  EvalExperimentDetail,
  EvalExperimentListItem,
  EvalRunEvent,
  EvalRunPanelProbe,
  EvalRunRequest,
  EvalRunStartResult,
  EvalRunSubscriptionResult,
  EvalScorersOverview,
  SaveEvalCaseRequest,
  SaveEvalCaseResult,
} from '@shared/contract/evaluation';
import { EVALUATION_CHANNELS } from '../shared/evaluationChannels';

interface EvaluationRunIpcInvokeHandlers {
  [EVALUATION_CHANNELS.RUN_SUITE]: (payload: EvalRunRequest) => Promise<EvalRunStartResult>;
  [EVALUATION_CHANNELS.RUN_EVENTS]: (payload?: { runId?: string }) => Promise<EvalRunSubscriptionResult | EvalRunPanelProbe>;
  [EVALUATION_CHANNELS.ABORT_RUN]: (payload: { runId: string }) => Promise<{ runId: string; pid: number; terminated: boolean }>;
  [EVALUATION_CHANNELS.SCORERS_OVERVIEW]: () => Promise<EvalScorersOverview>;
  [EVALUATION_CHANNELS.LIST_EXPERIMENTS]: (payload?: { limit?: number }) => Promise<EvalExperimentListItem[]>;
  [EVALUATION_CHANNELS.LOAD_EXPERIMENT]: (experimentId: string) => Promise<EvalExperimentDetail | null>;
  [EVALUATION_CHANNELS.LIST_CASES]: () => Promise<EvalCaseListItem[]>;
  [EVALUATION_CHANNELS.SAVE_CASE]: (request: SaveEvalCaseRequest) => Promise<SaveEvalCaseResult>;
}

interface EvaluationRunIpcEventHandlers {
  [EVALUATION_CHANNELS.RUN_EVENTS]: (event: EvalRunEvent) => void;
}

type EvaluationRunInvoker = <K extends keyof EvaluationRunIpcInvokeHandlers>(
  channel: K,
  ...args: Parameters<EvaluationRunIpcInvokeHandlers[K]>
) => ReturnType<EvaluationRunIpcInvokeHandlers[K]>;

type EvaluationRunEventSubscriber = <K extends keyof EvaluationRunIpcEventHandlers>(
  channel: K,
  callback: EvaluationRunIpcEventHandlers[K],
) => (() => void) | undefined;

function commandApi() {
  return window.codeAgentAPI || window.electronAPI;
}

export function invokeEvaluation<K extends keyof EvaluationRunIpcInvokeHandlers>(
  channel: K,
  ...args: Parameters<EvaluationRunIpcInvokeHandlers[K]>
): ReturnType<EvaluationRunIpcInvokeHandlers[K]> {
  const rawInvoke = commandApi()?.invoke as EvaluationRunInvoker | undefined;
  return rawInvoke?.(channel, ...args) as ReturnType<EvaluationRunIpcInvokeHandlers[K]>;
}

export function onEvaluation<K extends keyof EvaluationRunIpcEventHandlers>(
  channel: K,
  callback: EvaluationRunIpcEventHandlers[K],
): (() => void) | undefined {
  const rawSubscribe = commandApi()?.on as EvaluationRunEventSubscriber | undefined;
  return rawSubscribe?.(channel, callback);
}
