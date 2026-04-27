// ============================================================================
// Replay Service - 从遥测数据重建结构化回放
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getTelemetryQueryService } from './telemetryQueryService';
import type {
  ReplayBlock,
  ReplayToolCategory,
  ReplayTurn,
  StructuredReplay,
} from '../../shared/contract/evaluation';

const logger = createLogger('ReplayService');

// ---- Types ----

export type ToolCategory = ReplayToolCategory;
export type { ReplayBlock, ReplayTurn, StructuredReplay };

export async function extractStructuredReplay(sessionId: string): Promise<StructuredReplay | null> {
  try {
    return await getTelemetryQueryService().getStructuredReplay(sessionId);
  } catch (error) {
    logger.error('Failed to extract structured replay', { error, sessionId });
    return null;
  }
}
