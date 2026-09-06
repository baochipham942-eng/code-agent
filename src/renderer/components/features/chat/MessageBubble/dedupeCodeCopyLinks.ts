import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Nodes } from 'mdast';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** 围栏语言里唯一**没有**块头复制按钮的那种：`neo_ui` 走 `GenerativeUIHost`
 * （MessageContent.tsx:211），该组件不渲染复制按钮，所以紧邻的 `[…](!copy)` 是用户
 * 唯一的复制入口，删掉就是净损失。
 *
 * 其余曾被一并排除的语言都**有**自己的块头复制按钮，旁边的 !copy 属重复、该删：
 * mermaid→MermaidDiagram、chart 与 json+chartSpec→ChartBlock、generative_ui→
 * GenerativeUIBlock、spreadsheet→SpreadsheetBlock、document→DocumentBlock，
 * 各自都有 handleCopy（2026-09-06 逐个核实）。
 */
const NO_COPY_HEADER = new Set(['neo_ui']);

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
    return !NO_COPY_HEADER.has(node.lang || '');
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
