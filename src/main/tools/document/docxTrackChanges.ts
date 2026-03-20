// ============================================================================
// DOCX Track Changes - 修订标记支持
// ============================================================================
// 为 DOCX 文件添加 Track Changes（修订追踪）能力
// 用于合同审阅、法务修订等协作场景
// ============================================================================

let _revisionId = 100; // 起始 RSID，递增

/**
 * 生成递增的修订 ID
 */
export function generateRevisionId(): number {
  return _revisionId++;
}

/**
 * XML 转义
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 在 word/settings.xml 中启用修订追踪
 */
export async function enableTrackChanges(zip: any): Promise<void> {
  const settingsFile = 'word/settings.xml';
  if (!zip.files[settingsFile]) return;

  let xml: string = await zip.files[settingsFile].async('string');

  // 检查是否已启用
  if (xml.includes('<w:trackChanges/>') || xml.includes('<w:trackChanges ')) {
    return;
  }

  // 在 </w:settings> 前插入
  xml = xml.replace('</w:settings>', '<w:trackChanges/></w:settings>');
  zip.file(settingsFile, xml);
}

/**
 * 创建/更新 word/people.xml
 */
export async function ensurePeopleXml(zip: any, author: string): Promise<void> {
  const peopleFile = 'word/people.xml';
  const escapedAuthor = escapeXml(author);

  if (zip.files[peopleFile]) {
    let xml: string = await zip.files[peopleFile].async('string');
    // 检查 author 是否已存在
    if (!xml.includes(`w15:author="${escapedAuthor}"`)) {
      const personEntry = `<w15:person w15:author="${escapedAuthor}"><w15:presenceInfo w15:providerId="None" w15:userId="${escapedAuthor.toLowerCase().replace(/\s+/g, '-')}"/></w15:person>`;
      xml = xml.replace('</w15:people>', personEntry + '</w15:people>');
      zip.file(peopleFile, xml);
    }
  } else {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
  <w15:person w15:author="${escapedAuthor}">
    <w15:presenceInfo w15:providerId="None" w15:userId="${escapedAuthor.toLowerCase().replace(/\s+/g, '-')}"/>
  </w15:person>
</w15:people>`;
    zip.file(peopleFile, xml);

    // 更新 Content_Types 和 relationships
    await ensurePeopleRelationships(zip);
  }
}

/**
 * 确保 people.xml 被正确引用
 */
async function ensurePeopleRelationships(zip: any): Promise<void> {
  // 更新 [Content_Types].xml
  const ctFile = '[Content_Types].xml';
  if (zip.files[ctFile]) {
    let ct: string = await zip.files[ctFile].async('string');
    if (!ct.includes('people.xml')) {
      ct = ct.replace('</Types>',
        '<Override PartName="/word/people.xml" ContentType="application/vnd.ms-word.people+xml"/></Types>');
      zip.file(ctFile, ct);
    }
  }

  // 更新 word/_rels/document.xml.rels
  const relsFile = 'word/_rels/document.xml.rels';
  if (zip.files[relsFile]) {
    let rels: string = await zip.files[relsFile].async('string');
    if (!rels.includes('people.xml')) {
      rels = rels.replace('</Relationships>',
        '<Relationship Id="rIdPeople" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/></Relationships>');
      zip.file(relsFile, rels);
    }
  }
}

/**
 * 生成 ISO 日期字符串
 */
function toISODate(date?: string): string {
  return date || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 包裹插入修订标记
 */
export function wrapInsertion(text: string, author: string, date?: string): string {
  const id = generateRevisionId();
  const escaped = escapeXml(text);
  const isoDate = toISODate(date);
  return `<w:ins w:id="${id}" w:author="${escapeXml(author)}" w:date="${isoDate}"><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:ins>`;
}

/**
 * 包裹删除修订标记
 */
export function wrapDeletion(text: string, author: string, date?: string): string {
  const id = generateRevisionId();
  const escaped = escapeXml(text);
  const isoDate = toISODate(date);
  return `<w:del w:id="${id}" w:author="${escapeXml(author)}" w:date="${isoDate}"><w:r><w:delText xml:space="preserve">${escaped}</w:delText></w:r></w:del>`;
}
