// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license)
// ============================================================================
// Edit 多级 replacer 链（roadmap 1.1）— 移植 MiMoCode tool/edit.ts 三级回退：
// LineTrimmedReplacer（行级 trim 容错）、BlockAnchorReplacer（首尾锚点 +
// Levenshtein 中间行相似度，多候选阈值 0.3）、IndentationFlexibleReplacer
// （整体缩进偏移容错）。每个 replacer 是 Generator，yield 内容中实际存在的
// 候选子串；findFlexibleMatch 按序遍历链，供 multiEdit 在精确匹配与智能引号
// 标准化都失败后做模糊回退。
// ============================================================================

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

// Similarity thresholds for block anchor fallback matching
// 注：相对 MiMo 上游有三处加固（codex audit R1/R2 HIGH、R3 MED 各一例实证）：
// 1. 单候选阈值 0.0 → 0.3：锚点命中即接受会把嵌套错误块当成匹配腐蚀源码；
// 2. tail anchor 收集不再止于首个命中 + 相似度按完整 search 中间行数归一
//    （缺失行计 0 分）：否则嵌套 '}' 形成的截断候选会以"部分行全等"胜出，
//    multiEdit 拼接后留下原块残尾；
// 3. 候选护栏不做出现序硬截断（前缀偏置会让巨型块的真实外层 '}' 永远不被
//    打分）：每个 start anchor 按"块长最接近 search 块长"取前 K 个 tail，
//    start anchor 数超上限则 fail-closed（歧义过高，宁缺勿错）。
const BLOCK_ANCHOR_SIMILARITY_THRESHOLD = 0.3;
/** 每个 start anchor 参与打分的 tail anchor 数（按块长接近度选取） */
const MAX_TAILS_PER_START_ANCHOR = 8;
/** start anchor 总数上限：超过即 fail-closed 不出候选 */
const MAX_START_ANCHORS = 64;

export function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === '' || b === '') {
    return Math.max(a.length, b.length);
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim();
      const searchTrimmed = searchLines[j].trim();

      if (originalTrimmed !== searchTrimmed) {
        matches = false;
        break;
      }
    }

    if (matches) {
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }

      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length;
        if (k < searchLines.length - 1) {
          matchEndIndex += 1; // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex);
    }
  }
};

/**
 * 候选块相似度：search 中间行逐行与候选中间行比对（Levenshtein），
 * 按 search 中间行总数归一——候选比 search 短时缺失行计 0 分，
 * 截断候选（嵌套 '}' 误闭合）不再以"部分行全等"胜出。
 */
function scoreBlockCandidate(
  originalLines: string[],
  searchLines: string[],
  startLine: number,
  endLine: number,
): number {
  const searchBlockSize = searchLines.length;
  const searchMiddleCount = searchBlockSize - 2;
  if (searchMiddleCount <= 0) {
    // 防御（codex audit R4）：纯锚点块不应到达此处（调用方已挡 < 3 行），
    // 万一到达也 fail-closed——仅凭首尾锚点全等就接受会吞掉中间行
    return 0;
  }

  let similarity = 0;
  for (let j = 1; j < searchBlockSize - 1; j++) {
    const lineIdx = startLine + j;
    if (lineIdx >= endLine) break; // 候选中间行耗尽，其余 search 行计 0 分
    const originalLine = originalLines[lineIdx].trim();
    const searchLine = searchLines[j].trim();
    const maxLen = Math.max(originalLine.length, searchLine.length);
    if (maxLen === 0) {
      similarity += 1 / searchMiddleCount; // 双空行视为全等
      continue;
    }
    const distance = levenshtein(originalLine, searchLine);
    similarity += (1 - distance / maxLen) / searchMiddleCount;
  }
  return similarity;
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');

  // 先去尾空行再做行数门（codex audit R4）：'a\nb\n' split 后长度 3 会骗过
  // 行数检查，去尾后只剩两行纯锚点，锚点全等即接受会吞掉中间行
  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  if (searchLines.length < 3) {
    return;
  }

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const searchBlockSize = searchLines.length;

  // 预收集锚点行号。start anchor 超上限直接 fail-closed：同名首行过多时
  // 歧义太高，模糊匹配选错的代价（腐蚀源码）远大于不匹配（模型重试）。
  const startAnchors: number[] = [];
  const tailAnchors: number[] = [];
  for (let i = 0; i < originalLines.length; i++) {
    const trimmed = originalLines[i].trim();
    if (trimmed === firstLineSearch) {
      startAnchors.push(i);
      if (startAnchors.length > MAX_START_ANCHORS) return;
    }
    if (trimmed === lastLineSearch) {
      tailAnchors.push(i);
    }
  }

  // 每个 start anchor 按"块长最接近 search 块长"选前 K 个 tail——真实外层
  // 闭合的块长与 search 几乎一致，无论它前面排了多少内层闭合（R3 MED）
  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (const startLine of startAnchors) {
    const viableTails = tailAnchors.filter((j) => j >= startLine + 2);
    viableTails.sort((a, b) => {
      const sizeDiffA = Math.abs(a - startLine + 1 - searchBlockSize);
      const sizeDiffB = Math.abs(b - startLine + 1 - searchBlockSize);
      return sizeDiffA - sizeDiffB || a - b;
    });
    for (const endLine of viableTails.slice(0, MAX_TAILS_PER_START_ANCHOR)) {
      candidates.push({ startLine, endLine });
    }
  }

  if (candidates.length === 0) {
    return;
  }

  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;
  for (const candidate of candidates) {
    const similarity = scoreBlockCandidate(
      originalLines,
      searchLines,
      candidate.startLine,
      candidate.endLine,
    );
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (maxSimilarity >= BLOCK_ANCHOR_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch;
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1;
    }
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length;
      if (k < endLine) {
        matchEndIndex += 1; // Add newline character except for the last line
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex);
  }
};

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split('\n');
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) return text;

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
      }),
    );

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n');
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split('\n');
  const findLines = find.split('\n');

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

/** 回退链顺序：行 trim → 块锚点 → 缩进容错（精确匹配与智能引号由调用方先做） */
const FLEXIBLE_REPLACERS: Replacer[] = [
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  IndentationFlexibleReplacer,
];

export interface FlexibleMatchResult {
  /** 内容中实际存在的匹配子串（用它做后续替换） */
  match: string;
  /** 该子串在内容中的出现次数（>1 且非 replaceAll 时由调用方报歧义） */
  occurrences: number;
}

/**
 * 按序遍历回退链找模糊匹配（仅供单点替换使用——replace_all 不走 fuzzy，
 * 见 codex audit R1：split/join 全量替换会命中其它缩进行的子串腐蚀源码）。
 * - 唯一出现的候选立即返回；
 * - 多次出现的候选先跳过继续找唯一候选，全部歧义时返回首个歧义候选
 *   （调用方据 occurrences > 1 报 AMBIGUOUS_MATCH）。
 */
export function findFlexibleMatch(
  content: string,
  find: string,
): FlexibleMatchResult | null {
  if (!find.trim()) return null;
  let ambiguous: FlexibleMatchResult | null = null;

  for (const replacer of FLEXIBLE_REPLACERS) {
    for (const candidate of replacer(content, find)) {
      const index = content.indexOf(candidate);
      if (index === -1) continue;
      const occurrences = content.split(candidate).length - 1;
      if (occurrences === 1) {
        return { match: candidate, occurrences };
      }
      ambiguous = ambiguous ?? { match: candidate, occurrences };
    }
  }
  return ambiguous;
}
