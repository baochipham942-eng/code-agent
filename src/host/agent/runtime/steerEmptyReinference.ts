import type { ModelResponse } from '../../agent/loopTypes';
import type { ControlState } from './controlState';

const EMPTY_REINFERENCE_ERROR = '你刚发来的新消息之后，没有得到回复，也没有继续调用工具。这一轮已停止，不会接着执行被换掉的计划。';

/**
 * 转向后的第一次再推理。仍带着 needsReinference 的那一次是被打断的在途推理，
 * 不消费这个标记。空卷清掉强制收尾，避免撞顶时合成「已完成」。
 */
export function takeSteerEmptyReinferenceFailure(
  control: Pick<ControlState, 'emptyReinferenceAfterSteer' | 'clearEmptyReinferenceAfterSteer' | 'clearForceFinalResponse'>,
  interruptedInference: boolean,
  response: Pick<ModelResponse, 'content' | 'toolCalls'>,
): Error | null {
  if (!control.emptyReinferenceAfterSteer) return null;
  if (interruptedInference) return null;
  const hasText = typeof response.content === 'string' && response.content.trim().length > 0;
  const hasTools = (response.toolCalls?.length ?? 0) > 0;
  control.clearEmptyReinferenceAfterSteer();
  if (hasText || hasTools) return null;
  control.clearForceFinalResponse();
  return new Error(EMPTY_REINFERENCE_ERROR);
}
