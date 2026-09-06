import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Nodes } from 'mdast';
import { isChartSpecSource } from '@shared/chartSpec';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** 这些语言一律不参与去重：**无法在 markdown 预处理层保证它们真会渲染出块头按钮**。
 *
 * 组件里存在 `handleCopy` 只说明「渲染成功时有按钮」，而每一种都带早退分支——
 * ChartBlock `if (!parsedSpec) return null`、SpreadsheetBlock `if (!parsedSpec || !sheet)`、
 * DocumentBlock `if (!parsedSpec || paragraphs.length === 0)`、GenerativeUIBlock
 * `if (!code.trim())`、MermaidDiagram 同样有一处；`neo_ui` 更是走 GenerativeUIHost
 * （MessageContent.tsx:211）压根不渲染复制按钮。
 *
 * 要判准就得在这一层复刻 5 个组件的解析逻辑，且会随它们漂移。取舍是**宁可漏删一个多余
 * 按钮，也不能误删唯一的复制入口**——后者是净损失，前者只是没修干净。
 * （2026-09-06 逐个核实早退分支后收口，见 PR #1682 ai-review 第 2 条。）
 */
const NO_COPY_HEADER = new Set([
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
    // json 且内容是 chart spec 的块同样走 ChartBlock（MessageContent.tsx:197），
    // 一并排除，理由与上面的清单相同。
    return !NO_COPY_HEADER.has(language)
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
