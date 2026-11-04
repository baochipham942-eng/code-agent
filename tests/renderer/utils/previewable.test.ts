import { describe, expect, it } from 'vitest';
import {
  PREVIEWABLE_EXTENSIONS,
  getFileExtension,
  isPreviewable,
  previewDispatch,
  type PreviewDispatch,
} from '../../../src/renderer/utils/previewable';

const NEW_EXTENSIONS = [
  'py', 'sh', 'bash', 'zsh', 'css', 'scss', 'sql', 'xml', 'toml', 'ini', 'log',
  'go', 'rs', 'java', 'c', 'cpp', 'h', 'swift', 'kt', 'rb', 'php', 'txt',
  'heic', 'heif',
  'doc', 'ppt', 'key', 'pages', 'numbers',
  'tar', 'gz', 'tgz', 'rar', '7z',
] as const;

function primaryFlags(dispatch: PreviewDispatch): string[] {
  return [
    dispatch.isMarkdown ? 'markdown' : '',
    dispatch.isCsv ? 'table' : '',
    dispatch.isHtml ? 'html' : '',
    dispatch.isCode ? 'code' : '',
    dispatch.isImage ? 'image' : '',
    dispatch.isPdf ? 'pdf' : '',
    dispatch.isAudio ? 'audio' : '',
    dispatch.isVideo ? 'video' : '',
    dispatch.isArchive ? 'archive' : '',
    dispatch.isDocx ? 'docx' : '',
    dispatch.isExcel ? 'excel' : '',
    dispatch.isPresentation ? 'presentation' : '',
    dispatch.isText ? 'text' : '',
    dispatch.isHeic ? 'heic' : '',
    dispatch.isLegacyOffice ? 'legacy-office' : '',
  ].filter(Boolean);
}

describe('isPreviewable', () => {
  it('treats Office documents with inline renderers as previewable', () => {
    expect(isPreviewable('/tmp/report.docx')).toBe(true);
    expect(isPreviewable('/tmp/budget.xlsx')).toBe(true);
    expect(isPreviewable('/tmp/archive.xls')).toBe(true);
    expect(isPreviewable('/tmp/slides.pptx')).toBe(true);
  });

  it('previews legacy Office in the side panel', () => {
    expect(isPreviewable('/tmp/legacy.doc')).toBe(true);
    expect(isPreviewable('/tmp/slides.ppt')).toBe(true);
    expect(isPreviewable('/tmp/deck.key')).toBe(true);
    expect(isPreviewable('/tmp/notes.pages')).toBe(true);
    expect(isPreviewable('/tmp/sheet.numbers')).toBe(true);
  });

  it('previews every newly added extension', () => {
    for (const ext of NEW_EXTENSIONS) {
      expect(isPreviewable(`/tmp/sample.${ext}`), ext).toBe(true);
    }
  });

  it('reads the extension from the basename', () => {
    expect(getFileExtension('/tmp/dir.old/file.py')).toBe('py');
    expect(getFileExtension('/tmp/a.tar.gz')).toBe('gz');
    expect(getFileExtension('/tmp/.gitignore')).toBe('');
    expect(isPreviewable('/tmp/.gitignore')).toBe(false);
  });
});

describe('previewDispatch', () => {
  it('renders every previewable extension as exactly one panel kind', () => {
    for (const ext of PREVIEWABLE_EXTENSIONS) {
      const dispatch = previewDispatch(`/tmp/sample.${ext}`);
      expect(dispatch.rendersInPanel, ext).toBe(true);
      expect(primaryFlags(dispatch), ext).toEqual([dispatch.kind]);
    }
  });

  it('keeps editable code, read-only text, and sniffed names apart', () => {
    expect(previewDispatch('/tmp/app.ts')).toMatchObject({
      kind: 'code', isCode: true, codeLanguage: 'typescript', rendersInPanel: true,
    });
    expect(previewDispatch('/tmp/main.py')).toMatchObject({
      kind: 'text', isText: true, shikiLanguage: 'python', rendersInPanel: true,
    });
    expect(previewDispatch('/tmp/photo.heic')).toMatchObject({ kind: 'heic', isHeic: true });
    expect(previewDispatch('/tmp/legacy.doc')).toMatchObject({ kind: 'legacy-office', isLegacyOffice: true });
    expect(previewDispatch('/tmp/bundle.7z')).toMatchObject({ kind: 'archive', isArchive: true });
    expect(previewDispatch('/tmp/notes')).toMatchObject({
      kind: 'text', isText: true, shikiLanguage: null, rendersInPanel: true,
    });
    expect(previewDispatch('/tmp/file.xyz').rendersInPanel).toBe(false);
  });
});
