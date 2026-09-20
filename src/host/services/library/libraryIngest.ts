// ============================================================================
// Library Ingest - 资料学习管线的文本抽取 + 抽取文本 sidecar（N-LIBRARY-LEARN-STATUS）
// ============================================================================
//
// 纯 fs 层：不做 DB、不发事件。抽取复用仓内现有路径，不新造服务：
// - PDF  → readPdf 的本地 pdftotext 抽取（extractSelectablePdfText，含候选二进制探测）
// - DOCX → mammoth.extractRawText（与 read_docx 同一条抽取库）
// - XLSX → ExcelJS 全 sheet 展开（与 read_xlsx 同一条抽取库）
// - 文本型后缀 → utf-8 直读
// 抽取文本落「文件旁 sidecar」：<libraryDir>/<projectId|global>/.extracted/<itemId>.md，
// 行号与原件一致（文本型 sidecar 即原件内容），供 pinned 索引块指路 + 依据抽屉取片段。
// 刻意不上 embedding/向量：检索 = 索引块指路 + 模型按需 Read/Grep sidecar（file-as-memory 口径）。

import * as fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { createLogger } from '../infra/logger';
import { LIBRARY_TIMEOUTS } from '../../../shared/constants';
import { extractSelectablePdfText } from '../../tools/modules/network/readPdf';

const logger = createLogger('LibraryIngest');

/** sidecar 目录名（资料库目录内的隐藏目录） */
const LIBRARY_EXTRACTED_DIRNAME = '.extracted';

/** 抽取文本的单文件字符上限：sidecar 是索引不是全文仓库，超限截断必须留可见标记 */
const MAX_EXTRACTED_CHARS = 2 * 1024 * 1024;

/** xlsx 展开的单表行数上限（含表头）；防巨表把 sidecar 撑爆 */
const MAX_XLSX_ROWS_PER_SHEET = 5000;

/** utf-8 直读的文本型后缀 */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log',
  '.yml', '.yaml', '.xml', '.html', '.htm', '.mjs', '.js', '.ts', '.py', '.sql',
]);

export interface ExtractedLibraryText {
  text: string;
  /** 抽取方式：plaintext / pdftotext / mammoth / exceljs */
  method: string;
  truncated: boolean;
}

/** 该路径是否有学习管线认识的抽取路径（无 = 登记型条目，学习环节直接 ready） */
export function hasLibraryTextExtractor(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ext === '.pdf' || ext === '.docx' || ext === '.xlsx' || ext === '.xls';
}

/** 文本型后缀（依据片段可直接读原件兜底） */
export function isTextLikeExtension(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * 抽取资料文本。失败抛 Error，message 为可展示的真实原因（绝不含「请配置 embedding」话术）。
 */
export async function extractLibraryText(filePath: string): Promise<ExtractedLibraryText> {
  const ext = path.extname(filePath).toLowerCase();
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  let raw: string;
  let method: string;
  if (TEXT_EXTENSIONS.has(ext)) {
    raw = await fs.promises.readFile(filePath, 'utf-8');
    method = 'plaintext';
  } else if (ext === '.pdf') {
    // AbortSignal.timeout 让学习管线不挂在坏 PDF 上；logger 结构兼容 ToolContext['logger']
    raw = await extractSelectablePdfText(filePath, AbortSignal.timeout(LIBRARY_TIMEOUTS.LEARN_PDF_EXTRACT), logger);
    method = 'pdftotext';
  } else if (ext === '.docx') {
    const buffer = fs.readFileSync(filePath);
    const extracted = await mammoth.extractRawText({ buffer });
    raw = extracted.value;
    method = 'mammoth';
  } else if (ext === '.xlsx' || ext === '.xls') {
    raw = await extractXlsxText(filePath);
    method = 'exceljs';
  } else {
    throw new Error(`不支持抽取文本的格式: ${ext || '(无后缀)'}`);
  }

  const truncated = raw.length > MAX_EXTRACTED_CHARS;
  const text = truncated
    ? `${raw.slice(0, MAX_EXTRACTED_CHARS)}\n\n[抽取文本超出 ${MAX_EXTRACTED_CHARS} 字符上限，已截断]`
    : raw;
  return { text, method, truncated };
}

/** xlsx/xls 全 sheet 展开为文本：sheet 名做节标题，每行带真实行号（对齐 read_xlsx 的行号口径） */
async function extractXlsxText(filePath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sections: string[] = [];
  for (const worksheet of workbook.worksheets) {
    const lines: string[] = [`# Sheet: ${worksheet.name}`];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > MAX_XLSX_ROWS_PER_SHEET) return;
      const cells = (row.values as unknown[]).slice(1).map((cell) => {
        if (cell === null || cell === undefined) return '';
        if (typeof cell === 'object') {
          if ('text' in cell) return String((cell as { text: unknown }).text);
          if ('result' in cell) return String((cell as { result: unknown }).result);
          return String(cell);
        }
        return String(cell);
      });
      lines.push(`${rowNumber}\t${cells.join('\t')}`);
    });
    sections.push(lines.join('\n'));
  }
  const text = sections.join('\n\n');
  if (!text.trim()) throw new Error('工作簿没有可抽取的非空行');
  return text;
}

/** 抽取文本 sidecar 路径 */
function learnedSidecarPath(libraryDir: string, itemId: string): string {
  return path.join(libraryDir, LIBRARY_EXTRACTED_DIRNAME, `${itemId}.md`);
}

/** 写 sidecar（含截断标记的最终文本），返回路径 */
export function writeLearnedSidecar(libraryDir: string, itemId: string, text: string): string {
  const target = learnedSidecarPath(libraryDir, itemId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf-8');
  return target;
}

/** 读 sidecar 全文；不存在返回 null */
export function readLearnedSidecar(libraryDir: string, itemId: string): string | null {
  try {
    return fs.readFileSync(learnedSidecarPath(libraryDir, itemId), 'utf-8');
  } catch {
    return null;
  }
}

/** 删 sidecar（条目删除时连带清理）；不存在时静默 */
export function removeLearnedSidecar(libraryDir: string, itemId: string): void {
  try {
    fs.unlinkSync(learnedSidecarPath(libraryDir, itemId));
  } catch {
    // ENOENT 等静默：清理路径不因缺文件报错
  }
}

/**
 * 依据片段：围绕定位行 ±上下文行取窗口，硬 cap 40 行。
 * textLines 为候选全文按行拆分的结果；返回 null 当全文为空。
 */
export function buildEvidenceFragment(
  text: string,
  window?: { start: number; end: number } | null,
): { startLine: number; endLine: number; totalLines: number; text: string } | null {
  const lines = text.split('\n');
  if (lines.length === 0) return null;
  const totalLines = lines.length;
  const CONTEXT = 3;
  const MAX_WINDOW = 40;

  let start: number;
  let end: number;
  if (window) {
    start = Math.max(1, window.start - CONTEXT);
    end = Math.min(totalLines, window.end + CONTEXT);
  } else {
    start = 1;
    end = Math.min(totalLines, 20);
  }
  if (end - start + 1 > MAX_WINDOW) end = start + MAX_WINDOW - 1;
  if (end < start) end = start;

  return {
    startLine: start,
    endLine: end,
    totalLines,
    text: lines.slice(start - 1, end).join('\n'),
  };
}
