import { describe, expect, it } from 'vitest';
import {
  buildArtifactRepairFocusBlock,
  formatArtifactRepairToolResultContent,
  hasRecentArtifactRepairToolFailure,
  isArtifactRepairMode,
} from '../../../src/host/agent/runtime/contextAssembly/artifactRepairProjection';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import type { Message, ToolResult } from '../../../src/shared/contract';

const TARGET_FILE = '/Users/test/.code-agent/work/big-game.html';

function makeCtx(targetFile: string | null): any {
  return {
    runtime: {
      workingDirectory: '/Users/test/.code-agent/work',
      artifact: ArtifactState.forTest({
        repairGuard: targetFile ? { targetFile, attempts: 0, phase: 'initial_repair' } : undefined,
      }),
    },
  };
}

function makeLargeHtml(): string {
  // 远超旧的 12KB 预览压缩阈值
  return `<!doctype html><html><body><script>\n${'// game line\n'.repeat(2000)}</script></body></html>`;
}

describe('formatArtifactRepairToolResultContent — Route A 全文不压缩', () => {
  it('目标文件 >12KB 的 file_read 结果返回完整原文，不做预览压缩', () => {
    const ctx = makeCtx(TARGET_FILE);
    const originalContent = makeLargeHtml();
    expect(originalContent.length).toBeGreaterThan(12_000);

    const result = {
      output: originalContent,
      metadata: { evidenceKind: 'file_read', filePath: TARGET_FILE },
    };

    const formatted = formatArtifactRepairToolResultContent(ctx, result, originalContent);
    expect(formatted).toBe(originalContent);
    expect(formatted).not.toContain('<artifact-repair-file-read>');
    expect(formatted).not.toContain('History preview compressed');
  });

  it('没有 repair guard 时直接返回原文', () => {
    const ctx = makeCtx(null);
    const originalContent = makeLargeHtml();
    const result = {
      output: originalContent,
      metadata: { evidenceKind: 'file_read', filePath: TARGET_FILE },
    };
    expect(formatArtifactRepairToolResultContent(ctx, result, originalContent)).toBe(originalContent);
  });
});

describe('artifact repair focus block', () => {
  it('turns visual aspect-ratio failures into direct canvas repair requirements', () => {
    const ctx: any = {
      runtime: {
        workingDirectory: '/Users/test/.code-agent/work',
        artifact: ArtifactState.forTest({
          repairGuard: {
          targetFile: TARGET_FILE,
          attempts: 1,
          phase: 'initial_repair',
        },
        }),
        messages: [{
          role: 'tool',
          content: '',
          toolResults: [{
            success: false,
            output: 'validation failed',
            metadata: {
              artifactValidation: {
                failed: true,
                failures: [
                  'desktop visual smoke detected distorted game canvas aspect ratio (canvas=484x363, internal=480x640).',
                  'wide desktop visual smoke found primary game canvas is undersized with large empty margins.',
                ],
              },
            },
          }],
        }],
      },
      getBudgetedPersistentSystemContext: () => [],
    };

    const block = buildArtifactRepairFocusBlock(ctx, []);

    expect(block).toContain('canvas_not_responsive');
    expect(block).toContain('CSS aspect ratio always matches');
    expect(block).toContain('calc((100dvh - 16px) * 480 / 640)');
    expect(block).toContain('large empty margins');
  });
});

// toolArtifactValidationLifecycle 验收通过分支会把
// `artifactValidation: { failed: false, passed: true, targetFile, ... }` 写进 tool result，
// messageProcessor 再把 toolResults JSON.stringify 成 tool 消息的 content 落库。
// 这段判定链不能把「通过」当「修复信号」：游戏首次验收成功后，正常任务的
// system prompt 仍要带记忆索引 / pinned 资料索引 / 相关技能（messageBuild 全部以
// isArtifactRepairMode 为闸）。
describe('isArtifactRepairMode — 验收通过记录不是修复信号', () => {
  // 与 messageProcessor 的 tool 消息构造同构：content 就是 toolResults 的 JSON 序列化。
  function toolMessage(results: ToolResult[]): Message {
    return {
      id: `tool-${Math.random().toString(36).slice(2)}`,
      role: 'tool',
      content: JSON.stringify(results),
      timestamp: Date.now(),
      toolResults: results,
    };
  }

  function userMessage(content: string): Message {
    return { id: `user-${Math.random().toString(36).slice(2)}`, role: 'user', content, timestamp: Date.now() };
  }

  function passedValidationResult(targetFile: string): ToolResult {
    // 与 toolArtifactValidationLifecycle 验收通过分支落库的元数据同构。
    return {
      toolCallId: 'call_write_game',
      success: true,
      output: '文件已写入',
      metadata: {
        artifactValidation: {
          failed: false,
          passed: true,
          targetFile,
          inferredKind: 'interactive_artifact',
          checks: ['contract parsed', 'runtime smoke passed'],
        },
      },
    };
  }

  function failedValidationResult(targetFile: string): ToolResult {
    return {
      toolCallId: 'call_write_game_2',
      success: false,
      error: [
        `Artifact validation failed for ${targetFile}.`,
        'runSmokeTest 未覆盖任何 authored level。',
      ].join('\n'),
      metadata: {
        artifactValidation: {
          failed: true,
          attempts: 1,
          failures: ['runSmokeTest 未覆盖任何 authored level。'],
        },
      },
    };
  }

  function makeRuntimeCtx(messages: Message[]): any {
    return {
      runtime: {
        workingDirectory: '/Users/test/.code-agent/work',
        artifact: ArtifactState.forTest({ repairGuard: undefined }),
        messages,
      },
      getBudgetedPersistentSystemContext: () => [],
    };
  }

  it('验收通过的工具记录（failed:false + passed:true 元数据）不触发修复模式', () => {
    const ctx = makeRuntimeCtx([
      toolMessage([passedValidationResult(TARGET_FILE)]),
      userMessage('帮我查一下之前记的配色偏好'),
    ]);

    expect(hasRecentArtifactRepairToolFailure(ctx)).toBe(false);
    expect(isArtifactRepairMode(ctx)).toBe(false);
  });

  it('真实失败（failed:true 元数据）仍是修复信号', () => {
    const ctx = makeRuntimeCtx([
      toolMessage([failedValidationResult(TARGET_FILE)]),
      userMessage('继续修'),
    ]);

    expect(hasRecentArtifactRepairToolFailure(ctx)).toBe(true);
    expect(isArtifactRepairMode(ctx)).toBe(true);
  });

  it('同一目标先通过后又失败：失败仍要触发修复模式', () => {
    const ctx = makeRuntimeCtx([
      toolMessage([passedValidationResult(TARGET_FILE)]),
      toolMessage([failedValidationResult(TARGET_FILE)]),
      userMessage('再试一次'),
    ]);

    expect(hasRecentArtifactRepairToolFailure(ctx)).toBe(true);
    expect(isArtifactRepairMode(ctx)).toBe(true);
  });

  it('没有 toolResults 的旧形态 tool 消息仍按 content 判定', () => {
    const legacyToolMessage: Message = {
      id: 'legacy-tool',
      role: 'tool',
      content: JSON.stringify([failedValidationResult(TARGET_FILE)]),
      timestamp: Date.now(),
    };
    const ctx = makeRuntimeCtx([legacyToolMessage, userMessage('继续修')]);

    expect(hasRecentArtifactRepairToolFailure(ctx)).toBe(true);
  });
});
