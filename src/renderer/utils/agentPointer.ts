import type { ToolCall } from '@shared/contract';
import type { AgentPointerEvent } from '@shared/contract/desktop';
import {
  buildAgentPointerEventFromToolCall,
  getAgentPointerLabel,
} from '@shared/utils/agentPointer';
import { buildBrowserComputerActionPreview } from './browserComputerActionPreview';

export function buildAgentPointerEvent(
  toolCall: Pick<ToolCall, 'id' | 'name' | 'arguments' | 'result'>,
): AgentPointerEvent | null {
  const runtimeEvent = toolCall.result?.metadata?.agentPointerEvent as AgentPointerEvent | undefined;
  const base = runtimeEvent || buildAgentPointerEventFromToolCall(toolCall);
  if (!base) return null;

  const preview = buildBrowserComputerActionPreview(toolCall);
  if (!preview?.target || base.targetLabel) {
    return base;
  }

  return {
    ...base,
    targetLabel: preview.target,
  };
}

export { getAgentPointerLabel };
