// ============================================================================
// GAIA 二期 — importer 附件题支持（逻辑上移 src 进 typecheck 范围）
// ============================================================================
// 一期 scripts/gaia-import.ts 用 --no-file-only 排除 38 道附件题；二期
// buildGaiaSuite 落 src/host/testing/gaiaImporter.ts：附件题生成 files 字段
// （source 指向本地附件目录），prompt 告知模型附件在工作目录，不再排除。
// ============================================================================

import { describe, expect, it } from 'vitest';
import path from 'path';
import { buildGaiaSuite, type GaiaRow } from '../../../src/host/testing/gaiaImporter';

const FILES_DIR = '/home/u/.code-agent/gaia/files';

function row(overrides: Partial<GaiaRow> = {}): GaiaRow {
  return {
    task_id: 'abcd1234-0000-0000-0000-000000000000',
    Question: 'What is the answer?',
    Level: 1,
    'Final answer': '42',
    ...overrides,
  };
}

describe('buildGaiaSuite 附件题', () => {
  it('带 file_name 的题生成 files 字段，source 指向附件目录', () => {
    const suite = buildGaiaSuite([row({ file_name: 'sheet.xlsx' })], { filesDir: FILES_DIR });
    expect(suite.cases[0].files).toEqual([
      { source: path.join(FILES_DIR, 'sheet.xlsx') },
    ]);
  });

  it('附件题 prompt 告知模型文件在工作目录（按原文件名）', () => {
    const suite = buildGaiaSuite([row({ file_name: 'sheet.xlsx' })], { filesDir: FILES_DIR });
    expect(suite.cases[0].prompt).toContain('sheet.xlsx');
    expect(suite.cases[0].prompt).toMatch(/working directory/i);
  });

  it('无附件题不带 files 字段，prompt 不提附件', () => {
    const suite = buildGaiaSuite([row()], { filesDir: FILES_DIR });
    expect(suite.cases[0].files).toBeUndefined();
    expect(suite.cases[0].prompt).not.toMatch(/working directory/i);
  });

  it('附件题不再被排除：全量转换 165 行含附件行', () => {
    const rows = [row(), row({ task_id: 'efgh5678-0000-0000-0000-000000000000', file_name: 'img.png' })];
    const suite = buildGaiaSuite(rows, { filesDir: FILES_DIR });
    expect(suite.cases).toHaveLength(2);
  });

  it('level 过滤与 limit 保持一期行为', () => {
    const rows = [
      row(),
      row({ task_id: 'l2aa0000-0000-0000-0000-000000000000', Level: 2 }),
      row({ task_id: 'l2bb0000-0000-0000-0000-000000000000', Level: '2' }),
    ];
    const l2 = buildGaiaSuite(rows, { filesDir: FILES_DIR, level: '2' });
    expect(l2.cases.map((c) => c.id)).toEqual(['gaia-l2-l2aa0000', 'gaia-l2-l2bb0000']);
    const limited = buildGaiaSuite(rows, { filesDir: FILES_DIR, limit: 1 });
    expect(limited.cases).toHaveLength(1);
  });

  it('id / final_answer / 超时 / tags 映射与一期一致', () => {
    const suite = buildGaiaSuite([row()], { filesDir: FILES_DIR });
    const c = suite.cases[0];
    expect(c.id).toBe('gaia-l1-abcd1234');
    expect(c.expect.final_answer).toBe('42');
    expect(c.timeout).toBe(600_000);
    expect(c.tags).toEqual(['gaia', 'gaia-l1', 'external-benchmark']);
    expect(c.prompt).toContain('FINAL ANSWER');
    expect(suite.name).toBe('gaia-validation');
  });
});
