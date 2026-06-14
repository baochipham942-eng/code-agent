import { describe, expect, it } from 'vitest';
import { isPreviewable } from '../../../src/renderer/utils/previewable';

describe('isPreviewable', () => {
  it('treats Office documents with inline renderers as previewable', () => {
    expect(isPreviewable('/tmp/report.docx')).toBe(true);
    expect(isPreviewable('/tmp/budget.xlsx')).toBe(true);
    expect(isPreviewable('/tmp/archive.xls')).toBe(true);
    expect(isPreviewable('/tmp/slides.pptx')).toBe(true);
  });

  it('keeps unsupported Office formats out of inline preview', () => {
    expect(isPreviewable('/tmp/legacy.doc')).toBe(false);
    expect(isPreviewable('/tmp/slides.ppt')).toBe(false);
  });
});
