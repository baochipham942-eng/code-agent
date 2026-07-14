/**
 * ADR-040 C1 — PPTX 显示页序与物理 slide part 的唯一对账口径。
 *
 * OOXML 的真实显示顺序来自 presentation.xml 的 sldIdLst；slideN.xml 的 N 只是
 * package part 名，不能代表用户看到的页序。这个模块不依赖 Node API，因此 host
 * 的文件 resolver 与 renderer 的上传摘要可以消费同一份解析逻辑。
 */

export interface PresentationPackageZipEntry {
  name: string;
  dir: boolean;
  async(type: 'string'): Promise<string>;
}

export interface PresentationPackageZip {
  files: Record<string, PresentationPackageZipEntry>;
}

export interface PresentationPackageIndexEntry {
  /** 0-based，严格等于 presentation.xml 中的显示顺序。 */
  displayIndex: number;
  relationshipId: string;
  /** ppt/slides/slide7.xml */
  slidePartName: string;
  textFingerprint: string;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    const codePoint = Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function xmlAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attributes);
  return match ? decodeXmlEntities(match[2]) : null;
}

/** slide 内全部 a:t，按文档顺序聚合；空白差异不制造假 drift。 */
export function extractPresentationSlideText(xml: string): string[] {
  const runs: string[] = [];
  const textRegex = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml)) !== null) {
    const text = decodeXmlEntities(match[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) runs.push(text);
  }
  return runs;
}

/**
 * 读写两侧共用的文本指纹。revision 已负责强身份校验；这里用稳定 64-bit FNV-1a
 * 检测 locator 的局部文本是否仍与 resolver 结果一致，避免在 metadata 中保存正文。
 */
export function presentationTextFingerprint(textRuns: readonly string[]): string {
  const normalized = textRuns.map((run) => run.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(normalized)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function normalizeSlideTarget(target: string): string | null {
  const normalized = target.replace(/\\/g, '/');
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return null;

  const rooted = normalized.startsWith('/')
    ? normalized.slice(1)
    : normalized.startsWith('ppt/')
      ? normalized
      : `ppt/${normalized}`;
  const segments: string[] = [];
  for (const segment of rooted.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const partName = segments.join('/');
  return /^ppt\/slides\/slide[1-9][0-9]*\.xml$/i.test(partName) ? partName : null;
}

/**
 * presentation.xml -> relationship -> slide part -> text fingerprint。
 * 任一关系缺失或指向不存在的 part 都抛错，调用方必须 fail-closed。
 */
export async function resolvePresentationPackageIndexFromZip(
  zip: PresentationPackageZip,
): Promise<PresentationPackageIndexEntry[]> {
  const presentationEntry = zip.files['ppt/presentation.xml'];
  const relationshipsEntry = zip.files['ppt/_rels/presentation.xml.rels'];
  if (!presentationEntry || presentationEntry.dir) throw new Error('PPTX 缺少 ppt/presentation.xml');
  if (!relationshipsEntry || relationshipsEntry.dir) {
    throw new Error('PPTX 缺少 ppt/_rels/presentation.xml.rels');
  }

  const [presentationXml, relationshipsXml] = await Promise.all([
    presentationEntry.async('string'),
    relationshipsEntry.async('string'),
  ]);

  const relationships = new Map<string, string>();
  const relationshipRegex = /<(?:\w+:)?Relationship\b([^>]*)\/?\s*>/gi;
  let relationshipMatch: RegExpExecArray | null;
  while ((relationshipMatch = relationshipRegex.exec(relationshipsXml)) !== null) {
    if (xmlAttribute(relationshipMatch[1], 'TargetMode')?.toLowerCase() === 'external') continue;
    const id = xmlAttribute(relationshipMatch[1], 'Id');
    const target = xmlAttribute(relationshipMatch[1], 'Target');
    const slidePartName = target ? normalizeSlideTarget(target) : null;
    if (id && slidePartName) relationships.set(id, slidePartName);
  }

  const slideIds: string[] = [];
  const slideIdRegex = /<(?:\w+:)?sldId\b([^>]*)\/?\s*>/gi;
  let slideIdMatch: RegExpExecArray | null;
  while ((slideIdMatch = slideIdRegex.exec(presentationXml)) !== null) {
    const relationshipId = xmlAttribute(slideIdMatch[1], 'r:id');
    if (!relationshipId) throw new Error('presentation.xml 的 sldId 缺少 r:id');
    slideIds.push(relationshipId);
  }
  if (slideIds.length === 0) throw new Error('presentation.xml 的 sldIdLst 为空');

  const index: PresentationPackageIndexEntry[] = [];
  for (const [displayIndex, relationshipId] of slideIds.entries()) {
    const slidePartName = relationships.get(relationshipId);
    if (!slidePartName) throw new Error(`找不到 presentation relationship：${relationshipId}`);
    const slideEntry = zip.files[slidePartName];
    if (!slideEntry || slideEntry.dir) throw new Error(`找不到 slide part：${slidePartName}`);
    const slideXml = await slideEntry.async('string');
    index.push({
      displayIndex,
      relationshipId,
      slidePartName,
      textFingerprint: presentationTextFingerprint(extractPresentationSlideText(slideXml)),
    });
  }
  return index;
}
