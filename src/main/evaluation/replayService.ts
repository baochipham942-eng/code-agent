// ============================================================================
// Replay Service - 从遥测数据重建结构化回放
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getTelemetryQueryService } from './telemetryQueryService';

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
    deviations?: Array<{
      stepIndex: number;
      type: string;
      description: string;
      severity: string;
      suggestedFix?: string;
    }>;
  };
}

export async function extractStructuredReplay(sessionId: string): Promise<StructuredReplay | null> {
  try {
    return await getTelemetryQueryService().getStructuredReplay(sessionId);
  } catch (error) {
    logger.error('Failed to extract structured replay', { error, sessionId });
    return null;
  }
}
