// ============================================================================
// Data Fingerprint & Tool Fact Store - 源数据锚定，防止多轮对话中模型虚构数据
// ============================================================================
// 借鉴 Claude Code 的轻量标识符模式 + Codex 的工具输出可引用模式：
// - DataFingerprint: xlsx/csv 等结构化数据的 schema + 样本 + 数值范围
// - ToolFact: bash/web_fetch 等工具输出中提取的关键事实（数值、统计）
// 在 compaction recovery 中注入作为 ground truth。
// ============================================================================

import * as path from 'path';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DataFingerprint');

// --- 结构化数据指纹（xlsx/csv） ---

export interface DataFingerprint {
  filePath: string;
  readTime: number;
  sheetName?: string;
  rowCount: number;
  columnNames: string[];
  sampleValues: Record<string, string>;   // 列名 → 首行值
  numericRanges?: Record<string, { min: number; max: number }>;
  categoricalValues?: Record<string, string[]>;  // 低基数列（≤20 unique）→ 唯一值列表
  nullCounts?: Record<string, number>;           // 列名 → 空值计数
  duplicateRowCount?: number;                    // 完全重复的行数
}

// --- 轻量工具事实（bash/web_fetch 等） ---

export interface ToolFact {
  source: string;     // 工具名或文件路径
  readTime: number;
  facts: string[];    // 关键事实文本（每条 < 100 字）
}

// --- 事实提取工具函数 ---

/**
 * 从 bash 输出中提取结构化事实（统计摘要、表格数据等）
 * 轻量启发式：只提取包含数值的关键行，不做完整解析
 */
export function extractBashFacts(command: string, output: string): ToolFact | null {
  if (!output || output.length < 20) return null;

  const facts: string[] = [];
  const lines = output.split('\n');

  // 模式1: pandas describe() / 统计摘要 — 检测 mean/std/min/max 行
  const statsKeywords = ['mean', 'std', 'min', 'max', 'count', '均值', '标准差', '最小', '最大', '总计', 'sum', 'avg', 'total', 'average'];
  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (lower.length > 5 && lower.length < 200 && statsKeywords.some(kw => lower.includes(kw))) {
      // 确保行内包含数值
      if (/\d+\.?\d*/.test(line)) {
        facts.push(line.trim());
      }
    }
    if (facts.length >= 8) break;
  }

  // 模式2: SQL/查询结果 — 检测 "N rows" 或表格分隔符
  const rowCountMatch = output.match(/(\d+)\s*(rows?|行|records?|条)/i);
  if (rowCountMatch) {
    facts.push(`查询结果: ${rowCountMatch[0]}`);
  }

  // 模式3: JSON 对象中的数值键值对
  const jsonMatch = output.match(/\{[^{}]{10,500}\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const numericEntries = Object.entries(obj)
        .filter(([, v]) => typeof v === 'number')
        .slice(0, 5);
      if (numericEntries.length > 0) {
        facts.push(`JSON: {${numericEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}}`);
      }
    } catch { /* not valid JSON, skip */ }
  }

  if (facts.length === 0) return null;

  // 用命令的前 80 字符作为 source 标识
  const source = `bash: ${command.length > 80 ? command.substring(0, 80) + '...' : command}`;
  return { source, readTime: Date.now(), facts };
}

/**
 * 从 read_file 输出中提取 CSV/JSON 文件的 schema 信息
 */
export function extractFileFacts(filePath: string, content: string): ToolFact | null {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv') {
    return extractCsvFacts(filePath, content);
  }
  if (ext === '.json') {
    return extractJsonFacts(filePath, content);
  }
  return null;
}

function extractCsvFacts(filePath: string, content: string): ToolFact | null {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;

  // 跳过行号前缀（read_file 输出格式: "  lineNum\tcontent"）
  const stripLineNum = (line: string) => line.replace(/^\s*\d+\t/, '');

  const headerLine = stripLineNum(lines[0]);
  const firstDataLine = stripLineNum(lines[1]);

  // 检测分隔符
  const sep = headerLine.includes('\t') ? '\t' : ',';
  const headers = headerLine.split(sep).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const firstRow = firstDataLine.split(sep).map(v => v.trim().replace(/^["']|["']$/g, ''));

  if (headers.length < 2 || headers.length > 50) return null;

  const facts: string[] = [];
  const fileName = path.basename(filePath);
  const dataLines = lines.length - 1; // 减去表头

  facts.push(`${fileName}: ${dataLines}行, 列=[${headers.join(',')}]`);

  // 首行样本
  const sample = headers.slice(0, 5).map((h, i) => `${h}: ${firstRow[i] || ''}`).join(', ');
  facts.push(`首行: {${sample}}`);

  return { source: filePath, readTime: Date.now(), facts };
}

function extractJsonFacts(filePath: string, content: string): ToolFact | null {
  // 跳过行号前缀，拼接完整 JSON
  const jsonStr = content.split('\n')
    .map(line => line.replace(/^\s*\d+\t/, ''))
    .join('\n');

  try {
    const parsed = JSON.parse(jsonStr);

    // 数组：提取长度和 schema
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
      const keys = Object.keys(parsed[0]);
      const facts: string[] = [];
      facts.push(`${path.basename(filePath)}: ${parsed.length}条记录, 字段=[${keys.join(',')}]`);

      const sample = keys.slice(0, 5).map(k => `${k}: ${parsed[0][k]}`).join(', ');
      facts.push(`首条: {${sample}}`);

      return { source: filePath, readTime: Date.now(), facts };
    }
  } catch { /* not valid JSON */ }

  return null;
}

// --- 统一存储 ---

class DataFingerprintStore {
  private static instance: DataFingerprintStore;
  private fingerprints: Map<string, DataFingerprint> = new Map();
  private toolFacts: Map<string, ToolFact> = new Map();
  private static readonly MAX_TOOL_FACTS = 20; // 避免无限增长

  private constructor() {}

  static getInstance(): DataFingerprintStore {
    if (!DataFingerprintStore.instance) {
      DataFingerprintStore.instance = new DataFingerprintStore();
    }
    return DataFingerprintStore.instance;
  }

  /**
   * 记录结构化数据指纹（xlsx/csv）
   */
  record(fp: DataFingerprint): void {
    const key = fp.sheetName ? `${fp.filePath}:${fp.sheetName}` : fp.filePath;
    this.fingerprints.set(key, fp);
    logger.info(`[DataFingerprint] Recorded: ${path.basename(fp.filePath)}${fp.sheetName ? ':' + fp.sheetName : ''} (${fp.rowCount} rows, ${fp.columnNames.length} cols)`);
  }

  /**
   * 记录工具事实（bash 输出、web_fetch 等）
   */
  recordFact(fact: ToolFact): void {
    // LRU: 超过上限时删除最早的
    if (this.toolFacts.size >= DataFingerprintStore.MAX_TOOL_FACTS) {
      const oldestKey = this.toolFacts.keys().next().value;
      if (oldestKey) this.toolFacts.delete(oldestKey);
    }
    const key = `${fact.source}:${fact.readTime}`;
    this.toolFacts.set(key, fact);
    logger.debug(`[DataFingerprint] Recorded tool fact: ${fact.source} (${fact.facts.length} facts)`);
  }

  /**
   * 获取所有数据指纹
   */
  getAll(): DataFingerprint[] {
    return Array.from(this.fingerprints.values());
  }

  /**
   * 生成简洁的文本摘要，用于 compaction 注入
   * 借鉴 Codex 模式：所有工具输出的关键事实作为 ground truth
   */
  toSummary(): string {
    const fps = this.getAll();
    const facts = Array.from(this.toolFacts.values());
    if (fps.length === 0 && facts.length === 0) return '';

    const lines: string[] = ['## 已验证的源数据'];

    // 结构化数据指纹
    for (const fp of fps) {
      const fileName = path.basename(fp.filePath);
      const sheetInfo = fp.sheetName ? ` ${fp.sheetName}` : '';
      lines.push(`- ${fileName}${sheetInfo}: ${fp.rowCount}行, 列=[${fp.columnNames.join(',')}]`);

      const sampleEntries = Object.entries(fp.sampleValues).slice(0, 5);
      if (sampleEntries.length > 0) {
        const sampleStr = sampleEntries.map(([k, v]) => `${k}: ${v}`).join(', ');
        lines.push(`  首行: {${sampleStr}}`);
      }

      if (fp.numericRanges) {
        const rangeEntries = Object.entries(fp.numericRanges).slice(0, 3);
        for (const [col, range] of rangeEntries) {
          lines.push(`  ${col}范围: ${range.min} ~ ${range.max}`);
        }
      }

      // 数据质量信息
      if (fp.nullCounts) {
        const nullEntries = Object.entries(fp.nullCounts).filter(([, c]) => c > 0).slice(0, 5);
        if (nullEntries.length > 0) {
          lines.push(`  空值: ${nullEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
        }
      }
      if (fp.duplicateRowCount && fp.duplicateRowCount > 0) {
        lines.push(`  重复行: ${fp.duplicateRowCount}`);
      }
      if (fp.categoricalValues) {
        const catEntries = Object.entries(fp.categoricalValues).slice(0, 3);
        for (const [col, vals] of catEntries) {
          const display = vals.length <= 10 ? vals.join(', ') : vals.slice(0, 10).join(', ') + `... (共${vals.length}种)`;
          lines.push(`  ${col}取值: [${display}]`);
        }
      }
    }

    // 工具事实（只取最近 10 条，避免注入过多）
    const recentFacts = facts.slice(-10);
    if (recentFacts.length > 0) {
      lines.push('');
      lines.push('## 已验证的计算结果');
      for (const tf of recentFacts) {
        for (const f of tf.facts) {
          lines.push(`- ${f}`);
        }
      }
    }

    lines.push('');
    lines.push('⚠️ 所有输出必须基于上述源数据和计算结果，禁止虚构数值');

    return lines.join('\n');
  }

  /**
   * 清空所有指纹和事实
   */
  clear(): void {
    this.fingerprints.clear();
    this.toolFacts.clear();
    logger.debug('[DataFingerprint] Cleared all fingerprints and facts');
  }
}

// Export singleton instance
export const dataFingerprintStore = DataFingerprintStore.getInstance();

// Export class for testing
export { DataFingerprintStore };
