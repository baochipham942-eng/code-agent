// ============================================================================
// Deliverable placeholder scan — 交付物正文占位符扫描（N-ARTIFACT-PLACEHOLDER-GATE）
//
// 收尾闸在「存在且非空」之外再核对一轮正文：声称的交付物里残留脚手架占位
// （TODO / lorem ipsum / 待补充 / [insert…] / XXX 连串 / 示例数据…）与「文件缺失」
// 同路进 missing，共用同一条有界补轮（TURN_OUTCOME.MAX_DELIVERABLE_REPAIR_ROUNDS），
// 不另起平行门。只扫文档/表格/演示/网页/数据类交付物——代码文件（.ts/.js/.py…）
// 结构性不进扫描集合，里面的 TODO 注释是正常工程实践不算占位；用户明确要
// 模板/占位交付物时由 deliverableDiskCheck 侧豁免（请求出现「模板/template/占位」）。
//
// 读取器复用仓内既有栈：docx → mammoth（read_docx 同款）、xlsx → exceljs
// （read_xlsx 同款）、pptx → JSZip + ppt/slides/slideN.xml 的 <a:t> 文本
// （pptEdit 同款），按需动态加载，不给 agent 启动链加依赖。解析失败 fail-open
// 跳过该文件并留痕——存在性核对已另行把关，读不回来不该拦交付。
//
// 防误报形态分层（ai-review PR#2079 Round 2 Important：宁可漏拦，不可误伤——
// 误拦的代价是补轮诱导模型改坏正确产物，漏拦的代价只是少一道兜底）：
//   · office/html：词表全量 substring（word 文档/网页可见文本里出现这些词基本就是残留）；
//   · md/txt：无歧义词族照常 substring；裸英文单词（todo/tbd/placeholder）只在
//     脚手架形态算——方括号/花括号包住（[TODO]、{{placeholder}}）、全大写标记
//     独行跟冒号且该行无其他正文；标题行（## TODO）与正文提及天然不算；
//   · csv：只认整格等于占位标记；一列里多数行是同一个值（状态列全是 TBD）是
//     数据不是残留，不拦；
//   · json：只扫字符串值不扫键名，且只认「整值即占位」——i18n 的 "placeholder"
//     键、值里偶然提到 TODO 都放行；
//   · 代码仓内代码目录（向上找到 package.json/.git 且文件位于 src/、locales/、
//     i18n/、tests/、docs/ 等）的 md/json/csv/txt 默认不扫（工程文件不是交付文档），
//     office/html 照扫。
// ============================================================================

import { readFile, stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { TURN_OUTCOME } from '../../../shared/constants/agent';
import { createLogger } from '../../services/infra/logger';
import {
  PLACEHOLDER_BARE_WORD_SOURCE,
  PLACEHOLDER_TEXT_PATTERN_SOURCE,
  PLACEHOLDER_UNAMBIGUOUS_TEXT_SOURCE,
  PLACEHOLDER_WHOLE_VALUE_WORD_SOURCE,
} from './placeholderMarkers';

const logger = createLogger('DeliverablePlaceholderScan');

/** 无 g 标志：只用 search 定位首个命中，规避 test/exec 的 lastIndex 状态泄漏。 */
const PLACEHOLDER_SEARCH_PATTERN = new RegExp(PLACEHOLDER_TEXT_PATTERN_SOURCE, 'i');

/** md/txt 行扫描的无歧义词族（裸英文单词另走脚手架形态判据）。 */
const UNAMBIGUOUS_SEARCH_PATTERN = new RegExp(PLACEHOLDER_UNAMBIGUOUS_TEXT_SOURCE, 'i');

/** 裸英文单词的脚手架形态①：方括号/双花括号/中文括号包住（[TODO]、{{placeholder}}、【待补】）。 */
const BRACKETED_BARE_WORD_PATTERN = new RegExp(
  `(?:\\[\\s*(?:${PLACEHOLDER_BARE_WORD_SOURCE})\\s*\\]|\\{\\{\\s*(?:${PLACEHOLDER_BARE_WORD_SOURCE})\\s*\\}\\}|【\\s*(?:${PLACEHOLDER_BARE_WORD_SOURCE})\\s*】)`,
  'i',
);

/**
 * 裸英文单词的脚手架形态②：全大写标记独行跟冒号，该行没有其他正文（TODO:/TBD:）。
 * 刻意不加 i 标志——词表单一真源转大写派生，只有全大写形态算标记（PR#2079 Round 2）。
 */
const MARKER_ONLY_LINE_PATTERN = new RegExp(`^(?:${PLACEHOLDER_BARE_WORD_SOURCE.toUpperCase()})\\s*:\\s*$`);

/** 「整值/整格即占位」的等值判词（JSON 字符串值、CSV 单元格共用；锚定 + i）。 */
const WHOLE_VALUE_WORD_PATTERN = new RegExp(`^(?:${PLACEHOLDER_WHOLE_VALUE_WORD_SOURCE})$`, 'i');

/** 整值形态的括号变体：[TODO]、[insert …]、{{待补}}、【待补充】整值包住。 */
const BRACKETED_WHOLE_VALUE_PATTERN = new RegExp(
  `^(?:\\[\\s*(?:insert[^\\]]*|${PLACEHOLDER_BARE_WORD_SOURCE}|${PLACEHOLDER_WHOLE_VALUE_WORD_SOURCE})\\s*\\]`
  + `|\\{\\{\\s*(?:${PLACEHOLDER_BARE_WORD_SOURCE}|${PLACEHOLDER_WHOLE_VALUE_WORD_SOURCE})\\s*\\}\\}`
  + `|【\\s*(?:${PLACEHOLDER_WHOLE_VALUE_WORD_SOURCE})\\s*】)$`,
  'i',
);

/**
 * 进正文扫描的扩展名：文档/表格/演示/网页/数据类。代码文件不进（TODO 注释不算
 * 交付物占位）；pdf/图片/音视频无文本读取器，同样不进（存在性核对不受影响）。
 */
const SCANNABLE_EXTENSIONS = new Set(['md', 'txt', 'html', 'htm', 'csv', 'json', 'docx', 'xlsx', 'pptx']);

/** 纯文本数据/文档类：位于代码仓代码目录时默认不扫（ai-review PR#2079 Round 2）。 */
const TEXT_DOC_EXTENSIONS = new Set(['md', 'txt', 'csv', 'json']);

/** 代码仓内的代码/本地化/测试/文档目录段（小写比对）。 */
const CODE_DIR_SEGMENTS = new Set([
  'src', 'lib', 'test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'scripts',
  'locales', 'locale', 'i18n', 'l10n', 'translations', 'docs', 'doc',
]);

/** 单文件最多报告的命中数：修复提示够定位即可，不刷屏。 */
const MAX_HITS_PER_FILE = 3;

/** 命中片段长度上限（任务书：片段 ≤60 字，含截断省略号）。 */
const MAX_FRAGMENT_CHARS = 60;

/**
 * 单个压缩型交付物（docx/xlsx/pptx）允许的解压后总字节上限——zip bomb 防线。
 * 字节预算按压缩后大小计，解压侧必须另设上限：压缩后 <10MB 的恶意文档可以
 * 解压成 GB 级把收尾闸挂死（ai-review PR#2079 Important）。
 */
const MAX_OFFICE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

/** 单文件抽正文（读取+解析）的时间上限：收尾闸不许被病态文件无限挂住。 */
const EXTRACTION_TIMEOUT_MS = 15_000;

export interface DeliverablePlaceholderHit {
  /** 行号 / 工作表行 / 页码 / JSON 路径等定位描述 */
  location: string;
  /** 命中片段（≤60 字） */
  fragment: string;
}

export interface DeliverablePlaceholderFinding {
  /** 模型写的原始路径 */
  claimed: string;
  /** 对 workingDirectory resolve 后的规范路径（进 missing/提示的口径） */
  resolved: string;
  hits: DeliverablePlaceholderHit[];
}

/** 扫描入参：checkDeliverablesOnDisk 已核过存在与非空的交付物。 */
export interface PlaceholderScanInput {
  claimed: string;
  resolved: string;
  /** 盘上真实命中的路径（macOS 可能是 NFD 形态，读文件要用它） */
  path: string;
  size: number;
}

/** 单段可扫文本：一段 = 一个可定位单元（行 / 工作表行 / 页）。 */
interface TextSegment {
  location: string;
  text: string;
}

/** 抽出的可扫内容：kind 决定命中判据（形态分层见模块头）。 */
type ScannableContent =
  | { kind: 'substring'; segments: TextSegment[] }
  | { kind: 'mdtxt'; segments: TextSegment[] }
  | { kind: 'csv'; rows: string[][] }
  | { kind: 'json'; values: TextSegment[] };

/** 只有扫描集合内的扩展名才抽正文（代码文件结构性不进——TODO 注释不算交付物占位）。 */
function isPlaceholderScannablePath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return path.includes('.') && SCANNABLE_EXTENSIONS.has(extension);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 交付物是否位于代码仓的代码目录（src/、locales/、i18n/、tests/、docs/ 等）：
 * 从文件目录向上找最近的 package.json/.git 作为仓根，再看相对路径的目录段。
 * 命中则 md/json/csv/txt 默认不扫（PR#2079 Round 2：编码任务里这些是工程文件，
 * 里面的 placeholder 键/TODO 章节是合法内容，扫了只会诱导补轮改坏它们）。
 * repoMarkerCache 让一次扫描内的多个文件共享「该目录是否有仓标记」的 stat 结果。
 */
async function insideCodeRepoCodeDir(filePath: string, repoMarkerCache: Map<string, boolean>): Promise<boolean> {
  let directory = dirname(filePath);
  for (;;) {
    let marker = repoMarkerCache.get(directory);
    if (marker === undefined) {
      marker = (await pathExists(`${directory}/package.json`)) || (await pathExists(`${directory}/.git`));
      repoMarkerCache.set(directory, marker);
    }
    if (marker) {
      const segments = relative(directory, filePath).split(/[\\/]+/);
      return segments.slice(0, -1).some((segment) => CODE_DIR_SEGMENTS.has(segment.toLowerCase()));
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function lineSegments(text: string): TextSegment[] {
  // markdown 围栏代码块是「正文里引用的代码」，里面的 TODO 是代码注释不是文档占位；
  // 整块替换成空行保住行号对齐，后续行定位不失真。
  const blanked: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      blanked.push('');
      continue;
    }
    blanked.push(inFence ? '' : line);
  }
  return blanked.map((line, index) => ({ location: `第 ${index + 1} 行`, text: line }));
}

/** HTML 取「可见文本」：先按原行数等量挖掉注释/script/style 块（里面的 TODO 是代码），再剥标签。 */
function htmlVisibleLineSegments(html: string): TextSegment[] {
  const blankAsLines = (block: string) => '\n'.repeat((block.match(/\n/g) ?? []).length);
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, blankAsLines)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, blankAsLines)
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, blankAsLines)
    .replace(/<[^>]+>/g, ' ');
  return visible.split(/\r?\n/).map((line, index) => ({ location: `第 ${index + 1} 行`, text: line }));
}

/** 命中片段：以首个命中位置为锚，向前带一点上下文，压掉空白后截到上限（省略号计入）。 */
function fragmentAround(text: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 16);
  const fragment = text.slice(start, start + MAX_FRAGMENT_CHARS).replace(/\s+/g, ' ').trim();
  return start + MAX_FRAGMENT_CHARS < text.length ? `${fragment.slice(0, MAX_FRAGMENT_CHARS - 1)}…` : fragment;
}

function collectHits(segments: readonly TextSegment[]): DeliverablePlaceholderHit[] {
  const hits: DeliverablePlaceholderHit[] = [];
  for (const segment of segments) {
    const index = segment.text.search(PLACEHOLDER_SEARCH_PATTERN);
    if (index < 0) continue;
    hits.push({ location: segment.location, fragment: fragmentAround(segment.text, index) });
    if (hits.length >= MAX_HITS_PER_FILE) break;
  }
  return hits;
}

/** md/txt 行判据：无歧义词族 substring 命中，或裸英文单词的脚手架形态。返回命中锚点。 */
function mdTxtLineHitIndex(line: string): number {
  const unambiguous = line.search(UNAMBIGUOUS_SEARCH_PATTERN);
  if (unambiguous >= 0) return unambiguous;
  const bracketed = line.search(BRACKETED_BARE_WORD_PATTERN);
  if (bracketed >= 0) return bracketed;
  return MARKER_ONLY_LINE_PATTERN.test(line) ? 0 : -1;
}

function collectMdtxtHits(segments: readonly TextSegment[]): DeliverablePlaceholderHit[] {
  const hits: DeliverablePlaceholderHit[] = [];
  for (const segment of segments) {
    const index = mdTxtLineHitIndex(segment.text);
    if (index < 0) continue;
    hits.push({ location: segment.location, fragment: fragmentAround(segment.text, index) });
    if (hits.length >= MAX_HITS_PER_FILE) break;
  }
  return hits;
}

/** RFC4180 口径的小解析器：带引号的逗号/换行/转义引号都要还原成完整单元格。 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else inQuotes = false;
      } else field += char;
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** 整值/整格即占位：等值词族、XXX 连串、lorem ipsum 开头、括号包住的标记。 */
function isWholeTextPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return WHOLE_VALUE_WORD_PATTERN.test(trimmed)
    || /^x{3,}$/i.test(trimmed)
    || /^lorem ipsum/i.test(trimmed)
    || BRACKETED_WHOLE_VALUE_PATTERN.test(trimmed);
}

/** CSV 判据：整格等于占位标记才算；同列多数行同值（状态列全是 TBD）视为数据不拦。 */
function collectCsvHits(rows: readonly string[][]): DeliverablePlaceholderHit[] {
  const hits: DeliverablePlaceholderHit[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const cell = row[columnIndex].trim();
      if (!isWholeTextPlaceholder(cell)) continue;
      const columnValues = rows.map((entry) => (entry[columnIndex] ?? '').trim()).filter(Boolean);
      const sameValueCount = columnValues.filter((value) => value === cell).length;
      if (sameValueCount >= 2 && sameValueCount * 2 >= columnValues.length) continue;
      hits.push({ location: `第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`, fragment: fragmentAround(cell, 0) });
      if (hits.length >= MAX_HITS_PER_FILE) return hits;
    }
  }
  return hits;
}

/** 递归收集 JSON 的全部字符串值（键名不进——i18n 的 "placeholder" 键是合法键名）。 */
function collectJsonStringValues(value: unknown, trail: string, out: TextSegment[]): void {
  if (typeof value === 'string') {
    out.push({ location: trail, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectJsonStringValues(item, `${trail}[${index}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectJsonStringValues(item, trail === '$' ? `$.${key}` : `${trail}.${key}`, out);
    }
  }
}

/** JSON 判据：只认「整值即占位」的字符串值，定位是 JSON 路径（$.a.b[0]）。 */
function collectJsonHits(values: readonly TextSegment[]): DeliverablePlaceholderHit[] {
  const hits: DeliverablePlaceholderHit[] = [];
  for (const value of values) {
    if (!isWholeTextPlaceholder(value.text)) continue;
    hits.push({ location: value.location, fragment: fragmentAround(value.text, 0) });
    if (hits.length >= MAX_HITS_PER_FILE) break;
  }
  return hits;
}

async function extractDocxSegments(buffer: Buffer): Promise<TextSegment[]> {
  const { default: mammoth } = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return lineSegments(value);
}

async function extractXlsxSegments(path: string): Promise<TextSegment[]> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const segments: TextSegment[] = [];
  for (const sheet of workbook.worksheets) {
    // eachRow 的第二参就是 xlsx 真实行号（read_xlsx 同口径），跳空行的行号语义一致。
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = typeof cell.text === 'string' ? cell.text.trim() : '';
        if (text) cells.push(text);
      });
      if (cells.length > 0) segments.push({ location: `${sheet.name} 第 ${rowNumber} 行`, text: cells.join(' | ') });
    });
  }
  return segments;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** pptx 抽正文：ppt/slides/slideN.xml 的 <a:t> 文本游程（pptEdit 替换标题/内容同款口径）。 */
async function extractPptxSegments(buffer: Buffer): Promise<TextSegment[]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const slides: Array<{ page: number; text: string }> = [];
  for (const name of Object.keys(zip.files)) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (!match) continue;
    const xml = await zip.files[name].async('string');
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((run) => decodeXmlEntities(run[1]));
    if (runs.length > 0) slides.push({ page: Number(match[1]), text: runs.join(' ') });
  }
  slides.sort((left, right) => left.page - right.page);
  return slides.map((slide) => ({ location: `第 ${slide.page} 页`, text: slide.text }));
}

/**
 * docx/xlsx/pptx 解压防线：预检 zip 条目的解压后总尺寸，超限不交给重解析器
 * （mammoth/exceljs/JSZip 解压无内在上限）。预检本身只读中央目录元数据。
 *
 * 天花板说明（PR#2079 Round 2 Nit）：该上限依赖中央目录**自报**的 uncompressedSize
 * ——恶意 zip 可以少报（中央目录是攻击者可控字节），预检此时会放行；兜底是
 * withExtractionTimeout 的时间上限（放弃等待，但已提交的同步解压中止不了）。
 * 升级路径：解压时流式计数实际产出字节、超限即中断（JSZip 的 async('nodebuffer')
 * 无逐块回调，需换流式 inflate 或自管计数器），当前误报/成本权衡下未实现。
 */
async function officeUncompressedWithinBudget(path: string): Promise<boolean> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await readFile(path));
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    // JSZip 未公开解压尺寸；_data.uncompressedSize 是私有字段（loadAsync 后由中央目录
    // 填充）。取不到的条目不计入——预检失效时还有时间上限兜底，不因此关掉整类扫描。
    const size = (entry as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
    if (typeof size === 'number') total += size;
  }
  return total <= MAX_OFFICE_UNCOMPRESSED_BYTES;
}

/**
 * 收尾闸的抽正文有时限：超时按解析失败处理（fail-open 跳过并 warn 留痕）。
 * 注意超时只是放弃等待、让收尾继续，中止不了已提交的同步解析——真正的炸弹
 * 防线是解压尺寸预检，这里防的是病态文件把收尾挂死。
 */
function withExtractionTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PLACEHOLDER_SCAN_EXTRACTION_TIMEOUT after ${EXTRACTION_TIMEOUT_MS}ms`)), EXTRACTION_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function extractContent(path: string, extension: string): Promise<ScannableContent | null> {
  switch (extension) {
    case 'md':
    case 'txt':
      return { kind: 'mdtxt', segments: lineSegments(await readFile(path, 'utf8')) };
    case 'csv':
      return { kind: 'csv', rows: parseCsvRows(await readFile(path, 'utf8')) };
    case 'json': {
      // JSON.parse 失败按解析失败 fail-open（warn 留痕）——存在性核对另有把关。
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      const values: TextSegment[] = [];
      collectJsonStringValues(parsed, '$', values);
      return { kind: 'json', values };
    }
    case 'html':
    case 'htm':
      return { kind: 'substring', segments: htmlVisibleLineSegments(await readFile(path, 'utf8')) };
    case 'docx':
      if (!(await officeUncompressedWithinBudget(path))) throw new Error('OFFICE_UNCOMPRESSED_OVER_BUDGET');
      return { kind: 'substring', segments: await extractDocxSegments(await readFile(path)) };
    case 'xlsx':
      if (!(await officeUncompressedWithinBudget(path))) throw new Error('OFFICE_UNCOMPRESSED_OVER_BUDGET');
      return { kind: 'substring', segments: await extractXlsxSegments(path) };
    case 'pptx':
      if (!(await officeUncompressedWithinBudget(path))) throw new Error('OFFICE_UNCOMPRESSED_OVER_BUDGET');
      return { kind: 'substring', segments: await extractPptxSegments(await readFile(path)) };
    default:
      return null;
  }
}

function collectContentHits(content: ScannableContent): DeliverablePlaceholderHit[] {
  if (content.kind === 'substring') return collectHits(content.segments);
  if (content.kind === 'mdtxt') return collectMdtxtHits(content.segments);
  if (content.kind === 'csv') return collectCsvHits(content.rows);
  return collectJsonHits(content.values);
}

/**
 * 对已核过「存在且非空」的交付物抽正文扫描占位符。总字节预算
 * TURN_OUTCOME.MAX_DELIVERABLE_PLACEHOLDER_SCAN_BYTES，超出跳过剩余文件
 * （fail-open：占位扫描漏检不拦交付，存在性核对另有把关）。
 */
export async function scanDeliverablesForPlaceholders(
  inputs: readonly PlaceholderScanInput[],
): Promise<DeliverablePlaceholderFinding[]> {
  const findings: DeliverablePlaceholderFinding[] = [];
  const repoMarkerCache = new Map<string, boolean>();
  let budgetBytes = TURN_OUTCOME.MAX_DELIVERABLE_PLACEHOLDER_SCAN_BYTES;
  for (const input of inputs) {
    if (budgetBytes <= 0 || input.size > budgetBytes) continue;
    if (!isPlaceholderScannablePath(input.path)) continue;
    const extension = input.path.slice(input.path.lastIndexOf('.') + 1).toLowerCase();
    // 代码仓代码目录里的 md/json/csv/txt 是工程文件，默认不扫（office/html 照扫）。
    if (TEXT_DOC_EXTENSIONS.has(extension) && (await insideCodeRepoCodeDir(input.path, repoMarkerCache))) continue;
    try {
      budgetBytes -= input.size;
      const content = await withExtractionTimeout(extractContent(input.path, extension));
      if (!content) continue;
      const hits = collectContentHits(content);
      if (hits.length > 0) findings.push({ claimed: input.claimed, resolved: input.resolved, hits });
    } catch (error) {
      // fail-open 但留痕（fail-open 说的是行为不变，不是失败无声）：读不出/解不开的
      // 交付物不因「扫不了」被拦——存在性核对的结论不受影响，但日志要能区分是哪个文件、什么错。
      logger.warn('deliverable placeholder scan skipped an unreadable deliverable', {
        path: input.path,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
  }
  return findings;
}
