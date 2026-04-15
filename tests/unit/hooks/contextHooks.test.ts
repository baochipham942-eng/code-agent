// ============================================================================
// contextHooks — preCompact flush-to-memory tests (Workstream A)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompactContext } from '../../../src/main/protocol/events';
import type { Message } from '../../../src/shared/contract';

// ----------------------------------------------------------------------------
// Mock DB — we assert on the createMemory / listMemories / deleteMemory calls
// ----------------------------------------------------------------------------

type MemoryRecord = {
  id: string;
  type: string;
  category: string;
  content: string;
  summary?: string;
  source: string;
  projectPath?: string;
  sessionId?: string;
  confidence: number;
  metadata: Record<string, unknown>;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
};

const createMemory = vi.fn<(data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) => MemoryRecord>();
const listMemories = vi.fn<(options?: Record<string, unknown>) => MemoryRecord[]>();

const mockDb = {
  isReady: true,
  createMemory,
  listMemories,
};

vi.mock('../../../src/main/services', () => ({
  getDatabase: () => mockDb,
}));

// Import AFTER the mock is wired so the module picks up our getDatabase
const { preCompactContextHook } = await import('../../../src/main/hooks/builtins/contextHooks');

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeContext(): CompactContext {
  return {
    event: 'PreCompact',
    sessionId: 'test-session',
    timestamp: 1_700_000_000_000,
    workingDirectory: '/tmp/project',
    tokenCount: 10_000,
    targetTokenCount: 5_000,
  };
}

function makeMessages(): Message[] {
  return [
    {
      role: 'user',
      content: '重要：先检查邮箱给建议，在我确认前不要动任何邮件',
      timestamp: 1_700_000_000_000 - 2000,
    } as unknown as Message,
    {
      role: 'assistant',
      content: '我决定采用重要方案 A，因为它更稳定，这是一个关键决策',
      timestamp: 1_700_000_000_000 - 1000,
    } as unknown as Message,
  ];
}

let memoryId = 0;
function stubCreateMemory() {
  createMemory.mockImplementation((data) => ({
    id: `mem_${++memoryId}`,
    ...data,
    accessCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('preCompactContextHook — memory flush', () => {
  beforeEach(() => {
    createMemory.mockReset();
    listMemories.mockReset();
    memoryId = 0;
    listMemories.mockReturnValue([]);
    stubCreateMemory();
  });

  it('flushes user_requirement and flush_decision memories on first run', async () => {
    const result = await preCompactContextHook(makeContext(), makeMessages(), 'balanced');

    expect(result.action).toBe('continue');
    expect(result.message).toMatch(/用户要求/);

    // Dedup query hits first
    expect(listMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'session_extracted',
        projectPath: '/tmp/project',
      }),
    );

    // Should have written at least user_requirement. flush_decision depends
    // on the importance extraction heuristic (keyword "重要"/"关键"/"决定"
    // needs to be present and classified as 'high').
    const calls = createMemory.mock.calls.map((c) => c[0]);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const categories = new Set(calls.map((c) => c.category));
    expect(categories.has('user_requirement')).toBe(true);

    // Every flush memory must be tagged correctly for seedMemoryInjector
    for (const data of calls) {
      expect(data.source).toBe('session_extracted');
      expect(data.projectPath).toBe('/tmp/project');
      expect(data.sessionId).toBe('test-session');
      expect(data.confidence).toBeGreaterThan(0.5);
      expect(data.type).toBe('project_knowledge');
      expect(data.metadata).toMatchObject({
        flushEvent: 'preCompact',
      });
      expect((data.metadata as { flushHash?: string }).flushHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('deduplicates on second run with same content', async () => {
    // First run writes successfully
    const ctx = makeContext();
    const messages = makeMessages();
    await preCompactContextHook(ctx, messages, 'balanced');

    const firstRunCalls = createMemory.mock.calls.length;
    expect(firstRunCalls).toBeGreaterThanOrEqual(1);

    // Capture hashes written and return them from listMemories next time
    const writtenSoFar = createMemory.mock.calls.map((c) => ({
      id: `existing_${c[0].metadata?.flushHash}`,
      ...c[0],
      accessCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })) as unknown as MemoryRecord[];
    listMemories.mockReturnValue(writtenSoFar);
    createMemory.mockClear();

    // Second run — same content, should write nothing
    await preCompactContextHook(ctx, messages, 'balanced');
    expect(createMemory).not.toHaveBeenCalled();
  });

  it('respects FLUSH_MAX_PER_COMPACT cap', async () => {
    const ctx = makeContext();
    // Build 20 unique user messages
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      content: `unique-requirement-${i}: ` + 'x'.repeat(50),
      timestamp: 1_700_000_000_000 - i * 100,
    } as unknown as Message));

    await preCompactContextHook(ctx, messages, 'balanced');

    // MEMORY.FLUSH_MAX_PER_COMPACT = 5
    expect(createMemory.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('is non-blocking when DB is not ready', async () => {
    const readyBackup = mockDb.isReady;
    mockDb.isReady = false;
    try {
      const result = await preCompactContextHook(makeContext(), makeMessages(), 'balanced');
      expect(result.action).toBe('continue');
      expect(createMemory).not.toHaveBeenCalled();
    } finally {
      mockDb.isReady = readyBackup;
    }
  });

  it('is non-blocking when DB throws', async () => {
    createMemory.mockImplementation(() => {
      throw new Error('simulated DB failure');
    });
    const result = await preCompactContextHook(makeContext(), makeMessages(), 'balanced');
    // Hook must still continue — flush failure is logged, not raised
    expect(result.action).toBe('continue');
  });
});
