// ============================================================================
// xlsx rels 命名空间前缀规范化（#1995）
//
// 部分 xlsx 生成器（如某些 Java/Go 写库）会把 `.rels` 部件写成
// `<ns1:Relationships xmlns:ns1="...relationships">`。ExcelJS 4.4.0 的
// RelationshipsXform 按节点全名（`node.name === 'Relationships'`）匹配，
// 遇到 `ns1:Relationships` 直接抛
// `Unexpected xml node in parseOpen: {"name":"ns1:Relationships",...}`，
// 而 openpyxl / Excel 本身都能正常打开这类文件。
//
// ExcelJS 已停更，不动 node_modules；这里在 readFile 抛该特定错误时把 zip 内
// 所有 `.rels` 部件的命名空间前缀剥掉、重打包后用 `workbook.xlsx.load` 重试。
// 只处理用户会撞上的 rels 解析路径，不重写解析器。
// ============================================================================

import * as fsp from 'fs/promises';
import JSZip from 'jszip';

const RELS_NS_URI = 'http://schemas.openxmlformats.org/package/2006/relationships';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判断 ExcelJS 抛的是否是「带命名空间前缀的 Relationships 节点」这一已知缺陷。 */
export function isNsPrefixedRelationshipsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Unexpected xml node in parseOpen') &&
    /"name":"[^"]*:Relationships"/.test(message)
  );
}

/**
 * 剥掉 rels XML 里 `Relationships`/`Relationship` 元素上的命名空间前缀。
 * 无前缀时原样返回（调用方靠返回值是否变化决定是否重写 zip 条目）。
 */
function stripRelationshipsNsPrefix(xml: string): string {
  let out = xml;
  // 罕见情况下同一文件可能用多个前缀，循环直到没有带前缀的 Relationships 为止
  for (let guard = 0; guard < 8; guard++) {
    const match = out.match(/<([A-Za-z_][\w.-]*):Relationships[\s/>]/);
    if (!match) break;
    const prefix = escapeRegExp(match[1]);
    out = out
      .replace(new RegExp(`</${prefix}:`, 'g'), '</')
      .replace(new RegExp(`<${prefix}:`, 'g'), '<')
      // 前缀声明换成默认命名空间，保持规范化后的文档语义等价
      .replace(
        new RegExp(`xmlns:${prefix}="${escapeRegExp(RELS_NS_URI)}"`),
        `xmlns="${RELS_NS_URI}"`,
      );
  }
  return out;
}

/**
 * 读取 xlsx，重写所有带命名空间前缀的 `.rels` 部件，返回重打包后的 buffer。
 * 供 `workbook.xlsx.load(buffer)` 使用。
 */
export async function normalizeXlsxRelationshipsNamespaces(filePath: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await fsp.readFile(filePath));
  const relsEntries = Object.keys(zip.files).filter((name) => name.endsWith('.rels'));
  for (const name of relsEntries) {
    const entry = zip.file(name);
    if (!entry) continue;
    const xml = await entry.async('string');
    const stripped = stripRelationshipsNsPrefix(xml);
    if (stripped !== xml) {
      zip.file(name, stripped);
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
