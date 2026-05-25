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
  if (!input.artifactRequest && !input.artifactRepairActive) return false;
  if (input.forceFinalResponseActive) return false;
  if (input.config.provider !== 'xiaomi') return false;
  if (!/mimo/i.test(input.config.model || '')) return false;
  if (!input.tools.some((tool) => tool.name === 'Write')) return false;
  if (input.artifactRepairActive) return true;
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
  options: { artifactRepairActive?: boolean } = {},
): ModelMessage[] {
  const isBreakout = messagesContain(messages, /breakout|arkanoid|弹砖|打砖|弹球/i);
  const directive: ModelMessage = {
    role: 'system',
    content: [
      '<xiaomi-artifact-text-first>',
      'This provider stalls when a large generated artifact is emitted as a tool-call JSON argument.',
      'Generate the artifact as plain visible text in this call. The runtime will write it to the file after the response.',
      `Target file: ${targetPath}`,
      'Output only the complete file content. For HTML, the first non-whitespace characters must be <!DOCTYPE html> or <html>, and the final non-whitespace characters must be </html>.',
      'Do not include markdown fences, explanations, tool-call JSON, or ChatML/XML tool tags such as <tool_call>, <function=Write>, or <parameter=content>.',
      'If this is a repair turn, output one full corrected HTML document for the target file, not a patch, diff, Edit/Write call, short snippet, or tool call.',
      ...(isBreakout ? [
        '',
        'For Breakout/Arkanoid HTML games, the generated file must satisfy the runtime validator:',
        '- Use window.__GAME_META__ with exact field name controls, not dispatchableControls.',
        "- Include powerups: ['wide','multi','slow','through','life'].",
        "- Include scenarios for paddleMove, launch, wallBounce, paddleBounce, brickHit, powerup:wide, powerup:multi, powerup:slow, powerup:through, powerup:life, win, lose. Prefer object entries such as { id: 'paddleMove' } so reset(levelOrScenario) receives stable ids.",
        '- reset(levelOrScenario) must accept string ids/names and numeric indexes for every authored scenario. If scenarios are stored as strings, map numeric 0..11 to the same scenario ids before using startsWith or split.',
        '- Keep progressPlan very small and generic for default controls: ArrowRight increases paddleX and Space changes ball.x. Do not put wallBounceCount, paddleBounceCount, brick counters, powerups, win, or lose in progressPlan.',
        '- Start the live browser loop with requestAnimationFrame(loop) or equivalent before the script exits. A real browser Space key press from the start screen must move ball.x or ball.y, not only pass __GAME_TEST__.step().',
        '- Keep the rendered game surface readable and proportional in desktop, wide desktop, and 390px mobile previews. The CSS/rendered canvas aspect ratio must match canvas.width / canvas.height; never stretch an internal 480x640 portrait canvas into a landscape box or the reverse. Use responsive constraints such as width: min(...), max-width: calc(100vw - 16px), max-height: calc(100dvh - 16px), aspect-ratio: <canvas.width> / <canvas.height>, and height: auto; wide desktop should not leave the primary playfield tiny with large empty margins.',
        '- runSmokeTest coverage.stateChanges should include paddleX and ball.x, not only ball.launched, and should separately prove every authored scenario through reset(scenario) + step().',
        '- reset("win") followed by step({}, frames) must deterministically reach status "won"; reset("lose") followed by step({}, frames) must deterministically reach status "lost" and lives 0.',
        '- In step/tick, implement deterministic scenario shortcuts before or alongside physics: wallBounce increments wallBounceCount, paddleBounce increments paddleBounceCount, brickHit reduces brickCount and increases score, each powerup:* triggers that powerup, win sets status "won", lose sets status "lost".',
        '- In runSmokeTest(), call window.__GAME_TEST__.step/reset/snapshot or define local helpers that delegate to them; never call an undefined global step(), reset(), or snapshot().',
        '- window.__GAME_TEST__.snapshot() must expose paddleX, ball with x/y/vx/vy or speed, brickCount or bricksRemaining, score, wallBounceCount, paddleBounceCount, lives, status, activePowerups, and powerupsTriggered.',
        '- runSmokeTest() coverage must prove all 12 scenarios reachable, with levelsPassed/totalLevels or equivalent coverage matching every scenario.',
        '- reset(scenario), step(inputState, frames), and runSmokeTest() must drive those scenarios through live state and return string-array checks/failures.',
      ] : []),
      '</xiaomi-artifact-text-first>',
    ].join('\n'),
  };

  const finalInstruction: ModelMessage = {
    role: 'user',
    content: [
      'Return only the complete HTML file content now.',
      `Write the corrected content for ${targetPath}.`,
      'No prose, no markdown, no JSON, no tool call tags, no partial fragments.',
    ].join('\n'),
  };

  if (!options.artifactRepairActive) {
    return [
      ...messages,
      directive,
      finalInstruction,
    ];
  }

  return [
    directive,
    ...buildCompactRepairEvidenceMessages(messages),
    ...buildCurrentArtifactContextMessage(targetPath),
    finalInstruction,
  ];
}

export function buildXiaomiArtifactTextFirstConfig(config: ModelConfig): ModelConfig {
  return {
    ...config,
    reasoningEffort: 'low',
    thinkingBudget: undefined,
  };
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
  if (starts.length === 0) return '';
  const start = Math.min(...starts);
  let content = source.slice(start).trim();

  const endIndex = content.toLowerCase().lastIndexOf('</html>');
  if (endIndex < 0) return '';
  content = content.slice(0, endIndex + '</html>'.length).trim();

  return content;
}

function buildCompactRepairEvidenceMessages(messages: ModelMessage[]): ModelMessage[] {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const evidence = messages
    .filter((message) => {
      if (message.role !== 'tool' && message.role !== 'system') return false;
      const content = normalizeMessageContent(message.content);
      return /artifact[_-]?repair|artifact validation failed|runSmokeTest|__GAME_TEST__|__INTERACTIVE_TEST__|progressPlan|frontend_visual_smoke|browser visual smoke|visual smoke|distorted game canvas aspect ratio|primary game canvas is undersized|aspect ratio|missing_test_contract|canvas_not_responsive|reachability|scenarioMode/i.test(content);
    })
    .slice(-5)
    .map((message) => ({
      role: message.role,
      content: truncateText(normalizeMessageContent(message.content), 4_000),
    }) as ModelMessage);

  return [
    ...(lastUser ? [{
      role: 'user',
      content: truncateText(normalizeMessageContent(lastUser.content), 1_800),
    } as ModelMessage] : []),
    ...evidence,
  ];
}

function buildCurrentArtifactContextMessage(targetPath: string): ModelMessage[] {
  try {
    if (!fs.existsSync(targetPath)) return [];
    const content = fs.readFileSync(targetPath, 'utf-8');
    if (!content.trim()) return [];
    return [{
      role: 'user',
      content: [
        `<current-target-file path="${targetPath}">`,
        truncateText(content, 32_000),
        '</current-target-file>',
        'Rewrite the full corrected file, preserving useful working code but fixing every validator issue.',
      ].join('\n'),
    }];
  } catch {
    return [];
  }
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content || '');
  }
}

function truncateText(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const head = Math.floor(limit * 0.7);
  const tail = Math.max(600, limit - head - 120);
  return [
    content.slice(0, head),
    `\n...[omitted ${content.length - head - tail} chars]...\n`,
    content.slice(-tail),
  ].join('');
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

function messagesContain(messages: ModelMessage[], pattern: RegExp): boolean {
  return messages.some((message) => {
    const content = message.content;
    if (typeof content === 'string') return pattern.test(content);
    try {
      return pattern.test(JSON.stringify(content));
    } catch {
      return false;
    }
  });
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
