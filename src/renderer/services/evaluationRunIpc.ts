import type {
  EvaluationRunIpcEventHandlers,
  EvaluationRunIpcInvokeHandlers,
} from '@shared/ipc';

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
