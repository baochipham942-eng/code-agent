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

export function buildCommandCenterPreannounce(userMessage: string): string {
  const request = extractUserRequest(userMessage).replace(/\s+/g, ' ').trim();
  const taskLabel = Array.from(request).slice(0, 28).join('');
  return taskLabel
    ? `我先把“${taskLabel}${Array.from(request).length > 28 ? '…' : ''}”交给后台执行，完成后回到这里交付结果。`
    : '我先把这项任务交给后台执行，完成后回到这里交付结果。';
}

/** Emits the renderer-visible preview before the pending tool row. */
export function emitCommandCenterToolStart(input: CommandCenterToolStartInput): string {
  let preannounce = input.existingPreannounce;
  if (
    input.toolName === 'spawn_task'
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
