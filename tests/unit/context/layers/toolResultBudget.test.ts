// ============================================================================
// L1: Tool Result Budget Tests
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { applyToolResultBudget } from '../../../../src/main/context/layers/toolResultBudget';
import { CompressionState } from '../../../../src/main/context/compressionState';
import { estimateTokens } from '../../../../src/main/context/tokenEstimator';

type TestMessage = { id: string; role: string; content: string; toolCallId?: string };

function makeToolMsg(id: string, content: string): TestMessage {
  return { id, role: 'tool', content };
}

function makeAssistantMsg(id: string, content: string, toolCallId?: string): TestMessage {
  return { id, role: 'assistant', content, toolCallId };
}

function makeUserMsg(id: string, content: string): TestMessage {
  return { id, role: 'user', content };
}

/** Generate text of approximately `targetTokens` tokens. */
function makeText(targetTokens: number): string {
  // ~4 chars per token for English text
  return 'word '.repeat(targetTokens);
}

describe('applyToolResultBudget', () => {
  let state: CompressionState;

  beforeEach(() => {
    state = new CompressionState();
  });

  // --------------------------------------------------------------------------
  // Short messages — should not be truncated
  // --------------------------------------------------------------------------
  describe('messages within budget', () => {
    it('should not truncate tool result under 2000 tokens', () => {
      const msg = makeToolMsg('t1', 'short result');
      applyToolResultBudget([msg], state);
      expect(msg.content).toBe('short result');
      expect(state.getCommitLog()).toHaveLength(0);
    });

    it('should not truncate user messages', () => {
      const content = makeText(3000);
      const msg = makeUserMsg('u1', content);
      applyToolResultBudget([msg], state);
      expect(msg.content).toBe(content);
      expect(state.getCommitLog()).toHaveLength(0);
    });

    it('should not truncate assistant messages without toolCallId', () => {
      const content = makeText(3000);
      const msg = makeAssistantMsg('a1', content);
      applyToolResultBudget([msg], state);
      expect(msg.content).toBe(content);
      expect(state.getCommitLog()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Messages that exceed budget — should be truncated
  // --------------------------------------------------------------------------
  describe('truncation', () => {
    it('should truncate tool result over 2000 tokens', () => {
      const bigContent = makeText(3000);
      const originalTokens = estimateTokens(bigContent);
      expect(originalTokens).toBeGreaterThan(2000);

      const msg = makeToolMsg('t1', bigContent);
      applyToolResultBudget([msg], state);

      const truncatedTokens = estimateTokens(msg.content);
      expect(truncatedTokens).toBeLessThanOrEqual(2200); // some flex for markers
      expect(msg.content).not.toBe(bigContent);
    });

    it('should truncate assistant message with toolCallId', () => {
      const bigContent = makeText(3000);
      const msg = makeAssistantMsg('a1', bigContent, 'call_123');
      applyToolResultBudget([msg], state);
      expect(estimateTokens(msg.content)).toBeLessThan(estimateTokens(bigContent));
    });

    it('should write a commit with correct layer and operation', () => {
      const msg = makeToolMsg('t1', makeText(3000));
      applyToolResultBudget([msg], state);

      const commits = state.getCommitLog();
      expect(commits).toHaveLength(1);
      expect(commits[0].layer).toBe('tool-result-budget');
      expect(commits[0].operation).toBe('truncate');
      expect(commits[0].targetMessageIds).toEqual(['t1']);
    });

    it('should record originalTokens and truncatedTokens in metadata', () => {
      const bigContent = makeText(3000);
      const originalTokens = estimateTokens(bigContent);

      const msg = makeToolMsg('t1', bigContent);
      applyToolResultBudget([msg], state);

      const commit = state.getCommitLog()[0];
      expect(commit.metadata?.originalTokens).toBeGreaterThan(2000);
      expect(commit.metadata?.truncatedTokens).toBeLessThan(originalTokens);
      expect(typeof commit.metadata?.originalTokens).toBe('number');
      expect(typeof commit.metadata?.truncatedTokens).toBe('number');
    });

    it('should write one commit per truncated message', () => {
      const msgs = [
        makeToolMsg('t1', makeText(3000)),
        makeToolMsg('t2', 'small'),
        makeToolMsg('t3', makeText(2500)),
      ];
      applyToolResultBudget(msgs, state);

      const commits = state.getCommitLog();
      expect(commits).toHaveLength(2);
      expect(commits[0].targetMessageIds).toEqual(['t1']);
      expect(commits[1].targetMessageIds).toEqual(['t3']);
    });
  });

  // --------------------------------------------------------------------------
  // Code block preservation
  // --------------------------------------------------------------------------
  describe('code block preservation', () => {
    it('should preserve code block when truncating', () => {
      const codeBlock = '```typescript\nconst x = 1;\nconst y = 2;\n```';
      const preamble = 'Here is the result:\n';
      const padding = makeText(2500);
      const content = preamble + codeBlock + '\n' + padding;

      const msg = makeToolMsg('t1', content);
      applyToolResultBudget([msg], state);

      expect(msg.content).toContain('```typescript');
      expect(msg.content).toContain('const x = 1;');
    });
  });

  // --------------------------------------------------------------------------
  // Custom config
  // --------------------------------------------------------------------------
  describe('custom config', () => {
    it('should respect custom maxTokensPerResult', () => {
      const content = makeText(600); // ~600 tokens — over 500, under 2000
      const msg = makeToolMsg('t1', content);

      applyToolResultBudget([msg], state, { maxTokensPerResult: 500 });

      expect(state.getCommitLog()).toHaveLength(1);
      expect(estimateTokens(msg.content)).toBeLessThanOrEqual(600);
    });

    it('should not truncate when content is under custom threshold', () => {
      const content = 'small result';
      const msg = makeToolMsg('t1', content);
      applyToolResultBudget([msg], state, { maxTokensPerResult: 100 });
      expect(msg.content).toBe(content);
    });
  });

  // --------------------------------------------------------------------------
  // Snapshot state
  // --------------------------------------------------------------------------
  describe('snapshot state', () => {
    it('should record in budgetedResults snapshot', () => {
      const msg = makeToolMsg('t1', makeText(3000));
      applyToolResultBudget([msg], state);

      const snapshot = state.getSnapshot();
      expect(snapshot.budgetedResults.has('t1')).toBe(true);
      const result = snapshot.budgetedResults.get('t1')!;
      expect(result.originalTokens).toBeGreaterThan(2000);
      expect(result.truncatedTokens).toBeLessThan(result.originalTokens);
    });
  });
});
