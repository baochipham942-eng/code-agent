import { describe, expect, it } from 'vitest';
import {
  buildArtifactRepairFocusBlock,
  formatArtifactRepairToolResultContent,
} from '../../../src/host/agent/runtime/contextAssembly/artifactRepairProjection';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

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
