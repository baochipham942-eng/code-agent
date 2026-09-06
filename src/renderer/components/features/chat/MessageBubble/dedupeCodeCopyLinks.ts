import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Nodes } from 'mdast';
import { isChartSpecSource } from '@shared/chartSpec';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const SPECIAL_BLOCKS = new Set([
  'mermaid', 'chart', 'generative_ui', 'neo_ui', 'spreadsheet', 'document',
]);

/** Remove copy-only paragraphs immediately before/after an ordinary fenced block.
 * Blank lines do not break adjacency; prose and container boundaries do.
 * Run before streaming splits the document so either side sees its neighbour.
 */
export function dedupeCodeCopyLinks(source: string): string {
  if (!source.includes('!copy')) return source;

  const ranges: Array<{ start: number; end: number }> = [];
  const hasCopyHeader = (node: Nodes | undefined): boolean => {
    if (node?.type !== 'code') return false;
    const start = node.position?.start.offset;
    if (start === undefined || !/^(?:`{3,}|~{3,})/.test(source.slice(start))) return false;
    const language = node.lang || '';
    return !SPECIAL_BLOCKS.has(language)
      && !(language === 'json' && isChartSpecSource(node.value));
  };

  const visit = (node: Nodes): void => {
    if (!('children' in node)) return;
    node.children.forEach((child, index, siblings) => {
      if (child.type === 'paragraph') {
        const meaningful = child.children.filter(part => part.type !== 'text' || part.value.trim());
        const link = meaningful.length === 1 ? meaningful[0] : undefined;
        if (link?.type === 'link' && link.url === '!copy'
          && (hasCopyHeader(siblings[index - 1]) || hasCopyHeader(siblings[index + 1]))) {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          if (start !== undefined && end !== undefined) ranges.push({ start, end });
        }
      }
      visit(child);
    });
  };
  visit(parser.parse(source));

  // Preserve line breaks and offsets used by source ordinals and streaming blocks.
  let result = source;
  for (const { start, end } of ranges.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  }
  return result;
}
