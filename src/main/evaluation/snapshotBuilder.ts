// ============================================================================
// SnapshotBuilder - 构建统一评测快照
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { getTelemetryQueryService } from './telemetryQueryService';
import type {
  EvalSnapshot,
  SnapshotToolCall,
  SnapshotFileDiff,
  SnapshotVerification,
} from '../../shared/types/evaluation';

const logger = createLogger('SnapshotBuilder');

/**
 * 从 telemetry 表构建 EvalSnapshot
 */
export function buildSnapshot(sessionId: string): EvalSnapshot | null {
  try {
    const db = getDatabase();
    if (!db.isReady) return null;
    const dbInstance = db.getDb()!;

    // 复用 TelemetryQueryService 的查询逻辑获取原始数据
    const telemetryService = getTelemetryQueryService();
    const sessionSnapshot = telemetryService.getSessionSnapshot(sessionId);
    if (!sessionSnapshot) {
      logger.warn('No telemetry data for snapshot', { sessionId });
      return null;
    }

    // 提取 task_text (第一个 user prompt)
    const firstUserMsg = sessionSnapshot.messages.find(m => m.role === 'user');
    const taskText = firstUserMsg?.content || '';

    // 提取 final_answer (最后一个 assistant response)
    const lastAssistantMsg = [...sessionSnapshot.messages]
      .reverse()
      .find(m => m.role === 'assistant');
    const finalAnswer = lastAssistantMsg?.content || '';

    // 构建工具调用列表
    const toolCalls: SnapshotToolCall[] = sessionSnapshot.toolCalls.map(tc => ({
      name: tc.name,
      args: tc.args,
      result: tc.result,
      success: tc.success,
      durationMs: tc.duration,
      timestamp: tc.timestamp,
      turnIndex: sessionSnapshot.turns.findIndex(
        t => t.toolCalls.some(ttc => ttc.id === tc.id)
      ),
    }));

    // 从工具调用中提取文件变更
    const fileDiffs = extractFileDiffs(toolCalls, sessionSnapshot.toolCalls);

    // 提取产出文件路径
    const outcomeArtifacts = extractOutcomeArtifacts(sessionSnapshot.toolCalls);

    // 提取验证动作
    const verificationActions = extractVerifications(sessionSnapshot.toolCalls);

    // 提取 stderr 和 exit codes
    const codeContext = extractCodeContext(sessionSnapshot.toolCalls);

    // 获取 intent classification (从第一个 turn)
    const taskType = sessionSnapshot.turns[0]?.intentPrimary || undefined;

    const snapshotId = uuidv4();
    const snapshot: EvalSnapshot = {
      schema_version: 1,
      session_id: sessionId,
      snapshot_id: snapshotId,
      created_at: Date.now(),
      task_text: taskText,
      task_type: taskType,
      final_answer: finalAnswer,
      tool_calls: toolCalls,
      file_diffs: fileDiffs,
      outcome_artifacts: outcomeArtifacts,
      verification_actions: verificationActions,
      total_input_tokens: sessionSnapshot.inputTokens,
      total_output_tokens: sessionSnapshot.outputTokens,
      total_tool_calls: toolCalls.length,
      duration_ms: sessionSnapshot.endTime - sessionSnapshot.startTime,
      estimated_cost: sessionSnapshot.totalCost,
      code_context: codeContext,
    };

    // 持久化快照
    const dataJson = JSON.stringify(snapshot);
    const hash = createHash('sha256').update(dataJson).digest('hex').slice(0, 16);

    try {
      dbInstance
        .prepare(
          `INSERT OR REPLACE INTO eval_snapshots (id, session_id, schema_version, created_at, data_json, hash)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(snapshotId, sessionId, 1, snapshot.created_at, dataJson, hash);

      logger.info('Snapshot built and persisted', {
        snapshotId,
        sessionId,
        toolCalls: toolCalls.length,
        fileDiffs: fileDiffs.length,
      });
    } catch (dbError) {
      logger.warn('Failed to persist snapshot, returning in-memory only', { error: dbError });
    }

    return snapshot;
  } catch (error) {
    logger.error('Failed to build snapshot', { error, sessionId });
    return null;
  }
}

/**
 * 从数据库获取已有快照
 */
export function getSnapshot(sessionId: string): EvalSnapshot | null {
  try {
    const db = getDatabase();
    if (!db.isReady) return null;
    const dbInstance = db.getDb()!;

    const row = dbInstance
      .prepare('SELECT data_json FROM eval_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as { data_json: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.data_json) as EvalSnapshot;
  } catch (error) {
    logger.warn('Failed to get snapshot', { error, sessionId });
    return null;
  }
}

/**
 * 获取或构建快照
 */
export function getOrBuildSnapshot(sessionId: string): EvalSnapshot | null {
  return getSnapshot(sessionId) || buildSnapshot(sessionId);
}

// ============================================================================
// 内部提取函数
// ============================================================================

interface ToolCallWithArgs {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  success: boolean;
}

function extractFileDiffs(
  _snapshotCalls: SnapshotToolCall[],
  rawCalls: ToolCallWithArgs[]
): SnapshotFileDiff[] {
  const diffs: SnapshotFileDiff[] = [];

  for (const tc of rawCalls) {
    const name = tc.name.toLowerCase();

    if (name === 'write' || name === 'write_file') {
      const filePath = (tc.args.file_path || tc.args.filePath || tc.args.path) as string;
      if (filePath) {
        diffs.push({
          filePath,
          action: 'create',
          newText: (tc.args.content as string) || undefined,
        });
      }
    } else if (name === 'edit' || name === 'edit_file') {
      const filePath = (tc.args.file_path || tc.args.filePath || tc.args.path) as string;
      if (filePath) {
        diffs.push({
          filePath,
          action: 'edit',
          oldText: (tc.args.old_text || tc.args.old_string) as string | undefined,
          newText: (tc.args.new_text || tc.args.new_string) as string | undefined,
        });
      }
    }
  }

  return diffs;
}

function extractOutcomeArtifacts(rawCalls: ToolCallWithArgs[]): string[] {
  const paths = new Set<string>();

  for (const tc of rawCalls) {
    const name = tc.name.toLowerCase();
    if (name === 'write' || name === 'write_file' || name === 'edit' || name === 'edit_file') {
      const filePath = (tc.args.file_path || tc.args.filePath || tc.args.path) as string;
      if (filePath && tc.success) {
        paths.add(filePath);
      }
    }
  }

  return [...paths];
}

function extractVerifications(rawCalls: ToolCallWithArgs[]): SnapshotVerification[] {
  const verifications: SnapshotVerification[] = [];

  for (const tc of rawCalls) {
    const name = tc.name.toLowerCase();

    if (name === 'bash') {
      const command = (tc.args.command as string) || '';
      const lowerCmd = command.toLowerCase();

      let type: SnapshotVerification['type'] | null = null;

      if (lowerCmd.includes('tsc') || lowerCmd.includes('typecheck')) {
        type = 'typecheck';
      } else if (
        lowerCmd.includes('npm test') ||
        lowerCmd.includes('npm run test') ||
        lowerCmd.includes('jest') ||
        lowerCmd.includes('vitest') ||
        lowerCmd.includes('pytest')
      ) {
        type = 'bash_test';
      }

      if (type) {
        verifications.push({
          type,
          command,
          success: tc.success,
          output: tc.result?.slice(0, 500),
          timestamp: 0, // timestamp not available from raw calls
        });
      }
    } else if (name === 'read' || name === 'read_file') {
      // Read after edit = verification pattern (simplified heuristic)
      // We don't add all reads, only if we detect verification intent
    }
  }

  return verifications;
}

function extractCodeContext(rawCalls: ToolCallWithArgs[]): EvalSnapshot['code_context'] {
  const stderrParts: string[] = [];
  const exitCodes: number[] = [];

  for (const tc of rawCalls) {
    if (tc.name.toLowerCase() === 'bash' && tc.result) {
      // Extract stderr hints from result_summary
      if (tc.result.includes('stderr:') || tc.result.includes('error')) {
        stderrParts.push(tc.result.slice(0, 200));
      }
      // Extract exit code if present
      const exitMatch = tc.result.match(/exit code[:\s]+(\d+)/i);
      if (exitMatch) {
        exitCodes.push(parseInt(exitMatch[1], 10));
      }
    }
  }

  if (stderrParts.length === 0 && exitCodes.length === 0) return undefined;

  return {
    stderr_output: stderrParts.length > 0 ? stderrParts.join('\n---\n').slice(0, 2000) : undefined,
    exit_codes: exitCodes.length > 0 ? exitCodes : undefined,
  };
}
