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
// ============================================================================

import { readFile } from 'node:fs/promises';
import { TURN_OUTCOME } from '../../../shared/constants/agent';
import { createLogger } from '../../services/infra/logger';
import { PLACEHOLDER_TEXT_PATTERN_SOURCE } from './placeholderMarkers';

const logger = createLogger('DeliverablePlaceholderScan');

/** 无 g 标志：只用 search 定位首个命中，规避 test/exec 的 lastIndex 状态泄漏。 */
const PLACEHOLDER_SEARCH_PATTERN = new RegExp(PLACEHOLDER_TEXT_PATTERN_SOURCE, 'i');

/**
 * 进正文扫描的扩展名：文档/表格/演示/网页/数据类。代码文件不进（TODO 注释不算
 * 交付物占位）；pdf/图片/音视频无文本读取器，同样不进（存在性核对不受影响）。
 */
const SCANNABLE_EXTENSIONS = new Set(['md', 'txt', 'html', 'htm', 'csv', 'json', 'docx', 'xlsx', 'pptx']);

/** 单文件最多报告的命中数：修复提示够定位即可，不刷屏。 */
const MAX_HITS_PER_FILE = 3;

/** 命中片段长度上限（任务书：片段 ≤60 字）。 */
const MAX_FRAGMENT_CHARS = 60;

export interface DeliverablePlaceholderHit {
  /** 行号 / 工作表行 / 页码等定位描述 */
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

export function isPlaceholderScannablePath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return path.includes('.') && SCANNABLE_EXTENSIONS.has(extension);
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

/** 命中片段：以首个命中位置为锚，向前带一点上下文，压掉空白后截到上限。 */
function fragmentAround(text: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 16);
  const fragment = text.slice(start, start + MAX_FRAGMENT_CHARS).replace(/\s+/g, ' ').trim();
  return start + MAX_FRAGMENT_CHARS < text.length ? `${fragment}…` : fragment;
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

async function extractSegments(path: string, extension: string): Promise<TextSegment[] | null> {
  switch (extension) {
    case 'md':
    case 'txt':
    case 'csv':
    case 'json':
      return lineSegments(await readFile(path, 'utf8'));
    case 'html':
    case 'htm':
      return htmlVisibleLineSegments(await readFile(path, 'utf8'));
    case 'docx':
      return extractDocxSegments(await readFile(path));
    case 'xlsx':
      return extractXlsxSegments(path);
    case 'pptx':
      return extractPptxSegments(await readFile(path));
    default:
      return null;
  }
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
  let budgetBytes = TURN_OUTCOME.MAX_DELIVERABLE_PLACEHOLDER_SCAN_BYTES;
  for (const input of inputs) {
    if (budgetBytes <= 0 || input.size > budgetBytes) continue;
    if (!isPlaceholderScannablePath(input.path)) continue;
    try {
      budgetBytes -= input.size;
      const extension = input.path.slice(input.path.lastIndexOf('.') + 1).toLowerCase();
      const segments = await extractSegments(input.path, extension);
      if (!segments) continue;
      const hits = collectHits(segments);
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
