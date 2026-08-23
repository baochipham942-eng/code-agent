type DocumentParagraphType = 'heading' | 'paragraph' | 'list-item';

export interface DocxPreviewResult {
  html: string;
  paragraphs: Array<{
    index: number;
    type: string;
    text: string;
    level?: number;
    textFingerprint?: string;
    previousTextFingerprint?: string;
    nextTextFingerprint?: string;
  }>;
  text: string;
  wordCount: number;
}

export interface ExcelPreviewResult {
  sheets: Array<{ name: string; headers: string[]; rows: unknown[][]; rowCount: number }>;
  sheetCount: number;
}

export interface PresentationInspection {
  filePath: string;
  format: 'pptx';
  slideCount: number;
  shownCount: number;
  truncated: boolean;
  slides: Array<{ index: number; name: string; title?: string; text: string[] }>;
}

export interface DesignPptScreenshotArtifact {
  kind: 'design_ppt';
  title?: string;
  theme?: string;
  outputPath?: string;
  screenshots: string[];
  slidesCount?: number;
}

export interface LoadedSnapshot {
  tabId: string;
  savedContent: string;
  content: string;
}

export interface ArchiveInspection {
  filePath: string;
  format: 'zip';
  entryCount: number;
  shownCount: number;
  truncated: boolean;
  entries: Array<{ name: string; isDirectory: boolean; depth: number; extension?: string }>;
}

export function shouldFlashOnDiskLoad(
  prev: LoadedSnapshot | null,
  next: { tabId: string; savedContent: string },
): boolean {
  if (prev?.tabId !== next.tabId) return false;
  if (next.savedContent === prev.savedContent) return false;
  return next.savedContent !== prev.content;
}

export function parseDesignPptArtifactContent(content: string): DesignPptScreenshotArtifact | null {
  try {
    const parsed = JSON.parse(content) as Partial<DesignPptScreenshotArtifact>;
    return parsed?.kind === 'design_ppt'
      && Array.isArray(parsed.screenshots)
      && parsed.screenshots.length > 0
      ? parsed as DesignPptScreenshotArtifact
      : null;
  } catch {
    return null;
  }
}

export function getExtension(filePath: string | null | undefined): string {
  if (!filePath) return '';
  const idx = filePath.lastIndexOf('.');
  return idx < 0 ? '' : filePath.slice(idx + 1).toLowerCase();
}

export function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() || filePath;
}

function normalizeDocumentParagraphType(value: string): DocumentParagraphType {
  return value === 'heading' || value === 'list-item' ? value : 'paragraph';
}

function paragraphsFromRawText(text: string): DocxPreviewResult['paragraphs'] {
  return text.split(/\n{2,}|\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 500)
    .map((line, index) => ({ index, type: 'paragraph', text: line }));
}

export function buildDocxPreviewSpec(filePath: string, result: DocxPreviewResult): string {
  const normalized = result.paragraphs.map((paragraph, index) => ({
    index: typeof paragraph.index === 'number' ? paragraph.index : index,
    type: normalizeDocumentParagraphType(paragraph.type),
    text: paragraph.text.trim(),
    level: paragraph.level,
    textFingerprint: paragraph.textFingerprint,
    previousTextFingerprint: paragraph.previousTextFingerprint,
    nextTextFingerprint: paragraph.nextTextFingerprint,
  })).filter((paragraph) => paragraph.text.length > 0);
  const paragraphs = normalized.length > 0 ? normalized : paragraphsFromRawText(result.text);
  if (paragraphs.length === 0) throw new Error('DOCX preview has no readable paragraphs');
  return JSON.stringify({
    title: basename(filePath).replace(/\.docx$/i, ''), paragraphs, text: result.text, wordCount: result.wordCount,
  });
}

export function buildExcelPreviewSpec(filePath: string, result: ExcelPreviewResult): string {
  const sheets = result.sheets.filter((sheet) => sheet.headers.length > 0 || sheet.rows.length > 0);
  if (sheets.length === 0) throw new Error('Excel preview has no readable sheets');
  return JSON.stringify({
    title: basename(filePath).replace(/\.(xlsx|xls)$/i, ''),
    sheets,
    sheetCount: result.sheetCount || sheets.length,
  });
}

export function toPreviewErrorState(
  err: unknown,
  fallbackMessage: string,
): { message: string; detail: string } {
  return { message: fallbackMessage, detail: err instanceof Error ? err.message : String(err) };
}

export function parseArchiveInspection(content: string): ArchiveInspection | null {
  try {
    const parsed = JSON.parse(content) as ArchiveInspection;
    return parsed && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}
