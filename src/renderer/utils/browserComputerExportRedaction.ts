import type { Message, ToolCall } from '@shared/contract';
import {
  isBrowserComputerToolName,
  sanitizeBrowserComputerMetadata,
  sanitizeBrowserComputerToolArguments,
  redactBrowserComputerInputPayloadsInValue,
} from '@shared/utils/browserComputerRedaction';
import {
  formatBrowserComputerActionArguments,
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

export function formatToolArgumentsForBrowserComputerExport(call: ToolCall): string {
  const safeBrowserComputerArgs = formatBrowserComputerActionArguments(call.name, call.arguments || {});
  return safeBrowserComputerArgs || JSON.stringify(call.arguments || {}, null, 2);
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
  return {
    ...metadata,
    summary: resultSummary,
    status: call.result.success ? 'success' : 'error',
  };
}

export function sanitizeBrowserComputerToolCallForExport(call: ToolCall): ToolCall {
  const rawArguments = call.arguments || {};
  const safeArguments = isBrowserComputerToolName(call.name)
    ? sanitizeBrowserComputerToolArguments(call.name, rawArguments)
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
            ? safeResultSummary || redactToolResultText(call.name, rawArguments, call.result.output)
            : redactToolResultText(call.name, rawArguments, call.result.output),
          error: call.result.success
            ? redactToolResultText(call.name, rawArguments, call.result.error)
            : safeResultSummary || redactToolResultText(call.name, rawArguments, call.result.error),
          metadata: isBrowserComputerToolName(call.name)
            ? buildBrowserComputerExportMetadata(call, safeResultSummary)
            : redactBrowserComputerInputPayloadsInValue(call.name, rawArguments, call.result.metadata) as Record<string, unknown> | undefined,
        }
      : call.result,
  };
}

export function sanitizeMessagesForBrowserComputerExport(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map(sanitizeBrowserComputerToolCallForExport),
  }));
}

export function sanitizeSessionForBrowserComputerExport<T extends { messages?: Message[] }>(data: T): T {
  if (!Array.isArray(data.messages)) {
    return data;
  }

  return {
    ...data,
    messages: sanitizeMessagesForBrowserComputerExport(data.messages),
  };
}
