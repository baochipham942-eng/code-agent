import remend from 'remend';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Nodes, Root } from 'mdast';

interface StreamingMarkdownBlock {
  key: string;
  content: string;
  sourceOffset: number;
  isTail: boolean;
}

export interface StreamingMarkdownBlockState {
  source: string;
  blocks: StreamingMarkdownBlock[];
  incremental: boolean;
}

const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath);

const CROSS_BLOCK_REFERENCE_NODES = new Set([
  'definition',
  'footnoteDefinition',
  'linkReference',
  'imageReference',
  'footnoteReference',
]);

function containsCrossBlockReference(node: Nodes): boolean {
  if (CROSS_BLOCK_REFERENCE_NODES.has(node.type)) return true;
  if (!('children' in node) || !Array.isArray(node.children)) return false;
  return node.children.some((child) => containsCrossBlockReference(child));
}

function oneTailBlock(content: string): StreamingMarkdownBlock[] {
  return [{
    key: 'markdown-block-0',
    content: remend(content),
    sourceOffset: 0,
    isTail: true,
  }];
}

function parseStreamingMarkdownBlocks(content: string): {
  blocks: StreamingMarkdownBlock[];
  incremental: boolean;
} {
  if (!content) return { blocks: oneTailBlock(content), incremental: true };

  let tree: Root;
  try {
    tree = markdownParser.parse(content) as Root;
  } catch {
    return { blocks: oneTailBlock(content), incremental: false };
  }

  if (containsCrossBlockReference(tree)) {
    return { blocks: oneTailBlock(content), incremental: false };
  }
  if (tree.children.length < 2) {
    return { blocks: oneTailBlock(content), incremental: true };
  }

  const starts = tree.children.map((child, index) => (
    index === 0 ? 0 : child.position?.start.offset
  ));
  if (starts.some((offset) => typeof offset !== 'number')) {
    return { blocks: oneTailBlock(content), incremental: false };
  }

  return {
    incremental: true,
    blocks: starts.map((sourceOffset, index) => {
      const start = sourceOffset as number;
      const end = (starts[index + 1] as number | undefined) ?? content.length;
      const isTail = index === starts.length - 1;
      const source = content.slice(start, end);
      return {
        key: `markdown-block-${start}`,
        content: isTail ? remend(source) : source,
        sourceOffset: start,
        isTail,
      };
    }),
  };
}

/**
 * Split a streaming document at mdast root-child boundaries. A root child is the
 * parser's top-level markdown block (paragraph, heading, list, fenced code, table,
 * blockquote, and so on), so nested list items and fenced-code lines stay together.
 *
 * The last root child always remains mutable. Earlier children become memo-safe only
 * after the parser has observed the next top-level child. Keys use the source start
 * offset: append-only streaming can extend the tail or add a later block without
 * moving any completed block's key. Separating whitespace belongs to the preceding
 * block, which lets it finalize once and then remain byte-stable.
 *
 * Reference definitions can retroactively change older blocks. Those documents stay
 * as one mutable tail so a reference never resolves differently merely because the
 * renderer split it.
 */
/**
 * Incremental companion used by the React renderer. Once a prefix is complete,
 * later appends reparse only the previous tail plus the new bytes. Completed block
 * objects are reused verbatim, so React.memo receives identical props and references.
 */
export function updateStreamingMarkdownBlockState(
  previous: StreamingMarkdownBlockState | null,
  content: string,
): StreamingMarkdownBlockState {
  if (!previous || !previous.incremental || !content.startsWith(previous.source)) {
    const parsed = parseStreamingMarkdownBlocks(content);
    return { source: content, ...parsed };
  }

  const previousTail = previous.blocks.at(-1);
  if (!previousTail) {
    const parsed = parseStreamingMarkdownBlocks(content);
    return { source: content, ...parsed };
  }

  const tailSource = content.slice(previousTail.sourceOffset);
  const parsedTail = parseStreamingMarkdownBlocks(tailSource);
  if (!parsedTail.incremental) {
    const parsed = parseStreamingMarkdownBlocks(content);
    return { source: content, ...parsed };
  }

  const adjustedTail = parsedTail.blocks.map((block) => {
    const sourceOffset = block.sourceOffset + previousTail.sourceOffset;
    return {
      ...block,
      key: `markdown-block-${sourceOffset}`,
      sourceOffset,
    };
  });

  return {
    source: content,
    incremental: true,
    blocks: [...previous.blocks.slice(0, -1), ...adjustedTail],
  };
}
