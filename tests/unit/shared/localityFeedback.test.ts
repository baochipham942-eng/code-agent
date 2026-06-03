import { describe, expect, it } from 'vitest';
import { buildLocalityFeedbackMessage } from '../../../src/shared/livePreview/localityFeedback';

describe('buildLocalityFeedbackMessage', () => {
  it('PPT 锚点：带 file_path + 0-based slide_index + 第N页可读 + ppt_edit 引导', () => {
    const msg = buildLocalityFeedbackMessage(
      { kind: 'ppt', filePath: '/tmp/deck.pptx', slideIndex: 2, displayName: 'deck.pptx' },
      '把这页标题改成季度总结',
    );
    expect(msg).toContain('/tmp/deck.pptx');
    expect(msg).toContain('slide_index=2');
    expect(msg).toContain('第 3 页'); // slideIndex 2 → 第 3 页（1-based 展示）
    expect(msg).toContain('ppt_edit');
    expect(msg).toContain('把这页标题改成季度总结');
    expect(msg).toContain('只改这一页');
    expect(msg).toContain('《deck.pptx》');
  });

  it('PPT 锚点：无 displayName 时从路径取文件名', () => {
    const msg = buildLocalityFeedbackMessage(
      { kind: 'ppt', filePath: '/a/b/季度汇报.pptx', slideIndex: 0 },
      'x',
    );
    expect(msg).toContain('《季度汇报.pptx》');
    expect(msg).toContain('slide_index=0');
    expect(msg).toContain('第 1 页');
  });

  it('表格锚点：带 cell + 工作表 + 编辑工具引导', () => {
    const msg = buildLocalityFeedbackMessage(
      { kind: 'sheet', filePath: '/tmp/data.xlsx', cell: 'B7', sheetName: 'Sheet1', displayName: 'data.xlsx' },
      '这个数改成 42000',
    );
    expect(msg).toContain('/tmp/data.xlsx');
    expect(msg).toContain('B7');
    expect(msg).toContain('Sheet1');
    expect(msg).toContain('单元格 B7');
    expect(msg).toMatch(/DocEdit|excel_edit/);
    expect(msg).toContain('这个数改成 42000');
  });

  it('表格锚点：无工作表名时不带工作表从句', () => {
    const msg = buildLocalityFeedbackMessage(
      { kind: 'sheet', filePath: '/tmp/d.csv', cell: 'A1' },
      'y',
    );
    expect(msg).toContain('单元格 A1');
    expect(msg).not.toContain('工作表「');
  });

  it('反馈文本首尾空白被裁剪', () => {
    const msg = buildLocalityFeedbackMessage(
      { kind: 'ppt', filePath: '/d.pptx', slideIndex: 1 },
      '  改大字号  ',
    );
    expect(msg).toContain('：改大字号。');
  });
});
