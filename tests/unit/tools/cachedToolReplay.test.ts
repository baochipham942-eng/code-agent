import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '../../../src/shared/contract';
import { fingerprintToolCall } from '../../../src/host/agent/runtime/stagnationDetector';

const markToolCacheHit = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/tools/toolExecutionTelemetry', () => ({
  markToolCacheHit,
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    appendToolExecutionBegin: vi.fn(),
    appendToolExecutionComplete: vi.fn(),
  }),
}));
vi.mock('../../../src/host/security', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/security')>()),
  getAuditLogger: () => ({ logToolUsage: vi.fn() }),
}));

import { recordCachedToolReplay } from '../../../src/host/tools/cachedToolReplay';

const cached: ToolResult = { success: true, output: 'same output', toolCallId: 'call-1' };

describe('cached tool replay fingerprint source', () => {
  beforeEach(() => markToolCacheHit.mockClear());

  it('uses raw model arguments even when execution params were normalized', () => {
    const rawParams = { path: 'workspace/file.txt', extra: 'model-emitted' };
    const normalizedParams = { path: '/workspace/file.txt' };

    recordCachedToolReplay({
      cached,
      params: normalizedParams,
      rawParams,
      toolName: 'read_file',
      sessionId: 'replay-session',
      toolCallId: 'call-1',
      auditEnabled: false,
    });

    expect(markToolCacheHit).toHaveBeenCalledWith('call-1', {
      sessionId: 'replay-session',
      fingerprint: fingerprintToolCall(
        { id: 'call-1', name: 'read_file', arguments: rawParams },
        cached,
      ),
    });
  });
});
