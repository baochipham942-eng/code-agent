// ============================================================================
// Retention Reference Scan - 保留清理共用的只读引用扫描
// ----------------------------------------------------------------------------
// 从 presentationPreviewRetention 抽出（N-RETENTION-APP-CACHES-REFSCAN）：
// 多个保留清理（pptx 逐页预览、app 缓存目录…）需要同一套「先扫引用再谈删除」的地基。
//
// 语义（owner 规矩：扫描不可信就一个都不删）：
//   - 对每张表跑一次 LIKE 预筛，把命中行的文本列拼成一段大文本（分隔符已归一）。
//   - 任一表查询失败（表缺失 / 库打不开 / 输出超限 / 返回形状不对）→ 抛错，
//     由调用方记失败并放弃本轮删除。
//   - likeNeedles 是调用方的「引用长什么样」：直接内插进 `'%<needle>%'` 的 LIKE
//     片段。注意 `_` 在 LIKE 里是单字符通配——调用方要么选不含 `_` 的 needle，
//     要么有意利用它兜 `/` 与 `\` 两种分隔符（presentation 预览即后者）。
//     needle 不得含单引号（调用方维护的常量/文件名形状，不是用户输入）。
// ============================================================================

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * 引用扫描覆盖的表和文本列。消息表是主源；其余是排查补充的「存产物/文件路径」的表，
 * 少扫一张就可能删掉仍被引用的文件。表/列清单是本文件维护的白名单，各保留清理共用。
 */
const REFERENCE_SOURCES: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
  { table: 'messages', columns: ['content', 'tool_calls', 'tool_results', 'responses_output', 'attachments', 'compaction', 'metadata'] },
  { table: 'companion_artifacts', columns: ['path'] },
  { table: 'tool_executions', columns: ['arguments', 'result'] },
  { table: 'turn_snapshots', columns: ['context_chunks'] },
  { table: 'compaction_snapshots', columns: ['pre_messages_summary', 'post_messages_summary'] },
  { table: 'file_checkpoints', columns: ['file_path', 'original_content'] },
  { table: 'workflow_runs', columns: ['result_json'] },
  { table: 'workflow_run_calls', columns: ['result_json'] },
  { table: 'session_fork_anchor_evidence', columns: ['summary_json', 'evidence_json'] },
];

/**
 * 只读引用扫描：对每张表跑一次 LIKE 预筛，把命中行的文本列拼成一段大文本（每段先归一分隔符）。
 * 任一表查询失败 → 抛错，由调用方记 1 次失败并放弃本轮删除。
 */
export async function collectReferenceText(dbPath: string, likeNeedles: readonly string[]): Promise<string> {
  const chunks: string[] = [];
  for (const source of REFERENCE_SOURCES) {
    // 列名是本文件维护的白名单；needle 见文件头注释的约束。
    const like = source.columns
      .flatMap((column) => likeNeedles.map((needle) => `${column} LIKE '%${needle}%'`))
      .join(' OR ');
    const sql = `SELECT ${source.columns.join(', ')} FROM ${source.table} WHERE ${like};`;
    const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) continue;
    const rows = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(rows)) {
      throw new Error(`${source.table} query did not return a JSON array`);
    }
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      for (const value of Object.values(row as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) chunks.push(normalizeSeparators(value));
      }
    }
  }
  return chunks.join('\n');
}

/**
 * 分隔符归一：反斜杠串（含 JSON 列里成对转义的 `\\`）折叠成单个 `/`，
 * 让 Windows 形状 `dir\name` 与正斜杠判定统一命中。
 */
export function normalizeSeparators(value: string): string {
  return value.replace(/\\+/g, '/');
}
