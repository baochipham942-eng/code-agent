// ============================================================================
// Context IPC Handler - /context observability command
// Exposes the API-true view after projection, token distribution,
// and compression status to the renderer.
// ============================================================================

import { ipcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { ProjectionEngine, type ProjectableMessage } from '../context/projectionEngine';
import { CompressionState } from '../context/compressionState';
import { estimateTokens, countTokensExact } from '../context/tokenEstimator';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ContextIPC');

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

export interface ContextViewRequest {
  sessionId: string;
}

export interface ContextViewResponse {
  totalTokens: number;
  maxTokens: number;
  usagePercent: number;
  messageCount: number;
  tokenDistribution: {
    system: number;
    user: number;
    assistant: number;
    tool: number;
  };
  compressionStatus: {
    layersTriggered: string[];
    totalCommits: number;
    snippedCount: number;
    collapsedSpans: number;
    savedTokens: number;
  };
  apiViewPreview: Array<{
    id: string;
    role: string;
    contentPreview: string;
    tokens: number;
  }>;
}

// ----------------------------------------------------------------------------
// Pure function — injectable for testing
// ----------------------------------------------------------------------------

const engine = new ProjectionEngine();

/**
 * Compute the context view from a raw transcript + compression state.
 *
 * @param transcript  - Original (immutable) transcript messages
 * @param compressionState - Current compression state for the session
 * @param maxTokens   - Maximum context window size for the active model
 */
export function getContextView(
  transcript: ProjectableMessage[],
  compressionState: CompressionState,
  maxTokens: number,
): ContextViewResponse {
  // Generate the API view (apply collapses, snips, etc.)
  const apiView = engine.projectMessages(transcript, compressionState);

  // Token distribution per role
  const tokenDistribution = { system: 0, user: 0, assistant: 0, tool: 0 };
  for (const msg of apiView) {
    const tokens = estimateTokens(msg.content);
    const role = msg.role as string;
    if (role === 'system') {
      tokenDistribution.system += tokens;
    } else if (role === 'user') {
      tokenDistribution.user += tokens;
    } else if (role === 'assistant') {
      tokenDistribution.assistant += tokens;
    } else {
      // tool / function / other roles
      tokenDistribution.tool += tokens;
    }
  }

  // Total token count (with per-message overhead)
  const totalTokens = countTokensExact(
    apiView.map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
  );

  const usagePercent = maxTokens > 0 ? Math.round((totalTokens / maxTokens) * 1000) / 10 : 0;

  // Compression status
  const commitLog = compressionState.getCommitLog();
  const snapshot = compressionState.getSnapshot();

  const layersSet = new Set<string>();
  for (const commit of commitLog) {
    if (commit.operation !== 'reset') {
      layersSet.add(commit.layer);
    }
  }

  // Saved tokens: sum of (originalTokens - truncatedTokens) from budgetedResults
  let savedTokens = 0;
  for (const [, entry] of snapshot.budgetedResults) {
    const diff = (entry.originalTokens ?? 0) - (entry.truncatedTokens ?? 0);
    if (diff > 0) savedTokens += diff;
  }

  const compressionStatus = {
    layersTriggered: Array.from(layersSet),
    totalCommits: commitLog.length,
    snippedCount: snapshot.snippedIds.size,
    collapsedSpans: snapshot.collapsedSpans.length,
    savedTokens,
  };

  // API view preview (first 100 chars per message)
  const apiViewPreview = apiView.map((msg) => ({
    id: msg.id,
    role: msg.role,
    contentPreview:
      msg.content.length > 100 ? msg.content.slice(0, 100) + '...' : msg.content,
    tokens: estimateTokens(msg.content),
  }));

  return {
    totalTokens,
    maxTokens,
    usagePercent,
    messageCount: apiView.length,
    tokenDistribution,
    compressionStatus,
    apiViewPreview,
  };
}

// ----------------------------------------------------------------------------
// IPC handler registration
// ----------------------------------------------------------------------------

export function registerContextHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CONTEXT_GET_VIEW, async (_event, request: ContextViewRequest) => {
    try {
      logger.info(`Context view requested for session: ${request?.sessionId}`);
      // Note: In Task 7, this will be wired to the active session's transcript and
      // compressionState retrieved from the session registry. For now we return an
      // empty-transcript response so the channel works end-to-end.
      const state = new CompressionState();
      return getContextView([], state, 200_000);
    } catch (error) {
      logger.error('Failed to get context view:', error);
      return null;
    }
  });

  logger.info('Context handlers registered');
}
