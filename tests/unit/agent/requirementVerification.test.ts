// ============================================================================
// P0: Requirement Re-injection Verification (Ralph Loop) Tests
// Tests triggering conditions and message construction logic
// ============================================================================

import { describe, it, expect } from 'vitest';
import { basename } from 'path';

// ----------------------------------------------------------------------------
// Extract P0 triggering logic as a pure function for testability
// Mirrors the guard condition in agentLoop.ts (line ~1144)
// ----------------------------------------------------------------------------

interface P0State {
  outputValidationDone: boolean;     // P7 已完成
  requirementVerificationDone: boolean; // P0 已触发（one-shot guard）
  originalUserPrompt: string;        // 原始用户 prompt
}

/**
 * Determine if P0 requirement verification should trigger.
 * Conditions: P7 done + P0 not yet triggered + prompt exists
 */
function shouldTriggerP0(state: P0State): boolean {
  return state.outputValidationDone
    && !state.requirementVerificationDone
    && !!state.originalUserPrompt;
}

// ----------------------------------------------------------------------------
// Extract P0 message construction as a pure function for testability
// Mirrors the injectSystemMessage content in agentLoop.ts (line ~1158)
// ----------------------------------------------------------------------------

interface P0Context {
  originalUserPrompt: string;
  newFiles: string[];            // absolute paths from _getNewOutputFiles()
  structureInfo: string | null;  // from _readOutputXlsxStructure()
}

/**
 * Build the requirement-verification system message content.
 */
function buildP0Message(ctx: P0Context): string {
  const fileList = ctx.newFiles.map(f => basename(f)).join(', ');
  return (
    `<requirement-verification>\n` +
    `请重新阅读用户的原始需求，逐条核对是否都已完成:\n\n` +
    `"""\n${ctx.originalUserPrompt}\n"""\n\n` +
    `当前输出文件: ${fileList || '无'}\n` +
    (ctx.structureInfo ? `当前输出结构:\n${ctx.structureInfo}\n\n` : '\n') +
    `逐条确认每项需求都有对应输出。如有遗漏，立即补充。如全部满足，结束任务。\n` +
    `</requirement-verification>`
  );
}

// ----------------------------------------------------------------------------
// P0 Trigger Condition Tests
// ----------------------------------------------------------------------------

describe('P0 Requirement Verification - Trigger Conditions', () => {
  it('should trigger when P7 done + P0 not done + prompt exists', () => {
    expect(shouldTriggerP0({
      outputValidationDone: true,
      requirementVerificationDone: false,
      originalUserPrompt: '请生成销售报表',
    })).toBe(true);
  });

  it('should NOT trigger when P7 has not completed', () => {
    expect(shouldTriggerP0({
      outputValidationDone: false,
      requirementVerificationDone: false,
      originalUserPrompt: '请生成销售报表',
    })).toBe(false);
  });

  it('should NOT trigger when P0 already fired (one-shot)', () => {
    expect(shouldTriggerP0({
      outputValidationDone: true,
      requirementVerificationDone: true,
      originalUserPrompt: '请生成销售报表',
    })).toBe(false);
  });

  it('should NOT trigger when original prompt is empty', () => {
    expect(shouldTriggerP0({
      outputValidationDone: true,
      requirementVerificationDone: false,
      originalUserPrompt: '',
    })).toBe(false);
  });

  it('should require ALL three conditions simultaneously', () => {
    // Only prompt exists
    expect(shouldTriggerP0({
      outputValidationDone: false,
      requirementVerificationDone: true,
      originalUserPrompt: '任务',
    })).toBe(false);

    // Only P7 done
    expect(shouldTriggerP0({
      outputValidationDone: true,
      requirementVerificationDone: true,
      originalUserPrompt: '',
    })).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// One-shot Guard Tests
// ----------------------------------------------------------------------------

describe('P0 Requirement Verification - One-shot Guard', () => {
  it('should only trigger once per run cycle', () => {
    const state: P0State = {
      outputValidationDone: true,
      requirementVerificationDone: false,
      originalUserPrompt: '生成透视表+饼图',
    };

    // First check: should trigger
    expect(shouldTriggerP0(state)).toBe(true);

    // Simulate what agentLoop does: set flag to true
    state.requirementVerificationDone = true;

    // Second check: should NOT trigger
    expect(shouldTriggerP0(state)).toBe(false);
  });

  it('should reset on new run (simulates run() initialization)', () => {
    const state: P0State = {
      outputValidationDone: true,
      requirementVerificationDone: true, // fired in previous run
      originalUserPrompt: '旧任务',
    };

    // Simulate run() reset
    state.outputValidationDone = false;
    state.requirementVerificationDone = false;
    state.originalUserPrompt = '新任务';

    // After P7 completes in the new run
    state.outputValidationDone = true;
    expect(shouldTriggerP0(state)).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Message Construction Tests
// ----------------------------------------------------------------------------

describe('P0 Requirement Verification - Message Construction', () => {
  it('should include original prompt in triple-quoted block', () => {
    const msg = buildP0Message({
      originalUserPrompt: '请按部门汇总销售额，生成透视表',
      newFiles: ['/work/output.xlsx'],
      structureInfo: null,
    });

    expect(msg).toContain('"""\n请按部门汇总销售额，生成透视表\n"""');
  });

  it('should show file basenames (not full paths)', () => {
    const msg = buildP0Message({
      originalUserPrompt: '任务',
      newFiles: [
        '/Users/test/workspace/销售报表.xlsx',
        '/Users/test/workspace/summary.csv',
      ],
      structureInfo: null,
    });

    expect(msg).toContain('当前输出文件: 销售报表.xlsx, summary.csv');
    expect(msg).not.toContain('/Users/test/workspace/');
  });

  it('should show "无" when no output files exist', () => {
    const msg = buildP0Message({
      originalUserPrompt: '任务',
      newFiles: [],
      structureInfo: null,
    });

    expect(msg).toContain('当前输出文件: 无');
  });

  it('should include structure info when available', () => {
    const structure = `File: /work/output.xlsx
  Sheet 'Sheet1': 50 rows x 5 cols
  Columns: ['部门', '销售额', '占比', '排名', '增长率']`;

    const msg = buildP0Message({
      originalUserPrompt: '任务',
      newFiles: ['/work/output.xlsx'],
      structureInfo: structure,
    });

    expect(msg).toContain('当前输出结构:');
    expect(msg).toContain("Sheet 'Sheet1': 50 rows x 5 cols");
    expect(msg).toContain("['部门', '销售额', '占比', '排名', '增长率']");
  });

  it('should omit structure section when structureInfo is null', () => {
    const msg = buildP0Message({
      originalUserPrompt: '任务',
      newFiles: ['/work/output.xlsx'],
      structureInfo: null,
    });

    expect(msg).not.toContain('当前输出结构:');
  });

  it('should wrap content in <requirement-verification> tags', () => {
    const msg = buildP0Message({
      originalUserPrompt: '任务',
      newFiles: [],
      structureInfo: null,
    });

    expect(msg).toMatch(/^<requirement-verification>\n/);
    expect(msg).toMatch(/<\/requirement-verification>$/);
  });

  it('should include verification instruction', () => {
    const msg = buildP0Message({
      originalUserPrompt: '任务',
      newFiles: [],
      structureInfo: null,
    });

    expect(msg).toContain('逐条确认每项需求都有对应输出');
    expect(msg).toContain('如有遗漏，立即补充');
    expect(msg).toContain('如全部满足，结束任务');
  });
});

// ----------------------------------------------------------------------------
// Xlsx File Filtering Tests
// ----------------------------------------------------------------------------

describe('P0 Requirement Verification - File Filtering', () => {
  /**
   * Mirrors the xlsx filter logic in the P0 block:
   *   allNewFiles.filter(f => f.endsWith('.xlsx') || f.endsWith('.xls'))
   */
  function filterXlsx(files: string[]): string[] {
    return files.filter(f => f.endsWith('.xlsx') || f.endsWith('.xls'));
  }

  it('should filter xlsx and xls files from new output files', () => {
    const files = [
      '/work/report.xlsx',
      '/work/data.csv',
      '/work/legacy.xls',
      '/work/script.py',
      '/work/chart.png',
    ];

    const xlsx = filterXlsx(files);
    expect(xlsx).toEqual(['/work/report.xlsx', '/work/legacy.xls']);
  });

  it('should return empty array when no xlsx files exist', () => {
    const files = ['/work/data.csv', '/work/output.json'];
    expect(filterXlsx(files)).toEqual([]);
  });

  it('should handle empty file list', () => {
    expect(filterXlsx([])).toEqual([]);
  });
});
