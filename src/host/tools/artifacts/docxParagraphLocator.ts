import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import JSZip from 'jszip';

/**
 * Word 可执行坐标的唯一读侧来源。
 *
 * 这里故意使用与 docxEditCore.ts 完全相同的 `<w:p>` 谓词：写侧按 document.xml 中
 * 所有段落（包括空段落、表格单元格里的段落）计数，预览侧也必须按同一序列计数。
 */
const DOCX_PARAGRAPH_PATTERN = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const DOCX_TEXT_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;

export interface DocxParagraphCoordinate {
  index: number;
  type: 'heading' | 'paragraph' | 'list-item';
  text: string;
  level?: number;
  textFingerprint: string;
  previousTextFingerprint?: string;
  nextTextFingerprint?: string;
}

export interface DocxParagraphTargetSnapshot {
  kind: 'docx-paragraph';
  partName: 'word/document.xml';
  paragraphIndex: number;
  textFingerprint: string;
  previousTextFingerprint?: string;
  nextTextFingerprint?: string;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** Word 的 run 拆分不应改变用户看到的段落文本或指纹。 */
export function normalizeDocxParagraphText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function fingerprintDocxParagraphText(value: string): string {
  return createHash('sha256').update(normalizeDocxParagraphText(value), 'utf8').digest('hex');
}

function paragraphText(paragraphXml: string): string {
  const runs: string[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(DOCX_TEXT_PATTERN.source, DOCX_TEXT_PATTERN.flags);
  while ((match = pattern.exec(paragraphXml)) !== null) {
    runs.push(decodeXmlText(match[1].replace(/<[^>]+>/g, '')));
  }
  return normalizeDocxParagraphText(runs.join(''));
}

function paragraphPresentation(paragraphXml: string): Pick<DocxParagraphCoordinate, 'type' | 'level'> {
  const properties = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(paragraphXml)?.[1] ?? '';
  const styleElement = /<w:pStyle\b[^>]*\/?\s*>/.exec(properties)?.[0] ?? '';
  const style = /\bw:val=(?:"([^"]+)"|'([^']+)')/.exec(styleElement);
  const heading = /^(?:Heading|heading)\s*([1-6])$/.exec(style?.[1] ?? style?.[2] ?? '');
  if (heading) return { type: 'heading', level: Number.parseInt(heading[1], 10) };
  if (/<w:numPr\b[^>]*>[\s\S]*?<\/w:numPr>|<w:numPr\b[^>]*\/\s*>/.test(properties)) {
    return { type: 'list-item' };
  }
  return { type: 'paragraph' };
}

/**
 * 返回可渲染段落，但 index 始终是 document.xml 全部 `<w:p>` 的原始 0-based 序号。
 * 空段落不返回 UI，后续段落的 index 仍保留间隙。
 */
export function parseDocxDocumentParagraphs(documentXml: string): DocxParagraphCoordinate[] {
  const allParagraphs = documentXml.match(DOCX_PARAGRAPH_PATTERN) ?? [];
  const visible = allParagraphs.flatMap((paragraphXml, index) => {
    const text = paragraphText(paragraphXml);
    if (!text) return [];
    return [{
      index,
      text,
      textFingerprint: fingerprintDocxParagraphText(text),
      ...paragraphPresentation(paragraphXml),
    } satisfies DocxParagraphCoordinate];
  });

  return visible.map((paragraph, visibleIndex) => ({
    ...paragraph,
    ...(visibleIndex > 0
      ? { previousTextFingerprint: visible[visibleIndex - 1].textFingerprint }
      : {}),
    ...(visibleIndex + 1 < visible.length
      ? { nextTextFingerprint: visible[visibleIndex + 1].textFingerprint }
      : {}),
  }));
}

export async function extractDocxParagraphsFromBuffer(buffer: Buffer): Promise<DocxParagraphCoordinate[]> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = zip.file('word/document.xml');
  if (!documentXml) throw new Error('Invalid DOCX: word/document.xml not found');
  return parseDocxDocumentParagraphs(await documentXml.async('string'));
}

export async function readDocxParagraphs(filePath: string): Promise<DocxParagraphCoordinate[]> {
  return extractDocxParagraphsFromBuffer(await fs.readFile(filePath));
}

/** Host 侧以源文件为真源，renderer 只提交用户选中的原始 paragraphIndex。 */
export async function resolveDocxParagraphTarget(
  filePath: string,
  paragraphIndex: number,
): Promise<{ target: DocxParagraphTargetSnapshot; paragraph: DocxParagraphCoordinate } | null> {
  const paragraph = (await readDocxParagraphs(filePath)).find((item) => item.index === paragraphIndex);
  if (!paragraph) return null;
  return {
    paragraph,
    target: {
      kind: 'docx-paragraph',
      partName: 'word/document.xml',
      paragraphIndex: paragraph.index,
      textFingerprint: paragraph.textFingerprint,
      ...(paragraph.previousTextFingerprint
        ? { previousTextFingerprint: paragraph.previousTextFingerprint }
        : {}),
      ...(paragraph.nextTextFingerprint
        ? { nextTextFingerprint: paragraph.nextTextFingerprint }
        : {}),
    },
  };
}

export async function docxParagraphTargetStillMatches(
  filePath: string,
  target: DocxParagraphTargetSnapshot,
): Promise<boolean> {
  const resolved = await resolveDocxParagraphTarget(filePath, target.paragraphIndex);
  if (!resolved) return false;
  return resolved.target.textFingerprint === target.textFingerprint
    && resolved.target.previousTextFingerprint === target.previousTextFingerprint
    && resolved.target.nextTextFingerprint === target.nextTextFingerprint;
}
