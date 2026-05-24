import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
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
    })).toBe(false);

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

    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toContain('Target file: /tmp/game.html');
    expect(messages[1].content).toContain('Do not include markdown fences');
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
});
