import type { Message, ToolCall, ToolResult } from '../../shared/contract';
import {
  isBrowserComputerToolName,
  sanitizeBrowserComputerToolResult,
  sanitizeBrowserComputerToolArguments,
} from '../../shared/utils/browserComputerRedaction';
import {
  collectSurfaceExecutionExportProjection,
  projectSurfaceExecutionMetadataForExport,
  projectSurfaceExecutionResultMetadataForExport,
  stripRawSurfaceExecutionExportFields,
  surfaceExecutionArgumentsForExport,
} from '../../shared/utils/surfaceExecutionExportProjection';
import { redactSurfaceExecutionValue } from '../../shared/utils/surfaceExecutionRedaction';
import type { SessionWithMessages } from '../services/infra/sessionManager';

function sanitizeResult(
  result: ToolResult,
  call: Pick<ToolCall, 'id' | 'name' | 'arguments'> | undefined,
): ToolResult {
  const toolName = call?.name || 'unknown';
  const args = call?.arguments || {};
  const browserComputerSafe = isBrowserComputerToolName(toolName)
    ? sanitizeBrowserComputerToolResult(toolName, args, result)
    : result;
  return {
    ...browserComputerSafe,
    output: typeof browserComputerSafe.output === 'string'
      ? String(redactSurfaceExecutionValue(browserComputerSafe.output))
      : browserComputerSafe.output,
    error: typeof browserComputerSafe.error === 'string'
      ? String(redactSurfaceExecutionValue(browserComputerSafe.error))
      : browserComputerSafe.error,
    outputPath: typeof browserComputerSafe.outputPath === 'string'
      ? String(redactSurfaceExecutionValue(browserComputerSafe.outputPath))
      : browserComputerSafe.outputPath,
    metadata: projectSurfaceExecutionResultMetadataForExport(browserComputerSafe.metadata, {
      toolName,
      toolCallId: call?.id || result.toolCallId,
      success: browserComputerSafe.success,
      error: browserComputerSafe.error,
    }),
  };
}

function sanitizeCall(call: ToolCall, resultMetadata?: Record<string, unknown>): ToolCall {
  const surfaceProjection = projectSurfaceExecutionMetadataForExport(
    call.result?.metadata ?? resultMetadata,
  );
  return {
    ...call,
    arguments: isBrowserComputerToolName(call.name)
      ? surfaceProjection
        ? surfaceExecutionArgumentsForExport(call.arguments)
        : sanitizeBrowserComputerToolArguments(call.name, call.arguments) ?? call.arguments ?? {}
      : call.arguments,
    result: call.result ? sanitizeResult(call.result, call) : undefined,
  };
}

function sanitizeMessages(messages: Message[]): Message[] {
  const calls = new Map<string, ToolCall>();
  const resultMetadata = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    for (const call of message.toolCalls || []) calls.set(call.id, call);
    for (const result of message.toolResults || []) {
      if (result.metadata) resultMetadata.set(result.toolCallId, result.metadata);
    }
  }
  return messages.map((message) => ({
    ...message,
    reasoning: undefined,
    thinking: undefined,
    metadata: message.metadata
      ? stripRawSurfaceExecutionExportFields(message.metadata) as Message['metadata']
      : message.metadata,
    toolCalls: message.toolCalls?.map((call) => sanitizeCall(call, resultMetadata.get(call.id))),
    toolResults: message.toolResults?.map((result) => sanitizeResult(result, calls.get(result.toolCallId))),
  }));
}

export function sanitizeSurfaceExecutionSessionExport(
  session: SessionWithMessages,
): SessionWithMessages {
  const surfaceExecution = collectSurfaceExecutionExportProjection(
    session.messages,
    session.metadata,
  );
  return {
    ...session,
    metadata: {
      ...(session.metadata
        ? stripRawSurfaceExecutionExportFields(session.metadata) as Record<string, unknown>
        : {}),
      ...(surfaceExecution ? { surfaceExecutionExportV1: surfaceExecution } : {}),
    },
    messages: sanitizeMessages(session.messages),
  };
}
