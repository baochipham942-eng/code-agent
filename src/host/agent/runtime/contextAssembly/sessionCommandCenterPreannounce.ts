import { extractUserRequest } from '../../turnScaffold';
import type { ModelResponse } from '../../loopTypes';

export interface CommandCenterToolStartInput {
  toolName?: string;
  commandCenterEnabled: boolean;
  streamedContent: string;
  existingPreannounce: string;
  userMessage: string;
  emitPreview(text: string): void;
  emitToolStart(): void;
}

// N-FIX-DELEGATE-PREANNOUNCE-GARBLED rework r2（台账③）：extractUserRequest 的契约是
// 「整条消息以 </user_request> 收尾 + 行首开始标签」才算包装，其余形状原样返回。凡是它
// 没能可靠剥出原话的形状（结束标签后还有内容、嵌套包装、只有脚手架块没有包装），返回值
// 会带着轮首系统块的标签或包装标签本身。这时宁可说固定句，也不把脚手架残片当任务转述。
// 只认这三种标签（台账点名的判定集）：包装标签本身 + 候选能力块头。生产面所有脚手架
// 生产者（applyTurnSystemContext / web 路由 / mergeTurnSystemContext）都经
// wrapWithTurnSystemContext 收在包装体里，其余块标签不在此列（不扩判定面）。
const TURN_SCAFFOLD_TAG_PATTERN = /<\/?user_request>|<background_capability_stats>/;

function buildCommandCenterPreannounce(userMessage: string): string {
  const request = extractUserRequest(userMessage).replace(/\s+/g, ' ').trim();
  if (!request || TURN_SCAFFOLD_TAG_PATTERN.test(request)) {
    return '我先把这项任务交给后台执行，完成后回到这里交付结果。';
  }
  const taskLabel = Array.from(request).slice(0, 28).join('');
  return `我先把“${taskLabel}${Array.from(request).length > 28 ? '…' : ''}”交给后台执行，完成后回到这里交付结果。`;
}

/** Emits the renderer-visible preview before the pending tool row. */
export function emitCommandCenterToolStart(input: CommandCenterToolStartInput): string {
  let preannounce = input.existingPreannounce;
  if (
    input.toolName === 'delegate_task'
    && input.commandCenterEnabled
    && !input.streamedContent.trim()
    && !preannounce
  ) {
    preannounce = buildCommandCenterPreannounce(input.userMessage);
    input.emitPreview(preannounce);
  }
  input.emitToolStart();
  return preannounce;
}

export function applyCommandCenterPreannounce(
  response: ModelResponse,
  preannounce: string,
): ModelResponse {
  if (!preannounce || response.type !== 'tool_use') return response;
  const modelContent = response.content?.trim();
  response.content = modelContent ? `${preannounce}\n${modelContent}` : preannounce;
  response.contentParts = [
    { type: 'text', text: preannounce },
    ...(modelContent ? [{ type: 'text' as const, text: modelContent }] : []),
    ...(response.toolCalls ?? []).map((toolCall) => ({
      type: 'tool_call' as const,
      toolCallId: toolCall.id,
    })),
  ];
  return response;
}
