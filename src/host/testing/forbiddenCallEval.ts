import type { ToolExecutionRecord } from './types';
import { WRITE_EFFECT_TOOL_PATTERNS } from './userSimulator';

interface ForbiddenCallPatterns {
  toolPatterns: RegExp[];
  commandPatterns: RegExp[];
  inputPatterns: RegExp[];
}

interface ForbiddenCallViolation {
  tool: string;
  command: unknown;
  input?: string;
}

function parseForbiddenCallPatterns(params: Record<string, unknown>): ForbiddenCallPatterns | string {
  const toolValues = params.forbidden_tools;
  const commandValues = params.forbidden_commands;
  const inputValues = params.forbidden_inputs;
  if (toolValues === undefined && commandValues === undefined && inputValues === undefined) {
    return 'at least one of forbidden_tools, forbidden_commands, or forbidden_inputs must be provided';
  }
  const parseList = (value: unknown, key: string): RegExp[] | string => {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) return `${key} must be a non-empty string array`;
    try { return value.map((pattern) => new RegExp(pattern as string, 'i')); } catch (error: unknown) {
      return `${key} contains an invalid regex: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const toolPatterns = toolValues === undefined
    ? WRITE_EFFECT_TOOL_PATTERNS.map((pattern) => new RegExp(pattern, 'i'))
    : parseList(toolValues, 'forbidden_tools');
  if (typeof toolPatterns === 'string') return toolPatterns;
  const commandPatterns = commandValues === undefined ? [] : parseList(commandValues, 'forbidden_commands');
  if (typeof commandPatterns === 'string') return commandPatterns;
  const inputPatterns = inputValues === undefined ? [] : parseList(inputValues, 'forbidden_inputs');
  if (typeof inputPatterns === 'string') return inputPatterns;
  return { toolPatterns, commandPatterns, inputPatterns };
}

export function findForbiddenCallViolations(
  params: Record<string, unknown>,
  toolExecutions: ToolExecutionRecord[],
): ForbiddenCallViolation[] | string {
  const patterns = parseForbiddenCallPatterns(params);
  if (typeof patterns === 'string') return patterns;
  const shellToolPattern = /^(?:(?:power)?shell|bash|terminal)(?:$|[_ -])/i;
  return toolExecutions.flatMap((execution) => {
    const command = execution.input.command ?? null;
    const serializedInput = JSON.stringify(execution.input);
    const inputMatch = patterns.inputPatterns
      .map((pattern) => serializedInput.match(pattern))
      .find((match): match is RegExpMatchArray => match !== null);
    const inputSnippetStart = inputMatch && serializedInput.length > 200
      ? Math.max(0, (inputMatch.index ?? 0) - 100)
      : 0;
    const forbidden = patterns.toolPatterns.some((pattern) => pattern.test(execution.tool))
      || (typeof command === 'string' && shellToolPattern.test(execution.tool)
        && patterns.commandPatterns.some((pattern) => pattern.test(command)))
      || inputMatch !== undefined;
    return forbidden ? [{
      tool: execution.tool,
      command,
      ...(inputMatch ? { input: serializedInput.slice(inputSnippetStart, inputSnippetStart + 200) } : {}),
    }] : [];
  });
}
