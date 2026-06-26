import type { ToolCall, ToolResult } from '../../../shared/contract';
import {
  sanitizeBrowserComputerToolArguments,
  sanitizeBrowserComputerToolResult,
  sanitizeLargeTextToolArguments,
} from '../../../shared/utils/browserComputerRedaction';

export function sanitizeToolArgumentsForObservation(toolCall: Pick<ToolCall, 'name' | 'arguments'>): Record<string, unknown> {
  const browserSafeArgs = sanitizeBrowserComputerToolArguments(toolCall.name, toolCall.arguments) || toolCall.arguments;
  return sanitizeLargeTextToolArguments(toolCall.name, browserSafeArgs) || browserSafeArgs || {};
}

export function sanitizeToolResultForObservation(
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
  result: ToolResult,
): ToolResult {
  return sanitizeBrowserComputerToolResult(toolCall.name, toolCall.arguments, result);
}

export function summarizeArtifactRepairFileEvidenceForObservation(
  result: ToolResult,
  toolCall?: Pick<ToolCall, 'arguments'>,
): ToolResult {
  const rangedRead = toolCall ? isRangedReadToolCall(toolCall) : result.metadata?.rangedRead === true;
  if (
    result.success !== true
    || result.metadata?.evidenceKind !== 'file_read'
    || typeof result.metadata?.filePath !== 'string'
    || typeof result.output !== 'string'
    || result.output.length <= 4_000
    || rangedRead
  ) {
    return result;
  }

  const lines = result.output.split('\n');
  const anchors = lines
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) =>
      /window\.__GAME_TEST__|window\.__INTERACTIVE_TEST__|window\.__GAME_META__|window\.__INTERACTIVE_META__|runSmokeTest|step\s*\(|progressPlan|qualityPlan/i.test(line),
    )
    .slice(0, 24)
    .map(({ line, lineNumber }) => `${lineNumber}: ${line.length > 220 ? `${line.slice(0, 220)} ...` : line}`);

  return {
    ...result,
    output: [
      '<artifact-repair-file-read-preview>',
      `Target file read: ${result.metadata.filePath}`,
      `Output omitted from event stream (${lines.length} lines, ${result.output.length} chars).`,
      'Important anchors:',
      ...(anchors.length > 0 ? anchors : ['- no contract anchors detected in preview']),
      '</artifact-repair-file-read-preview>',
    ].join('\n'),
    metadata: {
      ...result.metadata,
      artifactRepairPreview: true,
      originalOutputLength: result.output.length,
    },
  };
}

export function extractReadFilePath(toolCall: Pick<ToolCall, 'name' | 'arguments'>): string | null {
  if (toolCall.name !== 'read_file' && toolCall.name !== 'Read') return null;
  const filePath = toolCall.arguments?.file_path || toolCall.arguments?.path;
  return typeof filePath === 'string' && filePath.trim() ? stripEmbeddedReadParams(filePath) : null;
}

export function isRangedReadToolCall(toolCall: Pick<ToolCall, 'arguments'>): boolean {
  const offset = toolCall.arguments?.offset;
  const limit = toolCall.arguments?.limit;
  if (typeof offset === 'number' || typeof limit === 'number') return true;
  if (typeof offset === 'string' || typeof limit === 'string') return true;

  const rawPath = toolCall.arguments?.file_path || toolCall.arguments?.path;
  if (typeof rawPath !== 'string') return false;
  return /\s(?:offset|limit)\s*=?\s*\d+\b/i.test(rawPath) || /\slines?\s+\d+(?:-\d+)?\b/i.test(rawPath);
}

function stripEmbeddedReadParams(rawPath: string): string {
  let filePath = rawPath.trim();

  if (/\s(?:offset|limit)\s*=?\s*\d+\b/i.test(filePath)) {
    filePath = filePath.replace(/\s+(?:offset|limit)\s*=?\s*\d+\b/gi, '').trim();
  }

  const linesMatch = filePath.match(/^(.+?)\s+lines?\s+\d+(?:-\d+)?$/i);
  if (linesMatch) {
    filePath = linesMatch[1].trim();
  }

  return filePath;
}

function isBashFileRead(toolCall: Pick<ToolCall, 'name' | 'arguments'>): boolean {
  if (toolCall.name !== 'bash' && toolCall.name !== 'Bash') return false;
  const command = toolCall.arguments?.command;
  if (typeof command !== 'string') return false;
  return /\b(cat|less|more|head|tail|sed|awk|nl|bat)\b|\bpython3?\b[\s\S]*\b(open|read_text|readlines|Path\()/i.test(command);
}

function isFileEvidenceToolCall(toolCall: Pick<ToolCall, 'name' | 'arguments'>): boolean {
  return Boolean(extractReadFilePath(toolCall)) || isBashFileRead(toolCall);
}

export function markFileEvidenceResult(
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
  result: ToolResult,
): ToolResult {
  if (!result.success || !result.output || !isFileEvidenceToolCall(toolCall)) {
    return result;
  }

  const filePath = extractReadFilePath(toolCall);
  return {
    ...result,
    metadata: {
      ...result.metadata,
      preserveObservation: true,
      evidenceKind: 'file_read',
      rangedRead: isRangedReadToolCall(toolCall),
      ...(filePath ? { filePath } : {}),
    },
  };
}
