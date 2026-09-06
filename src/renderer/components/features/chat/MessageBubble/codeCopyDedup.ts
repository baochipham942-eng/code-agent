// ============================================================================
// 代码块紧邻 !copy 链接去重（工单 N-CODEBLOCK-DUPCOPY）
//
// 症状：围栏代码块块头自带「复制」按钮，模型又常在块旁正文里写
// [复制命令](!copy)，react-markdown 渲染出第二个复制入口。
// 处置：渲染前在 markdown 源上删掉「紧邻围栏块」的纯 !copy 段落，只留块头入口
// （块头复制的是代码本身，比复制链接文字更接近用户意图；吸收链接文案只会把
// 「复制」改写成「复制命令」，零信息增量）。句中/正文中间的 !copy 是行内功能，
// 必须保留，因此判据收窄到「整段只有 !copy 链接 + 紧贴围栏块」。
//
// 实现要点（ai-review PR#1677 两轮共 6 条 Important 的修正）：
// - 围栏识别用 CommonMark 口径的行级扫描（同字符围栏、关栏长度 ≥ 开栏、
//   反引号围栏 info 不含反引号），不是「见到三个反引号就切」——否则四反引号
//   围栏内嵌的三反引号示例会被误当边界，示例里的字面 !copy 会被当正文删掉。
// - 只有「渲染时真的带块头复制按钮」的围栏才构成紧邻，判定与 MessageContent
//   code 覆写的分发逐一对应：无语言围栏内容 ≥2 行才走 CodeBlock（单行内容走
//   InlineCode，无块头按钮）；chart 用与 ChartBlock 同源的 parseChartSpecSource
//   判定（解析失败整块渲染 null）；neo_ui（GenerativeUIHost 无复制按钮）、
//   spreadsheet / document（解析失败渲染 null）一律不让其吃掉相邻链接；
//   generative_ui 空内容渲染 null，非空才有块头复制。
// - 删空段跳过 + 段间 join('\n')，相邻围栏天然分行，不会被拼成一块。
// - 引用（> 前缀，单层）内的围栏与复制段同样参与去重；4 空格/Tab 起头的
//   缩进代码块不当作复制段；含行内 code 的段落不算纯复制段。
// ============================================================================

import { parseChartSpecSource } from '@shared/chartSpec';

/** 围栏开行：≤3 空格缩进 + 3 个以上 ` 或 ~，其后为 info 字符串 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** 围栏关行：≤3 空格缩进 + 同字符 ≥ 开栏长度，整行除空白外无它物（关栏不带 info） */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** 引用行前缀（单层）：剥掉后围栏/复制段判定与顶层同构 */
const BLOCKQUOTE_PREFIX = /^ {0,3}> ?/;

/**
 * 「纯复制段」判据：整段（trim 后）只由一个或多个 [text](!copy) 链接与空白构成。
 * 段内还有任何其它文字（哪怕一个标点）都不算——那是句中行内用法，照常渲染。
 * 含反引号的段不算（可能是行内 code 里的字面链接示例）。
 */
const COPY_ONLY_PARAGRAPH = /^(?:\[[^\]]*\]\(!copy\)\s*)+$/;

const HAS_COPY_LINK = /\]\(!copy\)/;

interface OpenFence {
  char: string;
  length: number;
  info: string;
}

function parseOpenFence(line: string): OpenFence | null {
  const match = line.replace(BLOCKQUOTE_PREFIX, '').match(FENCE_OPEN);
  if (!match) return null;
  const info = match[2].trim();
  // 反引号围栏的 info 串不允许再含反引号（CommonMark），含则整行不是围栏
  if (match[1][0] === '`' && info.includes('`')) return null;
  return { char: match[1][0], length: match[1].length, info };
}

function isCloseFence(line: string, open: OpenFence): boolean {
  const match = line.replace(BLOCKQUOTE_PREFIX, '').match(FENCE_CLOSE);
  return Boolean(match?.[1][0] === open.char && match[1].length >= open.length);
}

interface CodeSegment {
  text: string;
  fenced: boolean;
}

/** 把 markdown 按围栏块切成代码段/正文段；代码段（含流式未闭合半块）永不改动 */
function splitCodeSegments(text: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  let plain: string[] = [];
  let fence: string[] = [];
  let open: OpenFence | null = null;
  for (const line of text.split('\n')) {
    if (open) {
      fence.push(line);
      if (isCloseFence(line, open)) {
        segments.push({ text: fence.join('\n'), fenced: true });
        fence = [];
        open = null;
      }
      continue;
    }
    const started = parseOpenFence(line);
    if (started) {
      if (plain.length) {
        segments.push({ text: plain.join('\n'), fenced: false });
        plain = [];
      }
      open = started;
      fence.push(line);
      continue;
    }
    plain.push(line);
  }
  if (open) segments.push({ text: fence.join('\n'), fenced: true });
  if (plain.length) segments.push({ text: plain.join('\n'), fenced: false });
  return segments;
}

/**
 * 语言 → 块头复制按钮**不可能**确定存在的围栏（与 MessageContent code 覆写分发对应）：
 * - neo_ui → GenerativeUIHost，无块头复制按钮；
 * - spreadsheet / document → 解析失败整块渲染 null，无法静态保证有复制入口。
 * 这些围栏旁的 !copy 一律保留（宁冗勿失唯一入口）。
 */
const NEVER_CONFERS_LANGUAGES = new Set(['neo_ui', 'spreadsheet', 'document']);

/**
 * 该围栏块渲染时是否带「块头复制按钮」（与 MessageContent code 覆写的分发一致）：
 * - 无 info → 内容 ≥2 行才分发成 CodeBlock；单行内容渲染为 InlineCode，无块头按钮；
 * - chart → ChartBlock，与渲染同源的 parseChartSpecSource 判定，解析失败渲染 null；
 * - generative_ui → GenerativeUIBlock，空内容渲染 null，非空必有块头复制；
 * - json → spec 合法走 ChartBlock、否则 CodeBlock 兜底，两条路都有复制按钮；
 * - 其余语言（含 mermaid）→ CodeBlock / MermaidDiagram，块头必有复制按钮。
 */
function fenceRendersWithHeaderCopy(fenceText: string): boolean {
  const lines = fenceText.split('\n');
  const open = parseOpenFence(lines[0]);
  if (!open) return false;
  const closed = isCloseFence(lines[lines.length - 1], open);
  const body = lines.slice(1, closed ? -1 : undefined);
  const language = open.info.split(/\s+/)[0] ?? '';
  if (!language) return body.length >= 2;
  if (NEVER_CONFERS_LANGUAGES.has(language)) return false;
  if (language === 'chart') return parseChartSpecSource(body.join('\n')) !== null;
  if (language === 'generative_ui') return body.join('\n').trim() !== '';
  return true;
}

function isCopyOnlyParagraph(paragraph: string): boolean {
  if (paragraph.includes('`')) return false; // 行内 code 里的字面链接不算
  const bareLines = paragraph.split('\n').map((line) => line.replace(BLOCKQUOTE_PREFIX, ''));
  const firstNonBlank = bareLines.find((line) => line.trim() !== '');
  // 4 空格/Tab 起头是缩进代码块（渲染为代码内容，不是链接），不能当复制段删
  if (!firstNonBlank || /^(?: {4}|\t)/.test(firstNonBlank)) return false;
  return COPY_ONLY_PARAGRAPH.test(bareLines.join('\n').trim());
}

function dropAdjacentCopyParagraphs(segment: string, prevConfers: boolean, nextConfers: boolean): string {
  // 空行切段（[ \t]* 容忍空行上的尾随空白）；空行渲染后不产生可见元素，
  // 所以「隔空行」仍算紧邻；夹任何其它内容就不算。
  const paragraphs = segment.split(/\n[ \t]*\n/);
  const firstNonBlank = paragraphs.findIndex((p) => p.trim() !== '');
  let lastNonBlank = -1;
  for (let j = paragraphs.length - 1; j >= 0; j--) {
    if (paragraphs[j].trim() !== '') {
      lastNonBlank = j;
      break;
    }
  }
  if (prevConfers && firstNonBlank >= 0 && isCopyOnlyParagraph(paragraphs[firstNonBlank])) {
    paragraphs[firstNonBlank] = '';
  }
  if (nextConfers && lastNonBlank >= 0 && isCopyOnlyParagraph(paragraphs[lastNonBlank])) {
    paragraphs[lastNonBlank] = '';
  }
  return paragraphs.join('\n\n');
}

/**
 * 去掉「紧邻围栏代码块」的纯 [text](!copy) 段。
 *
 * 「紧邻」判据：段与围栏块之间只隔空白（空行算紧邻）；围栏块前后对称处理；
 * 只有整段皆为 !copy 链接才去重。代码段内部与行内 code 里的 !copy 文本原样保留。
 *
 * 只做删除、不新增任何用户可见文案，无 i18n 面；返回新字符串，不突变入参。
 */
export function dropCodeAdjacentCopyLinks(text: string): string {
  const segments = splitCodeSegments(text);
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.fenced || !HAS_COPY_LINK.test(segment.text)) {
      out.push(segment.text);
      continue;
    }
    const prevConfers = i > 0 && segments[i - 1].fenced && fenceRendersWithHeaderCopy(segments[i - 1].text);
    const nextConfers = i + 1 < segments.length && segments[i + 1].fenced && fenceRendersWithHeaderCopy(segments[i + 1].text);
    if (!prevConfers && !nextConfers) {
      out.push(segment.text);
      continue;
    }
    const transformed = dropAdjacentCopyParagraphs(segment.text, prevConfers, nextConfers);
    // 段被整段删空时跳过：两侧围栏经 join('\n') 自然分行，不会被拼到同一行；
    // 原本就空的段（如尾随换行产生的空段）原样保留，维持字节级恒等
    if (transformed !== '' || segment.text === '') out.push(transformed);
  }
  return out.join('\n');
}
