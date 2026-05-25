import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildXiaomiBreakoutEnhancementInstruction,
  buildXiaomiArtifactTextFirstConfig,
  buildXiaomiArtifactTextFirstMessages,
  buildXiaomiArtifactTextFirstWriteResponse,
  extractGeneratedHtmlContent,
  resolveXiaomiArtifactTextFirstTargetPath,
  shouldUseXiaomiArtifactTextFirstWrite,
} from '../../../src/main/agent/runtime/contextAssembly/xiaomiArtifactTextFirst';
import type { ToolDefinition } from '../../../src/shared/contract';

const WRITE_TOOL: ToolDefinition = {
  name: 'Write',
  description: 'write file',
  inputSchema: { type: 'object' },
  requiresPermission: false,
  permissionLevel: 'write',
};

describe('xiaomi artifact text-first write', () => {
  it('activates only for Xiaomi MiMo HTML artifact generation with Write available', () => {
    expect(shouldUseXiaomiArtifactTextFirstWrite({
      artifactRequest: true,
      artifactRepairActive: false,
      forceFinalResponseActive: false,
      config: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      tools: [WRITE_TOOL],
      userRequestText: '开发一个html弹砖块游戏，要求技能和关卡丰富',
    })).toBe(true);

    expect(shouldUseXiaomiArtifactTextFirstWrite({
      artifactRequest: true,
      artifactRepairActive: true,
      forceFinalResponseActive: false,
      config: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      tools: [WRITE_TOOL],
      userRequestText: '开发一个html弹砖块游戏',
    })).toBe(true);

    expect(shouldUseXiaomiArtifactTextFirstWrite({
      artifactRequest: false,
      artifactRepairActive: true,
      forceFinalResponseActive: false,
      config: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      tools: [WRITE_TOOL],
      userRequestText: 'Artifact validation failed for /tmp/game.html',
    })).toBe(true);

    expect(shouldUseXiaomiArtifactTextFirstWrite({
      artifactRequest: true,
      artifactRepairActive: false,
      forceFinalResponseActive: false,
      config: { provider: 'longcat', model: 'LongCat 2.0 Preview' },
      tools: [WRITE_TOOL],
      userRequestText: '开发一个html弹砖块游戏',
    })).toBe(false);
  });

  it('resolves explicit and generated artifact target paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomi-artifact-text-first-'));
    const explicit = resolveXiaomiArtifactTextFirstTargetPath(
      '请创建文件 game.html',
      dir,
    );
    expect(explicit).toBe(path.join(dir, 'game.html'));

    fs.writeFileSync(path.join(dir, 'breakout-game.html'), '<html></html>');
    const generated = resolveXiaomiArtifactTextFirstTargetPath(
      '开发一个html弹砖块游戏，要求技能和关卡丰富',
      dir,
    );
    expect(generated).toBe(path.join(dir, 'breakout-game-2.html'));
  });

  it('builds no-tool text-first messages with an explicit target', () => {
    const messages = buildXiaomiArtifactTextFirstMessages(
      [{ role: 'user', content: 'build a game' }],
      '/tmp/game.html',
    );

    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toContain('Target file: /tmp/game.html');
    expect(messages[1].content).toContain('Do not include markdown fences');
    expect(messages[1].content).toContain('<tool_call>');
    expect(messages[1].content).toContain('If this is a repair turn');
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toContain('Return only the complete HTML file content now');
  });

  it('adds explicit breakout validator contract and disables thinking for text-first generation', () => {
    const messages = buildXiaomiArtifactTextFirstMessages(
      [{ role: 'user', content: '开发一个html弹砖块游戏，要求技能和关卡丰富' }],
      '/tmp/breakout.html',
    );

    expect(messages[1].content).toContain('two-stage strategy');
    expect(messages[1].content).toContain('small, complete, validator-friendly playable core');
    expect(messages[1].content).toContain('Build exactly one playable initial level');
    expect(messages[1].content).toContain('second pass may polish CSS');
    expect(messages[1].content).toContain('exact field name controls');
    expect(messages[1].content).toContain("['wide','multi','slow','through','life']");
    expect(messages[1].content).toContain('Keep progressPlan very small and generic');
    expect(messages[1].content).toContain('generic for default controls');
    expect(messages[1].content).toContain('should include paddleX and ball.x');
    expect(messages[1].content).toContain('deterministic scenario shortcuts');
    expect(messages[1].content).toContain('initial loaded start screen');
    expect(messages[1].content).toContain('tabindex="0"');
    expect(messages[1].content).toContain('never call an undefined global step()');
    expect(messages[1].content).toContain('reset("win")');
    expect(messages[1].content).toContain('numeric 0..11');
    expect(messages[1].content).toContain('all 12 scenarios reachable');
    expect(messages[1].content).toContain('wallBounceCount');
    expect(messages[1].content).toContain('The CSS/rendered canvas aspect ratio must match');
    expect(messages[1].content).toContain('calc((100dvh - 16px) * 480 / 640)');
    expect(messages[1].content).toContain('Do not set width: 100% and height: 100%');
    expect(messages[1].content).toContain('large empty margins');

    const config = buildXiaomiArtifactTextFirstConfig({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      thinkingBudget: 16_384,
      reasoningEffort: 'high',
    });

    expect(config.reasoningEffort).toBe('low');
    expect(config.thinkingBudget).toBeUndefined();
  });

  it('builds a constrained second-stage breakout enhancement instruction', () => {
    const instruction = buildXiaomiBreakoutEnhancementInstruction('/tmp/breakout.html');

    expect(instruction).toContain('<xiaomi-artifact-enhancement stage="visual-polish">');
    expect(instruction).toContain('make exactly one constrained refinement');
    expect(instruction).toContain('Space should launch from the real initial screen');
    expect(instruction).toContain('must not require the key to be held');
    expect(instruction).toContain('Do not add new authored levels');
    expect(instruction).not.toContain('__GAME_TEST__');
  });

  it('keeps browser visual smoke aspect-ratio failures in compact repair evidence', () => {
    const messages = buildXiaomiArtifactTextFirstMessages(
      [
        { role: 'user', content: '修复这个弹砖块游戏' },
        {
          role: 'tool',
          content: 'desktop visual smoke detected distorted game canvas aspect ratio (canvas=484x363, internal=480x640). primary game canvas is undersized.',
        },
      ],
      '/tmp/breakout.html',
      { artifactRepairActive: true },
    );

    expect(messages.some((message) => String(message.content).includes('distorted game canvas aspect ratio'))).toBe(true);
    expect(messages.some((message) => String(message.content).includes('primary game canvas is undersized'))).toBe(true);
  });

  it('extracts clean HTML and wraps it as a synthetic Write call', () => {
    const raw = [
      'Here is the game:',
      '```html',
      '<!DOCTYPE html>',
      '<html><body><canvas id="game"></canvas></body></html>',
      '```',
    ].join('\n');

    expect(extractGeneratedHtmlContent(raw)).toBe(
      '<!DOCTYPE html>\n<html><body><canvas id="game"></canvas></body></html>',
    );

    const response = buildXiaomiArtifactTextFirstWriteResponse(
      {
        type: 'text',
        content: raw,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 20 },
      },
      '/tmp/game.html',
    );

    expect(response.type).toBe('tool_use');
    expect(response.finishReason).toBe('tool_calls');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0].name).toBe('Write');
    expect(response.toolCalls?.[0].arguments.file_path).toBe('/tmp/game.html');
    expect(String(response.toolCalls?.[0].arguments.content)).toContain('<!DOCTYPE html>');
    expect(response.runtimeDiagnostics?.artifactTextFirstWrite).toMatchObject({
      provider: 'xiaomi',
      targetFile: '/tmp/game.html',
    });
  });

  it('refuses partial text-first fragments instead of writing broken HTML', () => {
    expect(extractGeneratedHtmlContent('Content: 267 chars')).toBe('');
    expect(extractGeneratedHtmlContent('<html><body>missing close')).toBe('');
    expect(() => buildXiaomiArtifactTextFirstWriteResponse(
      {
        type: 'text',
        content: '<function=Write><parameter=content>short patch</parameter>',
        finishReason: 'stop',
      },
      '/tmp/game.html',
    )).toThrow('did not contain writable artifact content');
  });
});
