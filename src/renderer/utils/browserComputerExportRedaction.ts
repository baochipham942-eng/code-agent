import type { Message, ToolCall } from '@shared/contract';
import {
  isBrowserComputerToolName,
  sanitizeBrowserComputerMetadata,
  sanitizeBrowserComputerToolArguments,
  redactBrowserComputerInputPayloadsInValue,
} from '@shared/utils/browserComputerRedaction';
import {
  projectSurfaceExecutionResultMetadataForExport,
  projectSurfaceExecutionMetadataForExport,
  stripRawSurfaceExecutionExportFields,
  surfaceExecutionArgumentsForExport,
} from '@shared/utils/surfaceExecutionExportProjection';
import { redactSurfaceExecutionValue } from '@shared/utils/surfaceExecutionRedaction';
import {
  formatBrowserComputerActionResultDetails,
  summarizeBrowserComputerActionResult,
} from './browserComputerActionPreview';

function redactToolResultText(
  toolName: string,
  args: Record<string, unknown>,
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const redacted = redactBrowserComputerInputPayloadsInValue(toolName, args, value);
  return typeof redacted === 'string' ? redacted : String(redacted);
}

function redactSurfaceResultText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : String(redactSurfaceExecutionValue(value));
}

export function formatToolResultForBrowserComputerExport(call: ToolCall): string | undefined {
  if (!isBrowserComputerToolName(call.name) || !call.result) {
    return undefined;
  }
  return formatBrowserComputerActionResultDetails(call)
    || summarizeBrowserComputerActionResult(call)
    || redactToolResultText(call.name, call.arguments || {}, call.result.success ? call.result.output : call.result.error);
}

function buildBrowserComputerExportMetadata(
  call: ToolCall,
  resultSummary: string | undefined,
): Record<string, unknown> | undefined {
  if (!isBrowserComputerToolName(call.name) || !call.result) {
    return call.result?.metadata;
  }
  const metadata = sanitizeBrowserComputerMetadata(
    call.name,
    call.arguments || {},
    call.result.metadata,
  ) || {};
  return projectSurfaceExecutionResultMetadataForExport({
    ...metadata,
    summary: resultSummary,
    status: call.result.success ? 'success' : 'error',
  }, {
    toolName: call.name,
    toolCallId: call.id,
    success: call.result.success,
    error: call.result.error,
  });
}

export function sanitizeBrowserComputerToolCallForExport(
  call: ToolCall,
  resultMetadata?: Record<string, unknown>,
): ToolCall {
  const rawArguments = call.arguments || {};
  const surfaceProjection = projectSurfaceExecutionMetadataForExport(
    call.result?.metadata ?? resultMetadata,
  );
  const safeArguments = isBrowserComputerToolName(call.name)
    ? surfaceProjection
      ? surfaceExecutionArgumentsForExport(rawArguments)
      : sanitizeBrowserComputerToolArguments(call.name, rawArguments)
    : call.arguments;
  const safeResultSummary = (isBrowserComputerToolName(call.name)
    ? formatToolResultForBrowserComputerExport(call)
    : formatBrowserComputerActionResultDetails({
        name: call.name,
        arguments: rawArguments,
        result: call.result,
      })) ?? undefined;

  return {
    ...call,
    arguments: safeArguments || rawArguments,
    result: call.result
      ? {
          ...call.result,
          output: call.result.success
            ? redactSurfaceResultText(
                safeResultSummary || redactToolResultText(call.name, rawArguments, call.result.output),
              )
            : redactSurfaceResultText(
                redactToolResultText(call.name, rawArguments, call.result.output),
              ),
          error: call.result.success
            ? redactSurfaceResultText(
                redactToolResultText(call.name, rawArguments, call.result.error),
              )
            : redactSurfaceResultText(
                safeResultSummary || redactToolResultText(call.name, rawArguments, call.result.error),
              ),
          metadata: isBrowserComputerToolName(call.name)
            ? buildBrowserComputerExportMetadata(call, safeResultSummary)
            : redactBrowserComputerInputPayloadsInValue(call.name, rawArguments, call.result.metadata) as Record<string, unknown> | undefined,
        }
      : call.result,
  };
}

export function sanitizeMessagesForBrowserComputerExport(messages: Message[]): Message[] {
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
    toolCalls: message.toolCalls?.map((call) => (
      sanitizeBrowserComputerToolCallForExport(call, resultMetadata.get(call.id))
    )),
    toolResults: message.toolResults?.map((result) => {
      const call = calls.get(result.toolCallId);
      if (!call) {
        return {
          ...result,
          metadata: projectSurfaceExecutionResultMetadataForExport(result.metadata, {
            toolCallId: result.toolCallId,
            success: result.success,
            error: result.error,
          }),
        };
      }
      return sanitizeBrowserComputerToolCallForExport({ ...call, result }).result || result;
    }),
  }));
}
