// ============================================================================
// Replay Service - 从遥测数据重建结构化回放
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ReplayService');

// ---- Types ----

export type ToolCategory =
  | 'Read'
  | 'Edit'
  | 'Write'
  | 'Bash'
  | 'Search'
  | 'Web'
  | 'Agent'
  | 'Skill'
  | 'Other';

export interface ReplayBlock {
  type: 'user' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error';
  content: string;
  toolCall?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: string;
    success: boolean;
    duration: number;
    category: ToolCategory;
  };
  timestamp: number;
}

export interface ReplayTurn {
  turnNumber: number;
  blocks: ReplayBlock[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  startTime: number;
}

export interface StructuredReplay {
  sessionId: string;
  turns: ReplayTurn[];
  summary: {
    totalTurns: number;
    toolDistribution: Record<ToolCategory, number>;
    thinkingRatio: number;
    selfRepairChains: number;
    totalDurationMs: number;
  };
}

// ---- Tool Category Taxonomy (borrowed from agentsview) ----

const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  read: 'Read',
  read_file: 'Read',
  readFile: 'Read',
  Read: 'Read',
  readXlsx: 'Read',
  read_xlsx: 'Read',

  edit: 'Edit',
  edit_file: 'Edit',
  Edit: 'Edit',

  write: 'Write',
  write_file: 'Write',
  Write: 'Write',
  create_file: 'Write',

  bash: 'Bash',
  Bash: 'Bash',
  execute: 'Bash',
  terminal: 'Bash',

  glob: 'Search',
  Glob: 'Search',
  grep: 'Search',
  Grep: 'Search',
  search: 'Search',
  find: 'Search',
  listDirectory: 'Search',
  list_directory: 'Search',

  webFetch: 'Web',
  web_fetch: 'Web',
  webSearch: 'Web',
  web_search: 'Web',

  agent: 'Agent',
  Agent: 'Agent',
  subagent: 'Agent',

  skill: 'Skill',
  Skill: 'Skill',
};

export function normalizeToolCategory(toolName: string): ToolCategory {
  if (TOOL_CATEGORY_MAP[toolName]) return TOOL_CATEGORY_MAP[toolName];

  const lower = toolName.toLowerCase();
  if (lower.includes('read')) return 'Read';
  if (lower.includes('edit')) return 'Edit';
  if (lower.includes('write') || lower.includes('create')) return 'Write';
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('terminal')) return 'Bash';
  if (lower.includes('search') || lower.includes('grep') || lower.includes('glob') || lower.includes('find'))
    return 'Search';
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('url')) return 'Web';
  if (lower.includes('agent')) return 'Agent';
  if (lower.includes('skill')) return 'Skill';
  return 'Other';
}

// ---- Main Service ----

interface TurnRow {
  id: string;
  turn_number: number;
  start_time: number;
  end_time: number;
  duration_ms: number;
  user_prompt: string | null;
  user_prompt_tokens: number;
  assistant_response: string | null;
  assistant_response_tokens: number;
  thinking_content: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  outcome_status: string | null;
}

interface ToolCallRow {
  id: string;
  tool_call_id: string;
  name: string;
  arguments: string | null;
  result_summary: string | null;
  success: number;
  error: string | null;
  duration_ms: number;
  timestamp: number;
  idx: number;
}

export async function extractStructuredReplay(sessionId: string): Promise<StructuredReplay | null> {
  const db = getDatabase().getDb();
  if (!db) {
    logger.error('Database not initialized');
    return null;
  }

  // Check telemetry_turns table exists
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_turns'`)
    .get();
  if (!tableExists) {
    logger.warn('telemetry_turns table not found');
    return null;
  }

  // Fetch all turns for this session
  const turnRows = db
    .prepare(
      `SELECT id, turn_number, start_time, end_time, duration_ms,
              user_prompt, user_prompt_tokens,
              assistant_response, assistant_response_tokens,
              thinking_content,
              total_input_tokens, total_output_tokens,
              outcome_status
       FROM telemetry_turns
       WHERE session_id = ?
       ORDER BY turn_number ASC`
    )
    .all(sessionId) as TurnRow[];

  if (turnRows.length === 0) {
    logger.info('No turns found for session', { sessionId });
    return null;
  }

  // Build turns
  const toolDist: Record<ToolCategory, number> = {
    Read: 0, Edit: 0, Write: 0, Bash: 0, Search: 0, Web: 0, Agent: 0, Skill: 0, Other: 0,
  };
  let totalThinkingTokens = 0;
  let totalAllTokens = 0;
  let selfRepairChains = 0;
  let totalDurationMs = 0;

  const turns: ReplayTurn[] = [];

  for (const row of turnRows) {
    const blocks: ReplayBlock[] = [];

    // 1. User prompt block
    if (row.user_prompt) {
      blocks.push({
        type: 'user',
        content: row.user_prompt,
        timestamp: row.start_time,
      });
    }

    // 2. Thinking block
    if (row.thinking_content) {
      blocks.push({
        type: 'thinking',
        content: row.thinking_content,
        timestamp: row.start_time,
      });
      // Rough estimate: thinking tokens ~ thinking content length / 4
      totalThinkingTokens += Math.ceil(row.thinking_content.length / 4);
    }

    // 3. Tool call blocks (ordered by idx)
    const toolCallRows = db
      .prepare(
        `SELECT id, tool_call_id, name, arguments, result_summary,
                success, error, duration_ms, timestamp, idx
         FROM telemetry_tool_calls
         WHERE turn_id = ?
         ORDER BY idx ASC`
      )
      .all(row.id) as ToolCallRow[];

    let prevFailed = false;
    for (const tc of toolCallRows) {
      const category = normalizeToolCategory(tc.name);
      toolDist[category]++;

      let args: Record<string, unknown> = {};
      if (tc.arguments) {
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = { raw: tc.arguments };
        }
      }

      // Detect self-repair: same tool succeeds right after failure
      if (prevFailed && tc.success) {
        selfRepairChains++;
      }
      prevFailed = !tc.success;

      blocks.push({
        type: 'tool_call',
        content: tc.name,
        toolCall: {
          id: tc.tool_call_id,
          name: tc.name,
          args,
          result: tc.result_summary || undefined,
          success: !!tc.success,
          duration: tc.duration_ms,
          category,
        },
        timestamp: tc.timestamp,
      });

      // Add error block if tool failed
      if (tc.error) {
        blocks.push({
          type: 'error',
          content: tc.error,
          timestamp: tc.timestamp,
        });
      }
    }

    // 4. Assistant text block
    if (row.assistant_response) {
      blocks.push({
        type: 'text',
        content: row.assistant_response,
        timestamp: row.end_time,
      });
    }

    totalAllTokens += row.total_input_tokens + row.total_output_tokens;
    totalDurationMs += row.duration_ms;

    turns.push({
      turnNumber: row.turn_number,
      blocks,
      inputTokens: row.total_input_tokens,
      outputTokens: row.total_output_tokens,
      durationMs: row.duration_ms,
      startTime: row.start_time,
    });
  }

  return {
    sessionId,
    turns,
    summary: {
      totalTurns: turns.length,
      toolDistribution: toolDist,
      thinkingRatio: totalAllTokens > 0 ? totalThinkingTokens / totalAllTokens : 0,
      selfRepairChains,
      totalDurationMs,
    },
  };
}
