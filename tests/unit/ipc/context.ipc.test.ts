// ============================================================================
// context.ipc Unit Tests
// Tests for getContextView() using real ProjectionEngine and tokenEstimator
// (no mocks needed — all dependencies are pure functions).
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildContextViewFromSession, getContextView } from '../../../src/main/ipc/context.ipc';
import { CompressionState } from '../../../src/main/context/compressionState';
import type { ProjectableMessage } from '../../../src/main/context/projectionEngine';
import { getSubagentContextStore } from '../../../src/main/context/subagentContextStore';
import { getContextInterventionState } from '../../../src/main/context/contextInterventionState';
import { getContextEventLedger } from '../../../src/main/context/contextEventLedger';
import type { AgentApplicationService } from '../../../src/shared/contract/appService';
import type { Message, ToolResult } from '../../../src/shared/contract';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(
  id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): ProjectableMessage {
  return { id, role, content };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getContextView()', () => {
  const MAX_TOKENS = 100_000;

  // -------------------------------------------------------------------------
  // 1. Empty transcript
  // -------------------------------------------------------------------------
  describe('handles empty transcript', () => {
    it('returns zero tokens and empty previews', () => {
      const state = new CompressionState();
      const result = getContextView([], state, MAX_TOKENS);

      expect(result.totalTokens).toBe(3); // only the base overhead (countTokensExact constant)
      expect(result.messageCount).toBe(0);
      expect(result.apiViewPreview).toHaveLength(0);
      expect(result.tokenDistribution).toEqual({ system: 0, user: 0, assistant: 0, tool: 0 });
    });

    it('returns usagePercent = 0 for empty transcript', () => {
      const state = new CompressionState();
      const result = getContextView([], state, MAX_TOKENS);
      // base overhead 3 tokens / 100_000 rounds to ~0
      expect(result.usagePercent).toBeCloseTo(0, 1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Token distribution by role
  // -------------------------------------------------------------------------
  describe('returns correct token distribution by role', () => {
    let transcript: ProjectableMessage[];

    beforeEach(() => {
      transcript = [
        makeMsg('s1', 'system', 'You are a helpful assistant.'),
        makeMsg('u1', 'user', 'Hello world'),
        makeMsg('a1', 'assistant', 'Hi there! How can I help you today?'),
        makeMsg('u2', 'user', 'Another user message'),
      ];
    });

    it('assigns system tokens to system bucket', () => {
      const state = new CompressionState();
      const result = getContextView(transcript, state, MAX_TOKENS);
      expect(result.tokenDistribution.system).toBeGreaterThan(0);
    });

    it('assigns user tokens to user bucket', () => {
      const state = new CompressionState();
      const result = getContextView(transcript, state, MAX_TOKENS);
      expect(result.tokenDistribution.user).toBeGreaterThan(0);
    });

    it('assigns assistant tokens to assistant bucket', () => {
      const state = new CompressionState();
      const result = getContextView(transcript, state, MAX_TOKENS);
      expect(result.tokenDistribution.assistant).toBeGreaterThan(0);
    });

    it('tool bucket stays 0 when no tool messages are present', () => {
      const state = new CompressionState();
      const result = getContextView(transcript, state, MAX_TOKENS);
      expect(result.tokenDistribution.tool).toBe(0);
    });

    it('unknown roles (tool) fall into tool bucket', () => {
      const state = new CompressionState();
      const msgWithToolRole: ProjectableMessage = {
        id: 't1',
        role: 'tool',
        content: 'tool result data',
      };
      const result = getContextView([...transcript, msgWithToolRole], state, MAX_TOKENS);
      expect(result.tokenDistribution.tool).toBeGreaterThan(0);
    });

    it('total tokens equals sum of all role buckets plus overhead', () => {
      const state = new CompressionState();
      const result = getContextView(transcript, state, MAX_TOKENS);
      const { system, user, assistant, tool } = result.tokenDistribution;
      // totalTokens includes per-message overhead (4 per message) + base overhead (3)
      const overheadExpected = 3 + transcript.length * 4;
      expect(result.totalTokens).toBe(system + user + assistant + tool + overheadExpected);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Compression status from state
  // -------------------------------------------------------------------------
  describe('returns compression status from state', () => {
    it('reflects snipped message count', () => {
      const state = new CompressionState();
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['u1', 'u2'],
        timestamp: Date.now(),
      });

      const transcript = [
        makeMsg('u1', 'user', 'snipped message 1'),
        makeMsg('u2', 'user', 'snipped message 2'),
        makeMsg('a1', 'assistant', 'reply'),
      ];

      const result = getContextView(transcript, state, MAX_TOKENS);
      expect(result.compressionStatus.snippedCount).toBe(2);
    });

    it('reflects collapsed spans count', () => {
      const state = new CompressionState();
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['u1', 'a1', 'u2'],
        timestamp: Date.now(),
        metadata: { summary: 'Earlier conversation about greetings', originalTokens: 150 },
      });

      const transcript = [
        makeMsg('u1', 'user', 'Hi'),
        makeMsg('a1', 'assistant', 'Hello'),
        makeMsg('u2', 'user', 'How are you?'),
        makeMsg('a2', 'assistant', 'Fine!'),
      ];

      const result = getContextView(transcript, state, MAX_TOKENS);
      expect(result.compressionStatus.collapsedSpans).toBe(1);
    });

    it('reflects layers triggered', () => {
      const state = new CompressionState();
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['t1'],
        timestamp: Date.now(),
        metadata: { originalTokens: 1000, truncatedTokens: 200 },
      });
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['u1'],
        timestamp: Date.now(),
      });

      const result = getContextView([], state, MAX_TOKENS);
      expect(result.compressionStatus.layersTriggered).toContain('tool-result-budget');
      expect(result.compressionStatus.layersTriggered).toContain('snip');
    });

    it('calculates savedTokens from budgeted truncations', () => {
      const state = new CompressionState();
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['t1'],
        timestamp: Date.now(),
        metadata: { originalTokens: 500, truncatedTokens: 100 },
      });
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['t2'],
        timestamp: Date.now(),
        metadata: { originalTokens: 300, truncatedTokens: 50 },
      });

      const result = getContextView([], state, MAX_TOKENS);
      // (500-100) + (300-50) = 650
      expect(result.compressionStatus.savedTokens).toBe(650);
    });

    it('totalCommits matches commit log length', () => {
      const state = new CompressionState();
      state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['x'], timestamp: Date.now() });
      state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['y'], timestamp: Date.now() });

      const result = getContextView([], state, MAX_TOKENS);
      expect(result.compressionStatus.totalCommits).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Total tokens and usagePercent
  // -------------------------------------------------------------------------
  describe('returns total tokens and usage percent', () => {
    it('usagePercent is between 0 and 100 for normal inputs', () => {
      const transcript = [
        makeMsg('u1', 'user', 'test message'),
        makeMsg('a1', 'assistant', 'response'),
      ];
      const state = new CompressionState();
      const result = getContextView(transcript, state, MAX_TOKENS);

      expect(result.usagePercent).toBeGreaterThanOrEqual(0);
      expect(result.usagePercent).toBeLessThanOrEqual(100);
    });

    it('usagePercent increases with more messages', () => {
      const fewMessages = [makeMsg('u1', 'user', 'short')];
      const manyMessages = Array.from({ length: 50 }, (_, i) =>
        makeMsg(`u${i}`, i % 2 === 0 ? 'user' : 'assistant', 'A longer message content to generate more tokens.')
      );

      const state = new CompressionState();
      const resultFew = getContextView(fewMessages, state, MAX_TOKENS);
      const resultMany = getContextView(manyMessages, state, MAX_TOKENS);

      expect(resultMany.usagePercent).toBeGreaterThan(resultFew.usagePercent);
    });

    it('maxTokens is propagated to response', () => {
      const state = new CompressionState();
      const result = getContextView([], state, 50_000);
      expect(result.maxTokens).toBe(50_000);
    });
  });

  // -------------------------------------------------------------------------
  // 5. API view preview
  // -------------------------------------------------------------------------
  describe('apiViewPreview', () => {
    it('truncates long content to 100 chars with ellipsis', () => {
      const longContent = 'a'.repeat(200);
      const transcript = [makeMsg('u1', 'user', longContent)];
      const state = new CompressionState();
      const result = getContextView(transcript, state, MAX_TOKENS);

      const preview = result.apiViewPreview[0];
      expect(preview.contentPreview).toHaveLength(103); // 100 + '...'
      expect(preview.contentPreview.endsWith('...')).toBe(true);
    });

    it('does not truncate short content', () => {
      const shortContent = 'Hello!';
      const transcript = [makeMsg('u1', 'user', shortContent)];
      const state = new CompressionState();
      const result = getContextView(transcript, state, MAX_TOKENS);

      expect(result.apiViewPreview[0].contentPreview).toBe(shortContent);
    });

    it('projects through compression (snipped messages show placeholder)', () => {
      const state = new CompressionState();
      state.applyCommit({
        layer: 'snip',
        operation: 'snip',
        targetMessageIds: ['u1'],
        timestamp: Date.now(),
      });

      const transcript = [makeMsg('u1', 'user', 'original content')];
      const result = getContextView(transcript, state, MAX_TOKENS);

      expect(result.apiViewPreview[0].contentPreview).toContain('[snipped');
    });
  });
});

describe('buildContextViewFromSession()', () => {
  const sessionId = `session-${Date.now()}`;
  const agentId = 'agent-child-1';
  const subagentStore = getSubagentContextStore();
  const interventionState = getContextInterventionState();
  const eventLedger = getContextEventLedger();

  beforeEach(() => {
    subagentStore.clearSession(sessionId);
    eventLedger.clearSession(sessionId);
  });

  afterEach(() => {
    subagentStore.clearSession(sessionId);
    eventLedger.clearSession(sessionId);
  });

  it('returns agent-scoped subagent messages, provenance and intervention state', async () => {
    const sessionMessages: Message[] = [
      {
        id: 'session-user',
        role: 'user',
        content: 'top level request',
        timestamp: 1,
      },
    ];

    const toolResults: ToolResult[] = [
      {
        toolCallId: 'call-search',
        success: true,
        output: 'search result payload',
      },
    ];

    const agentMessages: Message[] = [
      {
        id: 'carry-over',
        role: 'system',
        content: '# 当前会话上下文\nparent summary',
        timestamp: 10,
      },
      {
        id: 'agent-tool',
        role: 'tool',
        content: JSON.stringify(toolResults),
        toolResults,
        timestamp: 20,
      },
    ];

    const compressionState = new CompressionState();
    compressionState.applyCommit({
      layer: 'tool-result-budget',
      operation: 'truncate',
      targetMessageIds: ['agent-tool'],
      timestamp: 21,
      metadata: { originalTokens: 500, truncatedTokens: 100 },
    });

    subagentStore.upsert({
      sessionId,
      agentId,
      messages: agentMessages,
      annotations: {
        'carry-over': {
          category: 'dependency_carry_over',
          sourceDetail: 'parent carry-over',
          agentId,
        },
        'agent-tool': {
          category: 'tool_result',
          sourceDetail: 'search_web',
          agentId,
        },
      },
      compressionState,
      maxTokens: 4096,
      updatedAt: Date.now(),
    });

    interventionState.applyIntervention(sessionId, undefined, 'carry-over', 'exclude', true);
    interventionState.applyIntervention(sessionId, agentId, 'agent-tool', 'pin', true);

    const appService: AgentApplicationService = {
      getMessages: async () => sessionMessages,
      getSerializedCompressionState: () => null,
      getCurrentSessionId: () => sessionId,
      sendMessage: async () => {},
      cancel: async () => {},
      handlePermissionResponse: () => {},
      interruptAndContinue: async () => {},
      getWorkingDirectory: () => undefined,
      setWorkingDirectory: () => {},
      createSession: async () => { throw new Error('not implemented'); },
      loadSession: async () => { throw new Error('not implemented'); },
      deleteSession: async () => { throw new Error('not implemented'); },
      listSessions: async () => [],
      updateSession: async () => {},
      archiveSession: async () => null,
      unarchiveSession: async () => null,
      loadOlderMessages: async () => ({ messages: [], hasMore: false }),
      exportSession: async () => null,
      importSession: async () => sessionId,
      setCurrentSessionId: () => {},
      getMemoryContext: async () => null,
      switchModel: () => {},
      getModelOverride: () => undefined,
      clearModelOverride: () => {},
      setDelegateMode: () => {},
      isDelegateMode: () => false,
    };

    const result = await buildContextViewFromSession(
      { sessionId, agentId },
      { getAppService: () => appService },
    );

    expect(result.sessionId).toBe(sessionId);
    expect(result.agentId).toBe(agentId);
    expect(result.maxTokens).toBe(4096);
    expect(result.contextItems.map((item) => item.id)).toEqual(expect.arrayContaining(['carry-over', 'agent-tool']));
    expect(result.contextItems.map((item) => item.id)).not.toContain('session-user');
    expect(result.provenanceEntries?.every((entry) => entry.agentId === agentId)).toBe(true);
    expect(result.provenanceEntries?.find((entry) => entry.id === 'agent-tool:pinned')?.category).toBe('tool_result');
    expect(result.contextItems.find((item) => item.id === 'carry-over')?.selection).toBe('excluded');
    expect(result.contextItems.find((item) => item.id === 'carry-over')?.provenance.categories).toContain('dependency_carry_over');
    expect(result.contextItems.find((item) => item.id === 'agent-tool')?.provenance.sourceDetail).toBe('search_web');
    expect(result.rawInterventions).toEqual({
      pinned: ['agent-tool'],
      excluded: [],
      retained: [],
    });
    expect(result.effectiveInterventions).toEqual({
      pinned: ['agent-tool'],
      excluded: ['carry-over'],
      retained: [],
    });
  });

  it('falls back to session view when agentId is omitted', async () => {
    const fallbackSessionId = `${sessionId}-fallback`;
    const sessionMessages: Message[] = [
      {
        id: 'session-only',
        role: 'user',
        content: 'session scope only',
        timestamp: 1,
      },
    ];

    subagentStore.upsert({
      sessionId: fallbackSessionId,
      agentId,
      messages: [
        {
          id: 'agent-only',
          role: 'assistant',
          content: 'agent scope only',
          timestamp: 2,
        },
      ],
      updatedAt: Date.now(),
    });

    const appService: AgentApplicationService = {
      getMessages: async () => sessionMessages,
      getSerializedCompressionState: () => null,
      getCurrentSessionId: () => fallbackSessionId,
      sendMessage: async () => {},
      cancel: async () => {},
      handlePermissionResponse: () => {},
      interruptAndContinue: async () => {},
      getWorkingDirectory: () => undefined,
      setWorkingDirectory: () => {},
      createSession: async () => { throw new Error('not implemented'); },
      loadSession: async () => { throw new Error('not implemented'); },
      deleteSession: async () => { throw new Error('not implemented'); },
      listSessions: async () => [],
      updateSession: async () => {},
      archiveSession: async () => null,
      unarchiveSession: async () => null,
      loadOlderMessages: async () => ({ messages: [], hasMore: false }),
      exportSession: async () => null,
      importSession: async () => fallbackSessionId,
      setCurrentSessionId: () => {},
      getMemoryContext: async () => null,
      switchModel: () => {},
      getModelOverride: () => undefined,
      clearModelOverride: () => {},
      setDelegateMode: () => {},
      isDelegateMode: () => false,
    };

    const result = await buildContextViewFromSession(
      { sessionId: fallbackSessionId },
      { getAppService: () => appService },
    );

    expect(result.sessionId).toBe(fallbackSessionId);
    expect(result.agentId).toBeUndefined();
    expect(result.contextItems.map((item) => item.id)).toEqual(['session-only']);
    expect(result.contextItems.map((item) => item.id)).not.toContain('agent-only');

    subagentStore.clearSession(fallbackSessionId);
    eventLedger.clearSession(fallbackSessionId);
  });

  it('preserves multiple runtime provenance categories for the same message', async () => {
    const multiEventSessionId = `${sessionId}-multi-event`;
    const now = Date.now();
    const sessionMessages: Message[] = [
      {
        id: 'session-attachment',
        role: 'user',
        content: 'uploaded notes',
        attachments: [
          {
            id: 'attachment-1',
            type: 'file',
            category: 'text',
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 12,
            path: '/tmp/notes.txt',
          },
        ],
        timestamp: 1,
      },
    ];

    eventLedger.upsertEvents([
      {
        id: '',
        sessionId: multiEventSessionId,
        messageId: 'session-attachment',
        category: 'recent_turn',
        action: 'added',
        sourceKind: 'message',
        sourceDetail: 'user_message',
        reason: 'recent user turn',
        timestamp: now,
      },
      {
        id: '',
        sessionId: multiEventSessionId,
        messageId: 'session-attachment',
        category: 'attachment',
        action: 'retrieved',
        sourceKind: 'attachment',
        sourceDetail: 'notes.txt',
        reason: 'contains attachment',
        timestamp: now + 1,
      },
    ]);

    const appService: AgentApplicationService = {
      getMessages: async () => sessionMessages,
      getSerializedCompressionState: () => null,
      getCurrentSessionId: () => multiEventSessionId,
      sendMessage: async () => {},
      cancel: async () => {},
      handlePermissionResponse: () => {},
      interruptAndContinue: async () => {},
      getWorkingDirectory: () => undefined,
      setWorkingDirectory: () => {},
      createSession: async () => { throw new Error('not implemented'); },
      loadSession: async () => { throw new Error('not implemented'); },
      deleteSession: async () => { throw new Error('not implemented'); },
      listSessions: async () => [],
      updateSession: async () => {},
      archiveSession: async () => null,
      unarchiveSession: async () => null,
      loadOlderMessages: async () => ({ messages: [], hasMore: false }),
      exportSession: async () => null,
      importSession: async () => multiEventSessionId,
      setCurrentSessionId: () => {},
      getMemoryContext: async () => null,
      switchModel: () => {},
      getModelOverride: () => undefined,
      clearModelOverride: () => {},
      setDelegateMode: () => {},
      isDelegateMode: () => false,
    };

    const result = await buildContextViewFromSession(
      { sessionId: multiEventSessionId },
      { getAppService: () => appService },
    );

    const item = result.contextItems.find((entry) => entry.id === 'session-attachment');
    expect(item?.provenance.categories).toEqual(expect.arrayContaining(['recent_turn', 'attachment']));
    expect(item?.provenance.sourceDetail).toBe('notes.txt');
    expect(result.provenance.find((entry) => entry.messageId === 'session-attachment')?.source).toBe('user');

    eventLedger.clearSession(multiEventSessionId);
  });
});
