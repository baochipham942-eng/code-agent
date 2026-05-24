import * as fs from 'fs';
import * as path from 'path';
import type { ModelConfig, ToolCall, ToolDefinition } from '../../../../shared/contract';
import type { ModelMessage, ModelResponse } from '../../loopTypes';

const HTML_ARTIFACT_INTENT_PATTERN =
  /html|browser|interactive|single[-\s]?file|app|game|breakout|arkanoid|弹砖|打砖|弹球|游戏|网页|单文件/i;
const ABSOLUTE_HTML_PATH_PATTERN = /\/[\w.~-]+\/[^\s,，。、;；:："'`<>]+\.html?\b/gi;
const RELATIVE_HTML_PATH_PATTERN = /(?:^|[\s"'`])((?:\.\/)?[\w.-][\w ./~-]*\.html?)\b/gi;

interface XiaomiArtifactTextFirstInput {
  artifactRequest: boolean;
  artifactRepairActive: boolean;
  forceFinalResponseActive: boolean;
  config: Pick<ModelConfig, 'provider' | 'model'>;
  tools: Array<Pick<ToolDefinition, 'name'>>;
  userRequestText: string;
}

export function shouldUseXiaomiArtifactTextFirstWrite(input: XiaomiArtifactTextFirstInput): boolean {
  if (!input.artifactRequest) return false;
  if (input.artifactRepairActive) return false;
  if (input.forceFinalResponseActive) return false;
  if (input.config.provider !== 'xiaomi') return false;
  if (!/mimo/i.test(input.config.model || '')) return false;
  if (!input.tools.some((tool) => tool.name === 'Write')) return false;
  return HTML_ARTIFACT_INTENT_PATTERN.test(input.userRequestText);
}

export function resolveXiaomiArtifactTextFirstTargetPath(
  userRequestText: string,
  workingDirectory: string,
): string {
  const explicit = extractExplicitHtmlPath(userRequestText);
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(workingDirectory, explicit);
  }

  const fallbackName = /breakout|arkanoid|弹砖|打砖|弹球/i.test(userRequestText)
    ? 'breakout-game.html'
    : 'interactive-artifact.html';
  return nextAvailablePath(path.resolve(workingDirectory, fallbackName));
}

export function buildXiaomiArtifactTextFirstMessages(
  messages: ModelMessage[],
  targetPath: string,
): ModelMessage[] {
  return [
    ...messages,
    {
      role: 'system',
      content: [
        '<xiaomi-artifact-text-first>',
        'This provider stalls when a large generated artifact is emitted as a tool-call JSON argument.',
        'Generate the artifact as plain visible text in this call. The runtime will write it to the file after the response.',
        `Target file: ${targetPath}`,
        'Output only the complete file content. For HTML, start at <!DOCTYPE html> or <html>.',
        'Do not include markdown fences, explanations, or tool-call JSON.',
        '</xiaomi-artifact-text-first>',
      ].join('\n'),
    },
  ];
}

export function buildXiaomiArtifactTextFirstWriteResponse(
  textResponse: ModelResponse,
  targetPath: string,
): ModelResponse {
  const content = extractGeneratedHtmlContent(textResponse.content || '');
  if (!content) {
    throw new Error('xiaomi artifact text-first response did not contain writable artifact content');
  }

  const toolCall: ToolCall = {
    id: `call_xiaomi_artifact_text_first_${Date.now().toString(36)}`,
    name: 'Write',
    arguments: {
      file_path: targetPath,
      content,
    },
  };

  return {
    type: 'tool_use',
    toolCalls: [toolCall],
    contentParts: [{ type: 'tool_call', toolCallId: toolCall.id }],
    finishReason: 'tool_calls',
    actualProvider: textResponse.actualProvider,
    actualModel: textResponse.actualModel,
    fallback: textResponse.fallback,
    usage: textResponse.usage,
    runtimeDiagnostics: {
      ...textResponse.runtimeDiagnostics,
      artifactTextFirstWrite: {
        provider: 'xiaomi',
        targetFile: targetPath,
        contentChars: content.length,
      },
    },
  };
}

export function extractGeneratedHtmlContent(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1]?.trim() || trimmed;
  const lower = source.toLowerCase();
  const doctypeIndex = lower.indexOf('<!doctype html');
  const htmlIndex = lower.indexOf('<html');
  const starts = [doctypeIndex, htmlIndex].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : 0;
  let content = source.slice(start).trim();

  const endIndex = content.toLowerCase().lastIndexOf('</html>');
  if (endIndex >= 0) {
    content = content.slice(0, endIndex + '</html>'.length).trim();
  }

  return content;
}

function extractExplicitHtmlPath(userRequestText: string): string | null {
  const absolute = userRequestText.match(ABSOLUTE_HTML_PATH_PATTERN)?.[0];
  if (absolute) return stripTrailingPathPunctuation(absolute);

  let match: RegExpExecArray | null;
  RELATIVE_HTML_PATH_PATTERN.lastIndex = 0;
  while ((match = RELATIVE_HTML_PATH_PATTERN.exec(userRequestText)) !== null) {
    const candidate = stripTrailingPathPunctuation(match[1] || '');
    if (candidate && candidate.toLowerCase() !== 'html') return candidate;
  }
  return null;
}

function stripTrailingPathPunctuation(value: string): string {
  return value.replace(/[.,，。;；:：!！?？)）\]]+$/g, '');
}

function nextAvailablePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base}-${index}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}
