# M1: Token + Context Projection + Loop Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade context management from in-place mutation to projection-first architecture, and agent loop from single-retry to multi-branch decision system.

**Architecture:** Replace character-ratio token estimation with real tokenizer (`gpt-tokenizer` already in deps). Build immutable transcript + separate CompressionState + query-time ProjectionEngine. Implement 6-layer compression pipeline writing to CompressionState. Add explicit loop decision engine with continue/compact/continuation/fallback/terminate branches.

**Tech Stack:** TypeScript, gpt-tokenizer (existing dep), vitest (testing)

**Design Spec:** `docs/superpowers/specs/2026-04-01-architecture-alignment-design.md` — M1 section

---

## Task 1: Precise Token Counting (M1-S1)

**Files:**
- Modify: `src/main/context/tokenEstimator.ts`
- Modify: `src/shared/constants/index.ts` (add TOKENIZER_MAP)
- Modify: `src/shared/constants/models.ts` (add TOKENIZER_MAP)
- Test: `tests/unit/context/tokenEstimator.test.ts` (existing, extend)

- [ ] **Step 1: Write test for real tokenizer accuracy**

```typescript
// tests/unit/context/tokenEstimator.test.ts — add new describe block
import { estimateTokens, estimateMessageTokens, countTokensExact } from '../../../src/main/context/tokenEstimator';

describe('precise token counting (tiktoken-based)', () => {
  it('counts English text accurately', () => {
    const text = 'Hello, world! This is a test of precise token counting.';
    const tokens = estimateTokens(text);
    // gpt-tokenizer cl100k_base: "Hello, world!" = 4 tokens
    // Real count should be ~12-13, not the old heuristic ~16
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(16);
  });

  it('counts CJK text accurately', () => {
    const text = '你好世界，这是一个精确的token计数测试。';
    const tokens = estimateTokens(text);
    // CJK characters are typically 1-2 tokens each in cl100k_base
    // Old heuristic would give ~9 (18 chars / 2.0), real should be ~14-18
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(25);
  });

  it('counts code accurately', () => {
    const code = 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}';
    const tokens = estimateTokens(code);
    // Real tokenization should be ~35-40 tokens
    expect(tokens).toBeGreaterThan(25);
    expect(tokens).toBeLessThan(50);
  });

  it('countTokensExact returns accurate count for message array', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
    ];
    const total = countTokensExact(messages);
    // system ~6 tokens + overhead, user ~2 tokens + overhead
    expect(total).toBeGreaterThan(8);
    expect(total).toBeLessThan(20);
  });

  it('LRU cache returns same result on second call', () => {
    const text = 'Cache test string for token estimation';
    const first = estimateTokens(text);
    const second = estimateTokens(text);
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/context/tokenEstimator.test.ts --reporter=verbose`
Expected: FAIL — `countTokensExact` not defined, token counts outside expected ranges

- [ ] **Step 3: Add TOKENIZER_MAP constant**

```typescript
// src/shared/constants/models.ts — add at end of file

/**
 * Maps model families to their tokenizer encoding.
 * Used by tokenEstimator for precise token counting.
 */
export const TOKENIZER_MAP: Record<string, string> = {
  // OpenAI / Anthropic models use cl100k_base
  'claude': 'cl100k_base',
  'gpt-4': 'cl100k_base',
  'gpt-3.5': 'cl100k_base',
  // Most Chinese models approximate cl100k_base well enough
  'deepseek': 'cl100k_base',
  'moonshot': 'cl100k_base',
  'kimi': 'cl100k_base',
  'glm': 'cl100k_base',
  'qwen': 'cl100k_base',
  'minimax': 'cl100k_base',
  // Default fallback
  'default': 'cl100k_base',
} as const;

export const DEFAULT_TOKENIZER = 'cl100k_base';
```

Add to barrel export in `src/shared/constants/index.ts`:
```typescript
export { TOKENIZER_MAP, DEFAULT_TOKENIZER } from './models';
```

- [ ] **Step 4: Replace tokenEstimator core algorithm**

Rewrite `src/main/context/tokenEstimator.ts`:
- Keep all existing exports and interfaces (backward compatible)
- Replace `estimateTokens()` internals: use `encode()` from `gpt-tokenizer` instead of character ratios
- Keep LRU cache (200 entries) but cache real token counts
- Add new export `countTokensExact(messages: Message[]): number`
- Keep `TOKEN_RATIOS` exported (for backward compat) but mark deprecated
- Keep `analyzeContent()` exported (still useful for content classification)
- Key change in `estimateTokens()`:

```typescript
import { encode } from 'gpt-tokenizer';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  
  const hash = simpleHash(text);
  const cached = cache.get(hash);
  if (cached !== undefined) {
    // Move to MRU
    cache.delete(hash);
    cache.set(hash, cached);
    return cached;
  }
  
  const tokens = encode(text).length;
  
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(hash, tokens);
  
  return tokens;
}

export function countTokensExact(messages: Message[]): number {
  let total = 3; // base overhead for message array
  for (const msg of messages) {
    total += 4; // role overhead per message
    total += estimateTokens(msg.content);
  }
  return total;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/context/tokenEstimator.test.ts --reporter=verbose`
Expected: All tests PASS (both new and existing)

- [ ] **Step 6: Run full typecheck**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add src/main/context/tokenEstimator.ts src/shared/constants/models.ts src/shared/constants/index.ts tests/unit/context/tokenEstimator.test.ts
git commit -m "feat(context): replace heuristic token estimation with gpt-tokenizer

Use real BPE tokenization (gpt-tokenizer, already in deps) instead of
character-ratio heuristics. Reduces estimation error from 10-30% to <1%.
Adds countTokensExact() for message-array-level counting.
Backward compatible: all existing exports preserved."
```

---

## Task 2: CompressionState + ProjectionEngine (M1-S2)

**Files:**
- Create: `src/main/context/compressionState.ts`
- Create: `src/main/context/projectionEngine.ts`
- Test: `tests/unit/context/compressionState.test.ts`
- Test: `tests/unit/context/projectionEngine.test.ts`

- [ ] **Step 1: Write CompressionState tests**

```typescript
// tests/unit/context/compressionState.test.ts
import { CompressionState, CompressionCommit } from '../../../src/main/context/compressionState';

describe('CompressionState', () => {
  let state: CompressionState;

  beforeEach(() => {
    state = new CompressionState();
  });

  describe('commit log', () => {
    it('appends commits in order', () => {
      state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['msg-1'], timestamp: 1000 });
      state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['msg-2'], timestamp: 2000 });
      expect(state.getCommitLog()).toHaveLength(2);
      expect(state.getCommitLog()[0].targetMessageIds).toEqual(['msg-1']);
    });

    it('updates snapshot on commit', () => {
      state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['msg-1'], timestamp: 1000 });
      expect(state.getSnapshot().snippedIds).toContain('msg-1');
    });
  });

  describe('snapshot', () => {
    it('tracks snipped message IDs', () => {
      state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['msg-1', 'msg-2'], timestamp: 1000 });
      const snap = state.getSnapshot();
      expect(snap.snippedIds).toEqual(new Set(['msg-1', 'msg-2']));
    });

    it('tracks tool-result budget truncations', () => {
      state.applyCommit({
        layer: 'tool-result-budget',
        operation: 'truncate',
        targetMessageIds: ['tool-1'],
        timestamp: 1000,
        metadata: { originalTokens: 5000, truncatedTokens: 2000 },
      });
      const snap = state.getSnapshot();
      expect(snap.budgetedResults.get('tool-1')).toEqual({ originalTokens: 5000, truncatedTokens: 2000 });
    });

    it('tracks collapsed spans', () => {
      state.applyCommit({
        layer: 'contextCollapse',
        operation: 'collapse',
        targetMessageIds: ['msg-3', 'msg-4', 'msg-5'],
        timestamp: 1000,
        metadata: { summary: 'User asked about auth, agent read 3 files.' },
      });
      const snap = state.getSnapshot();
      expect(snap.collapsedSpans).toHaveLength(1);
      expect(snap.collapsedSpans[0].messageIds).toEqual(['msg-3', 'msg-4', 'msg-5']);
    });
  });

  describe('reset', () => {
    it('clears snapshot and records reset commit', () => {
      state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['msg-1'], timestamp: 1000 });
      state.reset();
      expect(state.getSnapshot().snippedIds.size).toBe(0);
      const log = state.getCommitLog();
      expect(log[log.length - 1].operation).toBe('reset');
    });
  });

  describe('serialization', () => {
    it('serializes and deserializes correctly', () => {
      state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['msg-1'], timestamp: 1000 });
      const json = state.serialize();
      const restored = CompressionState.deserialize(json);
      expect(restored.getSnapshot().snippedIds).toContain('msg-1');
      expect(restored.getCommitLog()).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/context/compressionState.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CompressionState**

```typescript
// src/main/context/compressionState.ts

export interface CompressionCommit {
  layer: 'tool-result-budget' | 'snip' | 'microcompact' | 'contextCollapse' | 'autocompact' | 'overflow-recovery' | 'system';
  operation: 'truncate' | 'snip' | 'compact' | 'collapse' | 'drain' | 'reset';
  targetMessageIds: string[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface CollapsedSpan {
  messageIds: string[];
  summary: string;
  originalTokens?: number;
}

export interface CompressionSnapshot {
  snippedIds: Set<string>;
  budgetedResults: Map<string, { originalTokens: number; truncatedTokens: number }>;
  collapsedSpans: CollapsedSpan[];
  microcompactedIds: Set<string>;
}

export class CompressionState {
  private commitLog: CompressionCommit[] = [];
  private snapshot: CompressionSnapshot = {
    snippedIds: new Set(),
    budgetedResults: new Map(),
    collapsedSpans: [],
    microcompactedIds: new Set(),
  };

  applyCommit(commit: CompressionCommit): void {
    this.commitLog.push(commit);
    this.updateSnapshot(commit);
  }

  private updateSnapshot(commit: CompressionCommit): void {
    switch (commit.operation) {
      case 'snip':
        for (const id of commit.targetMessageIds) {
          this.snapshot.snippedIds.add(id);
        }
        break;
      case 'truncate':
        if (commit.layer === 'tool-result-budget' && commit.metadata) {
          for (const id of commit.targetMessageIds) {
            this.snapshot.budgetedResults.set(id, {
              originalTokens: commit.metadata.originalTokens as number,
              truncatedTokens: commit.metadata.truncatedTokens as number,
            });
          }
        }
        break;
      case 'collapse':
        if (commit.metadata?.summary) {
          this.snapshot.collapsedSpans.push({
            messageIds: commit.targetMessageIds,
            summary: commit.metadata.summary as string,
            originalTokens: commit.metadata.originalTokens as number | undefined,
          });
        }
        break;
      case 'compact':
        if (commit.layer === 'microcompact') {
          for (const id of commit.targetMessageIds) {
            this.snapshot.microcompactedIds.add(id);
          }
        }
        break;
      case 'reset':
        this.snapshot = {
          snippedIds: new Set(),
          budgetedResults: new Map(),
          collapsedSpans: [],
          microcompactedIds: new Set(),
        };
        break;
    }
  }

  getCommitLog(): readonly CompressionCommit[] {
    return this.commitLog;
  }

  getSnapshot(): Readonly<CompressionSnapshot> {
    return this.snapshot;
  }

  getCommitsByLayer(layer: CompressionCommit['layer']): CompressionCommit[] {
    return this.commitLog.filter(c => c.layer === layer);
  }

  reset(): void {
    this.applyCommit({
      layer: 'system',
      operation: 'reset',
      targetMessageIds: [],
      timestamp: Date.now(),
    });
  }

  serialize(): string {
    return JSON.stringify({
      commitLog: this.commitLog,
      snapshot: {
        snippedIds: [...this.snapshot.snippedIds],
        budgetedResults: [...this.snapshot.budgetedResults.entries()],
        collapsedSpans: this.snapshot.collapsedSpans,
        microcompactedIds: [...this.snapshot.microcompactedIds],
      },
    });
  }

  static deserialize(json: string): CompressionState {
    const data = JSON.parse(json);
    const state = new CompressionState();
    // Replay commits to rebuild snapshot correctly
    for (const commit of data.commitLog) {
      state.applyCommit(commit);
    }
    return state;
  }
}
```

- [ ] **Step 4: Run CompressionState tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/context/compressionState.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Write ProjectionEngine tests**

```typescript
// tests/unit/context/projectionEngine.test.ts
import { ProjectionEngine } from '../../../src/main/context/projectionEngine';
import { CompressionState } from '../../../src/main/context/compressionState';

interface TestMessage {
  id: string;
  role: string;
  content: string;
  toolCallId?: string;
}

describe('ProjectionEngine', () => {
  let engine: ProjectionEngine;

  beforeEach(() => {
    engine = new ProjectionEngine();
  });

  it('returns transcript unchanged when no compressions applied', () => {
    const transcript: TestMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Hello' },
      { id: 'msg-2', role: 'assistant', content: 'Hi there!' },
    ];
    const state = new CompressionState();
    const result = engine.projectMessages(transcript, state);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Hello');
  });

  it('replaces snipped messages with placeholder', () => {
    const transcript: TestMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Hello' },
      { id: 'msg-2', role: 'assistant', content: 'A very long response...' },
      { id: 'msg-3', role: 'user', content: 'Thanks' },
    ];
    const state = new CompressionState();
    state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['msg-2'], timestamp: 1000 });

    const result = engine.projectMessages(transcript, state);
    expect(result).toHaveLength(3);
    expect(result[1].content).toMatch(/\[snipped/);
    expect(result[0].content).toBe('Hello');
    expect(result[2].content).toBe('Thanks');
  });

  it('replaces collapsed spans with summary', () => {
    const transcript: TestMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Read auth.ts' },
      { id: 'msg-2', role: 'assistant', content: 'Reading file...' },
      { id: 'msg-3', role: 'assistant', content: 'File contents: ...' },
      { id: 'msg-4', role: 'user', content: 'Now fix the bug' },
    ];
    const state = new CompressionState();
    state.applyCommit({
      layer: 'contextCollapse',
      operation: 'collapse',
      targetMessageIds: ['msg-1', 'msg-2', 'msg-3'],
      timestamp: 1000,
      metadata: { summary: 'User asked to read auth.ts, file was read successfully.' },
    });

    const result = engine.projectMessages(transcript, state);
    // 3 messages collapsed into 1 summary + msg-4 remains
    expect(result).toHaveLength(2);
    expect(result[0].content).toContain('User asked to read auth.ts');
    expect(result[0].role).toBe('system');
    expect(result[1].content).toBe('Now fix the bug');
  });

  it('applies multiple compression layers in correct order', () => {
    const transcript: TestMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Start' },
      { id: 'msg-2', role: 'assistant', content: 'Response 1' },
      { id: 'msg-3', role: 'user', content: 'Continue' },
      { id: 'msg-4', role: 'assistant', content: 'Response 2' },
      { id: 'msg-5', role: 'user', content: 'Latest' },
    ];
    const state = new CompressionState();
    // Snip msg-2
    state.applyCommit({ layer: 'snip', operation: 'snip', targetMessageIds: ['msg-2'], timestamp: 1000 });
    // Collapse msg-1 + snipped msg-2
    state.applyCommit({
      layer: 'contextCollapse',
      operation: 'collapse',
      targetMessageIds: ['msg-1', 'msg-2'],
      timestamp: 2000,
      metadata: { summary: 'Initial greeting exchange.' },
    });

    const result = engine.projectMessages(transcript, state);
    // msg-1+msg-2 collapsed into 1, msg-3, msg-4, msg-5 remain
    expect(result).toHaveLength(4);
    expect(result[0].content).toContain('Initial greeting');
  });
});
```

- [ ] **Step 6: Implement ProjectionEngine**

```typescript
// src/main/context/projectionEngine.ts
import { CompressionState, CompressionSnapshot, CollapsedSpan } from './compressionState';

export interface ProjectableMessage {
  id: string;
  role: string;
  content: string;
  [key: string]: unknown;
}

export class ProjectionEngine {
  /**
   * Pure function: projects transcript through compression state to generate API view.
   * Does NOT modify the input transcript.
   */
  projectMessages(transcript: ProjectableMessage[], state: CompressionState): ProjectableMessage[] {
    const snapshot = state.getSnapshot();

    // Phase 1: Apply collapsed spans (replace spans with summaries)
    let messages = this.applyCollapses(transcript, snapshot.collapsedSpans);

    // Phase 2: Apply snips (replace individual messages with placeholders)
    messages = this.applySnips(messages, snapshot.snippedIds);

    // Phase 3: Apply tool-result budgets (truncate tool results)
    messages = this.applyBudgets(messages, snapshot.budgetedResults);

    return messages;
  }

  private applyCollapses(messages: ProjectableMessage[], spans: readonly CollapsedSpan[]): ProjectableMessage[] {
    if (spans.length === 0) return [...messages];

    const result: ProjectableMessage[] = [];
    const collapsedIds = new Set<string>();
    const spanMap = new Map<string, CollapsedSpan>();

    // Build lookup: first message ID of each span → span
    for (const span of spans) {
      for (const id of span.messageIds) {
        collapsedIds.add(id);
      }
      if (span.messageIds.length > 0) {
        spanMap.set(span.messageIds[0], span);
      }
    }

    for (const msg of messages) {
      if (spanMap.has(msg.id)) {
        // First message of a collapsed span → replace with summary
        const span = spanMap.get(msg.id)!;
        result.push({
          id: `collapsed-${msg.id}`,
          role: 'system',
          content: `[collapsed: ${span.messageIds.length} turns] ${span.summary}`,
        });
      } else if (!collapsedIds.has(msg.id)) {
        // Not part of any collapsed span → keep
        result.push({ ...msg });
      }
      // else: part of collapsed span but not first → skip
    }

    return result;
  }

  private applySnips(messages: ProjectableMessage[], snippedIds: ReadonlySet<string>): ProjectableMessage[] {
    if (snippedIds.size === 0) return messages;

    return messages.map(msg => {
      if (snippedIds.has(msg.id)) {
        return {
          ...msg,
          content: `[snipped: message compressed]`,
        };
      }
      return msg;
    });
  }

  private applyBudgets(
    messages: ProjectableMessage[],
    budgetedResults: ReadonlyMap<string, { originalTokens: number; truncatedTokens: number }>,
  ): ProjectableMessage[] {
    if (budgetedResults.size === 0) return messages;

    return messages.map(msg => {
      const budget = budgetedResults.get(msg.id);
      if (budget) {
        // Content was already truncated when the commit was applied;
        // The budget metadata is informational. If content wasn't stored
        // in the commit, we'd truncate here. For now, pass through.
        return msg;
      }
      return msg;
    });
  }
}
```

- [ ] **Step 7: Run ProjectionEngine tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/context/projectionEngine.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 8: Typecheck**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: No type errors

- [ ] **Step 9: Commit**

```bash
git add src/main/context/compressionState.ts src/main/context/projectionEngine.ts tests/unit/context/compressionState.test.ts tests/unit/context/projectionEngine.test.ts
git commit -m "feat(context): add CompressionState and ProjectionEngine

Core of the projection-first architecture:
- CompressionState: immutable commit log + snapshot, serialize/deserialize
- ProjectionEngine: pure function projecting transcript through compression state
Transcript is never mutated; API view generated at query time."
```

---

## Task 3: Six-Layer Compression Pipeline (M1-S3)

**Files:**
- Create: `src/main/context/layers/toolResultBudget.ts`
- Create: `src/main/context/layers/snip.ts`
- Create: `src/main/context/layers/microcompact.ts`
- Create: `src/main/context/layers/contextCollapse.ts`
- Create: `src/main/context/layers/overflowRecovery.ts`
- Create: `src/main/context/compressionPipeline.ts`
- Test: `tests/unit/context/layers/toolResultBudget.test.ts`
- Test: `tests/unit/context/layers/snip.test.ts`
- Test: `tests/unit/context/compressionPipeline.test.ts`

- [ ] **Step 1: Write L1 tool-result budget tests**

```typescript
// tests/unit/context/layers/toolResultBudget.test.ts
import { applyToolResultBudget } from '../../../../src/main/context/layers/toolResultBudget';
import { CompressionState } from '../../../../src/main/context/compressionState';
import { estimateTokens } from '../../../../src/main/context/tokenEstimator';

describe('L1: tool-result budget', () => {
  it('does not truncate results under budget', () => {
    const messages = [
      { id: 'msg-1', role: 'tool', content: 'Short result', toolCallId: 'tc-1' },
    ];
    const state = new CompressionState();
    applyToolResultBudget(messages, state, { maxTokensPerResult: 2000 });
    expect(state.getCommitLog()).toHaveLength(0);
  });

  it('truncates results exceeding budget', () => {
    const longContent = 'x'.repeat(10000); // ~2800 tokens
    const messages = [
      { id: 'msg-1', role: 'tool', content: longContent, toolCallId: 'tc-1' },
    ];
    const state = new CompressionState();
    applyToolResultBudget(messages, state, { maxTokensPerResult: 500 });
    expect(state.getCommitLog()).toHaveLength(1);
    expect(state.getSnapshot().budgetedResults.has('msg-1')).toBe(true);
  });

  it('preserves code blocks when truncating', () => {
    const content = 'Some narrative...\n```typescript\nconst x = 1;\n```\n' + 'y'.repeat(10000);
    const messages = [
      { id: 'msg-1', role: 'tool', content, toolCallId: 'tc-1' },
    ];
    const state = new CompressionState();
    applyToolResultBudget(messages, state, { maxTokensPerResult: 500 });
    // Should have commit, but the truncation should try to preserve code
    expect(state.getCommitLog()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement L1 tool-result budget**

```typescript
// src/main/context/layers/toolResultBudget.ts
import { CompressionState } from '../compressionState';
import { estimateTokens } from '../tokenEstimator';

export interface ToolResultBudgetConfig {
  maxTokensPerResult: number; // default: 2000
}

const DEFAULT_CONFIG: ToolResultBudgetConfig = {
  maxTokensPerResult: 2000,
};

export function applyToolResultBudget(
  messages: Array<{ id: string; role: string; content: string; toolCallId?: string }>,
  state: CompressionState,
  config: Partial<ToolResultBudgetConfig> = {},
): void {
  const { maxTokensPerResult } = { ...DEFAULT_CONFIG, ...config };

  for (const msg of messages) {
    if (msg.role !== 'tool' && !msg.toolCallId) continue;

    const tokens = estimateTokens(msg.content);
    if (tokens <= maxTokensPerResult) continue;

    const truncated = truncateToolResult(msg.content, maxTokensPerResult);
    const truncatedTokens = estimateTokens(truncated);

    state.applyCommit({
      layer: 'tool-result-budget',
      operation: 'truncate',
      targetMessageIds: [msg.id],
      timestamp: Date.now(),
      metadata: { originalTokens: tokens, truncatedTokens },
    });

    // Mutate the message content (this is the one place we modify message content directly,
    // because tool results are being budgeted before entering the transcript)
    msg.content = truncated;
  }
}

function truncateToolResult(content: string, maxTokens: number): string {
  // Strategy: preserve head + tail with [truncated] in middle
  // For code-heavy results, try to preserve code blocks
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = content.match(codeBlockRegex);

  if (codeBlocks && codeBlocks.length > 0) {
    // Preserve first code block + head/tail narrative
    const firstBlock = codeBlocks[0];
    const blockTokens = estimateTokens(firstBlock);
    const remainingBudget = maxTokens - blockTokens - 20; // 20 tokens for truncation notice

    if (remainingBudget > 100) {
      const beforeBlock = content.substring(0, content.indexOf(firstBlock));
      const afterAll = content.substring(content.lastIndexOf('```') + 3);
      const headBudget = Math.floor(remainingBudget * 0.3);
      const tailBudget = Math.floor(remainingBudget * 0.3);
      const head = truncateToTokens(beforeBlock, headBudget);
      const tail = truncateToTokens(afterAll, tailBudget);
      return `${head}\n${firstBlock}\n[...truncated ${estimateTokens(content) - maxTokens} tokens...]\n${tail}`.trim();
    }
  }

  // Fallback: head + tail split
  const headBudget = Math.floor(maxTokens * 0.6);
  const tailBudget = Math.floor(maxTokens * 0.3);
  const head = truncateToTokens(content, headBudget);
  const tail = truncateToTokens(reverseString(content), tailBudget);
  return `${head}\n[...truncated...]\n${reverseString(tail)}`;
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  // Binary search for cutoff point
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.substring(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.substring(0, lo);
}

function reverseString(s: string): string {
  return s.split('').reverse().join('');
}
```

- [ ] **Step 3: Run L1 tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/context/layers/toolResultBudget.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 4: Write L2 snip tests**

```typescript
// tests/unit/context/layers/snip.test.ts
import { applySnip } from '../../../../src/main/context/layers/snip';
import { CompressionState } from '../../../../src/main/context/compressionState';

describe('L2: snip', () => {
  it('does not snip recent messages', () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      turnIndex: i,
    }));
    const state = new CompressionState();
    applySnip(messages, state, { currentTurnIndex: 7, preserveRecentTurns: 5 });
    // All within recent 5 turns → nothing snipped
    expect(state.getCommitLog()).toHaveLength(0);
  });

  it('snips old non-critical assistant messages', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      turnIndex: Math.floor(i / 2),
    }));
    const state = new CompressionState();
    applySnip(messages, state, { currentTurnIndex: 10, preserveRecentTurns: 5 });
    // Messages in turns 0-4 (indices 0-9) are candidates, but only assistant messages get snipped
    const snipped = state.getSnapshot().snippedIds;
    expect(snipped.size).toBeGreaterThan(0);
    // User messages should NOT be snipped
    for (const id of snipped) {
      const idx = parseInt(id.split('-')[1]);
      expect(messages[idx].role).toBe('assistant');
    }
  });

  it('does not snip messages containing code blocks', () => {
    const messages = [
      { id: 'msg-0', role: 'assistant', content: 'Here is code:\n```js\nconst x = 1;\n```', turnIndex: 0 },
      { id: 'msg-1', role: 'assistant', content: 'Just a plain response without code.', turnIndex: 1 },
    ];
    const state = new CompressionState();
    applySnip(messages, state, { currentTurnIndex: 15, preserveRecentTurns: 5 });
    const snipped = state.getSnapshot().snippedIds;
    expect(snipped.has('msg-0')).toBe(false); // has code, protected
    expect(snipped.has('msg-1')).toBe(true);  // no code, snipped
  });
});
```

- [ ] **Step 5: Implement L2 snip**

```typescript
// src/main/context/layers/snip.ts
import { CompressionState } from '../compressionState';

export interface SnipConfig {
  currentTurnIndex: number;
  preserveRecentTurns: number; // default: 5
}

const CODE_BLOCK_REGEX = /```[\s\S]*?```/;

export function applySnip(
  messages: Array<{ id: string; role: string; content: string; turnIndex: number }>,
  state: CompressionState,
  config: SnipConfig,
): void {
  const { currentTurnIndex, preserveRecentTurns } = config;
  const cutoffTurn = currentTurnIndex - preserveRecentTurns;
  const toSnip: string[] = [];

  for (const msg of messages) {
    // Skip recent messages
    if (msg.turnIndex >= cutoffTurn) continue;
    // Skip user messages (always preserve user intent)
    if (msg.role === 'user') continue;
    // Skip system messages
    if (msg.role === 'system') continue;
    // Skip messages with code blocks
    if (CODE_BLOCK_REGEX.test(msg.content)) continue;
    // Skip already-snipped messages
    if (state.getSnapshot().snippedIds.has(msg.id)) continue;

    toSnip.push(msg.id);
  }

  if (toSnip.length > 0) {
    state.applyCommit({
      layer: 'snip',
      operation: 'snip',
      targetMessageIds: toSnip,
      timestamp: Date.now(),
    });
  }
}
```

- [ ] **Step 6: Run L2 tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/context/layers/snip.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 7: Implement L3 microcompact (stub with config gate)**

```typescript
// src/main/context/layers/microcompact.ts
import { CompressionState } from '../compressionState';
import { estimateTokens } from '../tokenEstimator';

export interface MicrocompactConfig {
  isMainThread: boolean;
  cacheHot: boolean;
  idleMinutes: number;
}

/**
 * L3 Microcompact: cache-aware fine-grained compression.
 * - cached path: only compress outside cache prefix
 * - time-based path: more aggressive when cache is cold (idle >5min)
 * Only runs on main thread to avoid forked agent state pollution.
 */
export function applyMicrocompact(
  messages: Array<{ id: string; role: string; content: string }>,
  state: CompressionState,
  config: MicrocompactConfig,
): void {
  if (!config.isMainThread) return;

  const path = config.cacheHot ? 'cached' : 'time-based';

  if (path === 'cached') {
    applyCachedMicrocompact(messages, state);
  } else if (config.idleMinutes >= 5) {
    applyTimeBasedMicrocompact(messages, state);
  }
}

function applyCachedMicrocompact(
  messages: Array<{ id: string; role: string; content: string }>,
  state: CompressionState,
): void {
  // Cache-safe: only compress tool results and assistant messages in dynamic segment
  const snapshot = state.getSnapshot();
  const toCompact: string[] = [];

  for (const msg of messages) {
    if (snapshot.snippedIds.has(msg.id)) continue;
    if (snapshot.microcompactedIds.has(msg.id)) continue;
    if (msg.role === 'user' || msg.role === 'system') continue;

    const tokens = estimateTokens(msg.content);
    if (tokens > 500) {
      // Compress: remove whitespace, shorten repetitive patterns
      msg.content = compactText(msg.content);
      toCompact.push(msg.id);
    }
  }

  if (toCompact.length > 0) {
    state.applyCommit({
      layer: 'microcompact',
      operation: 'compact',
      targetMessageIds: toCompact,
      timestamp: Date.now(),
    });
  }
}

function applyTimeBasedMicrocompact(
  messages: Array<{ id: string; role: string; content: string }>,
  state: CompressionState,
): void {
  // More aggressive: also compress older user messages (not recent 3)
  const snapshot = state.getSnapshot();
  const toCompact: string[] = [];
  const recentCount = 6; // protect last 3 user-assistant pairs

  for (let i = 0; i < messages.length - recentCount; i++) {
    const msg = messages[i];
    if (snapshot.snippedIds.has(msg.id)) continue;
    if (snapshot.microcompactedIds.has(msg.id)) continue;

    const tokens = estimateTokens(msg.content);
    if (tokens > 300) {
      msg.content = compactText(msg.content);
      toCompact.push(msg.id);
    }
  }

  if (toCompact.length > 0) {
    state.applyCommit({
      layer: 'microcompact',
      operation: 'compact',
      targetMessageIds: toCompact,
      timestamp: Date.now(),
    });
  }
}

function compactText(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')           // collapse excessive newlines
    .replace(/[ \t]{2,}/g, ' ')            // collapse whitespace
    .replace(/^[ \t]+/gm, '')              // remove leading whitespace per line
    .replace(/(```[\s\S]*?```)/g, '$1')    // preserve code blocks as-is
    .trim();
}
```

- [ ] **Step 8: Implement L4 contextCollapse**

```typescript
// src/main/context/layers/contextCollapse.ts
import { CompressionState } from '../compressionState';
import { estimateTokens } from '../tokenEstimator';

export interface ContextCollapseConfig {
  /** Minimum consecutive messages to form a collapsible span */
  minSpanSize: number; // default: 3
  /** Function to generate summary (injected, uses compression model) */
  summarize: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  /** Max tokens for the summary */
  maxSummaryTokens: number; // default: 200
}

const DEFAULT_CONFIG: Partial<ContextCollapseConfig> = {
  minSpanSize: 3,
  maxSummaryTokens: 200,
};

/**
 * L4 ContextCollapse: select contiguous spans of tool-call-heavy conversation
 * and replace them with model-generated summaries.
 */
export async function applyContextCollapse(
  messages: Array<{ id: string; role: string; content: string; turnIndex: number }>,
  state: CompressionState,
  config: ContextCollapseConfig,
): Promise<void> {
  const { minSpanSize, summarize, maxSummaryTokens } = { ...DEFAULT_CONFIG, ...config };
  const snapshot = state.getSnapshot();
  const collapsedIds = new Set(snapshot.collapsedSpans.flatMap(s => s.messageIds));

  // Find candidate spans: consecutive tool-call + result sequences
  const spans = findCollapsibleSpans(messages, minSpanSize!, collapsedIds, snapshot.snippedIds);

  for (const span of spans) {
    const spanMessages = span.map(id => messages.find(m => m.id === id)!);
    const originalTokens = spanMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    // Only collapse if we'd save significant tokens
    if (originalTokens < maxSummaryTokens! * 3) continue;

    const summary = await summarize(spanMessages.map(m => ({ role: m.role, content: m.content })));

    state.applyCommit({
      layer: 'contextCollapse',
      operation: 'collapse',
      targetMessageIds: span,
      timestamp: Date.now(),
      metadata: { summary, originalTokens },
    });
  }
}

function findCollapsibleSpans(
  messages: Array<{ id: string; role: string; content: string }>,
  minSize: number,
  alreadyCollapsed: Set<string>,
  snippedIds: ReadonlySet<string>,
): string[][] {
  const spans: string[][] = [];
  let currentSpan: string[] = [];

  for (const msg of messages) {
    if (alreadyCollapsed.has(msg.id) || snippedIds.has(msg.id)) {
      if (currentSpan.length >= minSize) spans.push(currentSpan);
      currentSpan = [];
      continue;
    }

    // Tool results and assistant responses referencing tools are collapsible
    const isToolRelated = msg.role === 'tool' ||
      (msg.role === 'assistant' && msg.content.includes('tool_call'));

    if (isToolRelated) {
      currentSpan.push(msg.id);
    } else {
      if (currentSpan.length >= minSize) spans.push(currentSpan);
      currentSpan = [];
    }
  }

  if (currentSpan.length >= minSize) spans.push(currentSpan);
  return spans;
}
```

- [ ] **Step 9: Implement L6 overflow recovery**

```typescript
// src/main/context/layers/overflowRecovery.ts
import { CompressionState } from '../compressionState';

/**
 * L6 Overflow Recovery: emergency drain all staged compressions.
 * Called when API returns ContextLengthExceededError or 413.
 * Does NOT switch models (that's the loop decision engine's job).
 */
export function applyOverflowRecovery(
  state: CompressionState,
): void {
  state.applyCommit({
    layer: 'overflow-recovery',
    operation: 'drain',
    targetMessageIds: [],
    timestamp: Date.now(),
    metadata: { reason: 'context_overflow' },
  });
}
```

- [ ] **Step 10: Implement CompressionPipeline coordinator**

```typescript
// src/main/context/compressionPipeline.ts
import { CompressionState } from './compressionState';
import { ProjectionEngine, ProjectableMessage } from './projectionEngine';
import { applyToolResultBudget, ToolResultBudgetConfig } from './layers/toolResultBudget';
import { applySnip } from './layers/snip';
import { applyMicrocompact, MicrocompactConfig } from './layers/microcompact';
import { applyContextCollapse, ContextCollapseConfig } from './layers/contextCollapse';
import { applyOverflowRecovery } from './layers/overflowRecovery';
import { countTokensExact } from './tokenEstimator';

export interface PipelineConfig {
  maxTokens: number;
  currentTurnIndex: number;
  isMainThread: boolean;
  cacheHot: boolean;
  idleMinutes: number;
  /** Injected summarizer for L4 contextCollapse */
  summarize?: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  /** Feature gates */
  enableSnip: boolean;
  enableMicrocompact: boolean;
  enableContextCollapse: boolean;
  /** Tool result budget */
  toolResultBudget: number; // default: 2000 tokens
}

export interface PipelineResult {
  apiView: ProjectableMessage[];
  totalTokens: number;
  layersTriggered: string[];
  compressionState: CompressionState;
}

const THRESHOLDS = {
  snip: 0.50,
  microcompact: 0.60,
  contextCollapse: 0.75,
  autocompact: 0.85,
};

export class CompressionPipeline {
  private projectionEngine = new ProjectionEngine();

  async evaluate(
    transcript: Array<ProjectableMessage & { turnIndex: number; toolCallId?: string }>,
    state: CompressionState,
    config: PipelineConfig,
  ): Promise<PipelineResult> {
    const layersTriggered: string[] = [];

    // L1: Tool-result budget (always active, per-result)
    applyToolResultBudget(
      transcript as Array<{ id: string; role: string; content: string; toolCallId?: string }>,
      state,
      { maxTokensPerResult: config.toolResultBudget },
    );
    // Check if any commits were added for L1
    const l1Commits = state.getCommitsByLayer('tool-result-budget');
    if (l1Commits.length > 0) layersTriggered.push('L1:tool-result-budget');

    // Project to get current token count
    let apiView = this.projectionEngine.projectMessages(transcript, state);
    let totalTokens = countTokensExact(apiView as Array<{ role: string; content: string }>);
    let usagePercent = totalTokens / config.maxTokens;

    // L2: Snip (≥50%)
    if (config.enableSnip && usagePercent >= THRESHOLDS.snip) {
      applySnip(
        transcript as Array<{ id: string; role: string; content: string; turnIndex: number }>,
        state,
        { currentTurnIndex: config.currentTurnIndex, preserveRecentTurns: 5 },
      );
      apiView = this.projectionEngine.projectMessages(transcript, state);
      totalTokens = countTokensExact(apiView as Array<{ role: string; content: string }>);
      usagePercent = totalTokens / config.maxTokens;
      layersTriggered.push('L2:snip');
    }

    // L3: Microcompact (≥60%)
    if (config.enableMicrocompact && usagePercent >= THRESHOLDS.microcompact) {
      applyMicrocompact(
        apiView as Array<{ id: string; role: string; content: string }>,
        state,
        { isMainThread: config.isMainThread, cacheHot: config.cacheHot, idleMinutes: config.idleMinutes },
      );
      apiView = this.projectionEngine.projectMessages(transcript, state);
      totalTokens = countTokensExact(apiView as Array<{ role: string; content: string }>);
      usagePercent = totalTokens / config.maxTokens;
      layersTriggered.push('L3:microcompact');
    }

    // L4: ContextCollapse (≥75%)
    if (config.enableContextCollapse && usagePercent >= THRESHOLDS.contextCollapse && config.summarize) {
      await applyContextCollapse(
        transcript as Array<{ id: string; role: string; content: string; turnIndex: number }>,
        state,
        { minSpanSize: 3, summarize: config.summarize, maxSummaryTokens: 200 },
      );
      apiView = this.projectionEngine.projectMessages(transcript, state);
      totalTokens = countTokensExact(apiView as Array<{ role: string; content: string }>);
      usagePercent = totalTokens / config.maxTokens;
      layersTriggered.push('L4:contextCollapse');
    }

    // L5: Autocompact (≥85%) — delegated to existing autoCompressor (called from agent loop)
    // Not called here; the pipeline reports the need and the loop decides.

    return { apiView, totalTokens, layersTriggered, compressionState: state };
  }

  /**
   * Emergency overflow recovery (L6).
   * Called when API returns overflow error.
   */
  handleOverflow(state: CompressionState): void {
    applyOverflowRecovery(state);
  }
}
```

- [ ] **Step 11: Write pipeline integration test**

```typescript
// tests/unit/context/compressionPipeline.test.ts
import { CompressionPipeline } from '../../../src/main/context/compressionPipeline';
import { CompressionState } from '../../../src/main/context/compressionState';

function makeMessages(count: number, contentSize = 100): Array<{ id: string; role: string; content: string; turnIndex: number }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(contentSize),
    turnIndex: Math.floor(i / 2),
  }));
}

describe('CompressionPipeline', () => {
  let pipeline: CompressionPipeline;

  beforeEach(() => {
    pipeline = new CompressionPipeline();
  });

  it('returns uncompressed view when under all thresholds', async () => {
    const messages = makeMessages(4, 10);
    const state = new CompressionState();
    const result = await pipeline.evaluate(messages, state, {
      maxTokens: 100000,
      currentTurnIndex: 2,
      isMainThread: true,
      cacheHot: false,
      idleMinutes: 0,
      enableSnip: true,
      enableMicrocompact: true,
      enableContextCollapse: true,
      toolResultBudget: 2000,
    });
    expect(result.apiView).toHaveLength(4);
    expect(result.layersTriggered).toEqual([]);
  });

  it('triggers L2 snip when usage exceeds 50%', async () => {
    // Create messages that would exceed 50% of a small window
    const messages = makeMessages(20, 500);
    const state = new CompressionState();
    const result = await pipeline.evaluate(messages, state, {
      maxTokens: 5000, // small window to trigger compression
      currentTurnIndex: 10,
      isMainThread: true,
      cacheHot: false,
      idleMinutes: 0,
      enableSnip: true,
      enableMicrocompact: true,
      enableContextCollapse: true,
      toolResultBudget: 2000,
    });
    expect(result.layersTriggered).toContain('L2:snip');
  });
});
```

- [ ] **Step 12: Run pipeline tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/context/compressionPipeline.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 13: Typecheck all**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: No type errors

- [ ] **Step 14: Commit**

```bash
git add src/main/context/layers/ src/main/context/compressionPipeline.ts tests/unit/context/layers/ tests/unit/context/compressionPipeline.test.ts
git commit -m "feat(context): implement 6-layer compression pipeline

L1 tool-result-budget, L2 snip, L3 microcompact, L4 contextCollapse,
L5 autocompact (delegates to existing), L6 overflow recovery.
All layers write to CompressionState; ProjectionEngine generates API view.
Feature-gated: each layer can be independently enabled/disabled."
```

---

## Task 4: Main Loop Multi-Branch Decision (M1-S4)

**Files:**
- Create: `src/main/agent/loopDecision.ts`
- Create: `src/main/model/errorClassifier.ts`
- Modify: `src/main/agent/runtime/conversationRuntime.ts` (integration)
- Modify: `src/main/agent/agentLoop.ts` (wire decision engine)
- Test: `tests/unit/agent/loopDecision.test.ts`
- Test: `tests/unit/model/errorClassifier.test.ts`

- [ ] **Step 1: Write error classifier tests**

```typescript
// tests/unit/model/errorClassifier.test.ts
import { classifyError, ErrorClass } from '../../../src/main/model/errorClassifier';

describe('ErrorClassifier', () => {
  it('classifies context overflow', () => {
    const error = new Error('context_length_exceeded: max 128000 tokens');
    expect(classifyError(error)).toBe('overflow');
  });

  it('classifies 413 as overflow', () => {
    const error = Object.assign(new Error('Request too large'), { status: 413 });
    expect(classifyError(error)).toBe('overflow');
  });

  it('classifies rate limit', () => {
    const error = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    expect(classifyError(error)).toBe('rate_limit');
  });

  it('classifies auth errors', () => {
    const error = new Error('invalid_api_key');
    expect(classifyError(error)).toBe('auth');
  });

  it('classifies network errors', () => {
    const error = new Error('ECONNRESET');
    expect(classifyError(error)).toBe('network');
  });

  it('classifies unknown errors', () => {
    const error = new Error('Something unexpected');
    expect(classifyError(error)).toBe('unknown');
  });
});
```

- [ ] **Step 2: Implement error classifier**

```typescript
// src/main/model/errorClassifier.ts

export type ErrorClass = 'overflow' | 'rate_limit' | 'auth' | 'network' | 'unavailable' | 'unknown';

const OVERFLOW_PATTERNS = [
  'context_length_exceeded',
  'maximum context length',
  'prompt is too long',
  'request too large',
  'token limit',
];

const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', 'quota exceeded'];

const AUTH_PATTERNS = ['invalid_api_key', 'authentication_error', 'invalid token', 'unauthorized', 'forbidden'];

const NETWORK_PATTERNS = ['econnreset', 'econnrefused', 'etimedout', 'socket hang up', 'network error', 'fetch failed'];

const UNAVAILABLE_PATTERNS = ['service unavailable', 'bad gateway', 'gateway timeout', 'internal server error'];

export function classifyError(error: unknown): ErrorClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = (error as { status?: number })?.status;

  // Status code based
  if (status === 413) return 'overflow';
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  if (status === 500) return 'unavailable';

  // Pattern based
  if (OVERFLOW_PATTERNS.some(p => message.includes(p))) return 'overflow';
  if (RATE_LIMIT_PATTERNS.some(p => message.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => message.includes(p))) return 'auth';
  if (NETWORK_PATTERNS.some(p => message.includes(p))) return 'network';
  if (UNAVAILABLE_PATTERNS.some(p => message.includes(p))) return 'unavailable';

  return 'unknown';
}
```

- [ ] **Step 3: Run error classifier tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/model/errorClassifier.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 4: Write loop decision tests**

```typescript
// tests/unit/agent/loopDecision.test.ts
import { decideNextAction, LoopState } from '../../../src/main/agent/loopDecision';

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    stopReason: 'end_turn',
    tokenUsage: { input: 5000, output: 1000 },
    maxTokens: 128000,
    errorType: null,
    consecutiveErrors: 0,
    budgetRemaining: 1.0,
    iterationCount: 1,
    maxIterations: 30,
    ...overrides,
  };
}

describe('decideNextAction', () => {
  it('returns continue on normal completion', () => {
    const result = decideNextAction(makeState());
    expect(result.action).toBe('continue');
  });

  it('returns continuation on max_tokens stop', () => {
    const result = decideNextAction(makeState({ stopReason: 'max_tokens' }));
    expect(result.action).toBe('continuation');
  });

  it('returns compact on overflow error', () => {
    const result = decideNextAction(makeState({ errorType: 'overflow' }));
    expect(result.action).toBe('compact');
  });

  it('returns fallback after overflow + compact already tried', () => {
    const result = decideNextAction(makeState({ errorType: 'overflow', consecutiveErrors: 2 }));
    expect(result.action).toBe('fallback');
  });

  it('returns terminate on budget exhausted', () => {
    const result = decideNextAction(makeState({ budgetRemaining: 0 }));
    expect(result.action).toBe('terminate');
    expect(result.reason).toContain('budget');
  });

  it('returns terminate after 3 consecutive errors', () => {
    const result = decideNextAction(makeState({ consecutiveErrors: 3, errorType: 'unknown' }));
    expect(result.action).toBe('terminate');
  });

  it('returns terminate at max iterations', () => {
    const result = decideNextAction(makeState({ iterationCount: 30, maxIterations: 30 }));
    expect(result.action).toBe('terminate');
  });

  it('returns fallback on rate_limit', () => {
    const result = decideNextAction(makeState({ errorType: 'rate_limit' }));
    expect(result.action).toBe('fallback');
  });

  it('returns fallback on unavailable', () => {
    const result = decideNextAction(makeState({ errorType: 'unavailable' }));
    expect(result.action).toBe('fallback');
  });
});
```

- [ ] **Step 5: Implement loop decision engine**

```typescript
// src/main/agent/loopDecision.ts
import { ErrorClass } from '../model/errorClassifier';

export type LoopAction = 'continue' | 'compact' | 'continuation' | 'fallback' | 'terminate';

export interface LoopState {
  stopReason: string; // 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | etc.
  tokenUsage: { input: number; output: number };
  maxTokens: number;
  errorType: ErrorClass | null;
  consecutiveErrors: number;
  budgetRemaining: number; // 0-1, fraction of total budget
  iterationCount: number;
  maxIterations: number;
}

export interface LoopDecision {
  action: LoopAction;
  reason: string;
  params?: Record<string, unknown>;
}

/** FallbackStrategy interface — M1 uses simple chain, M4 replaces with adaptive router */
export interface FallbackStrategy {
  selectFallback(context: {
    errorType: ErrorClass;
    currentModel?: string;
    currentProvider?: string;
  }): { provider: string; model: string } | null;
}

export function decideNextAction(state: LoopState): LoopDecision {
  // Priority 1: Hard terminators
  if (state.budgetRemaining <= 0) {
    return { action: 'terminate', reason: 'budget exhausted' };
  }
  if (state.iterationCount >= state.maxIterations) {
    return { action: 'terminate', reason: `max iterations reached (${state.maxIterations})` };
  }
  if (state.consecutiveErrors >= 3) {
    return { action: 'terminate', reason: `${state.consecutiveErrors} consecutive errors (${state.errorType})` };
  }

  // Priority 2: Error recovery
  if (state.errorType) {
    switch (state.errorType) {
      case 'overflow':
        // First overflow → try compact; second → fallback to bigger window model
        if (state.consecutiveErrors <= 1) {
          return { action: 'compact', reason: 'context overflow, triggering compression' };
        }
        return { action: 'fallback', reason: 'context overflow persists after compression, switching model' };

      case 'rate_limit':
        return { action: 'fallback', reason: 'rate limited, switching provider' };

      case 'unavailable':
        return { action: 'fallback', reason: 'provider unavailable, switching' };

      case 'auth':
        return { action: 'terminate', reason: 'authentication error, cannot recover' };

      case 'network':
        // Network errors are retried by retryStrategy; if we get here, retries exhausted
        if (state.consecutiveErrors >= 2) {
          return { action: 'fallback', reason: 'network errors persisting, trying different provider' };
        }
        return { action: 'continue', reason: 'network error, will retry' };

      default:
        return { action: 'terminate', reason: `unrecoverable error: ${state.errorType}` };
    }
  }

  // Priority 3: Model output handling
  if (state.stopReason === 'max_tokens') {
    return {
      action: 'continuation',
      reason: 'model hit output limit, requesting continuation',
      params: { continuationPrompt: 'Continue from where you stopped. Do not restate or apologize.' },
    };
  }

  // Priority 4: Context pressure (preemptive)
  const usagePercent = state.tokenUsage.input / state.maxTokens;
  if (usagePercent >= 0.85) {
    return { action: 'compact', reason: `context pressure at ${Math.round(usagePercent * 100)}%` };
  }

  // Default: continue
  return { action: 'continue', reason: 'normal' };
}
```

- [ ] **Step 6: Run loop decision tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/agent/loopDecision.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 7: Integrate into conversationRuntime.ts**

Modify `src/main/agent/runtime/conversationRuntime.ts`:
- Import `decideNextAction` and `LoopState` from `../loopDecision`
- Import `classifyError` from `../../model/errorClassifier`
- After each model call + tool execution cycle, call `decideNextAction()` to determine next step
- Handle `continuation` action: append continuation message and re-call model
- Handle `compact` action: trigger `compressionPipeline.evaluate()`
- Handle `fallback` action: call `modelRouter.switchToFallback()` (use existing `PROVIDER_FALLBACK_CHAIN`)
- Handle `terminate` action: log reason and exit loop gracefully

Key integration point (find the main iteration loop and add after model response):

```typescript
// After receiving model response and processing tool calls:
const loopState: LoopState = {
  stopReason: response.stopReason ?? 'end_turn',
  tokenUsage: { input: response.usage?.inputTokens ?? 0, output: response.usage?.outputTokens ?? 0 },
  maxTokens: this.contextWindow,
  errorType: lastError ? classifyError(lastError) : null,
  consecutiveErrors: this.consecutiveErrorCount,
  budgetRemaining: this.budgetService.getRemainingFraction(),
  iterationCount: this.iterationCount,
  maxIterations: this.config.maxIterations ?? 30,
};

const decision = decideNextAction(loopState);

switch (decision.action) {
  case 'continuation':
    this.messages.push({ role: 'user', content: decision.params!.continuationPrompt as string });
    continue; // next iteration
  case 'compact':
    await this.triggerCompression();
    continue;
  case 'fallback':
    this.switchToFallbackModel();
    continue;
  case 'terminate':
    this.logger.info(`Loop terminating: ${decision.reason}`);
    break; // exit loop
  case 'continue':
  default:
    // Normal flow
    break;
}
```

- [ ] **Step 8: Typecheck**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: No type errors

- [ ] **Step 9: Run existing agent loop tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/agent/ --reporter=verbose`
Expected: All existing tests PASS (no regression)

- [ ] **Step 10: Commit**

```bash
git add src/main/agent/loopDecision.ts src/main/model/errorClassifier.ts src/main/agent/runtime/conversationRuntime.ts tests/unit/agent/loopDecision.test.ts tests/unit/model/errorClassifier.test.ts
git commit -m "feat(agent): add multi-branch loop decision engine

Each iteration ends with explicit decision: continue/compact/continuation/
fallback/terminate. Implements max_output_tokens continuation protocol and
error-classified fallback routing. Replaces one-shot overflow recovery."
```

---

## Task 5: Cache Stability Layer (M1-S5)

**Files:**
- Create: `src/main/prompts/cacheBreakDetection.ts`
- Modify: `src/main/prompts/builder.ts` (add dynamic boundary)
- Test: `tests/unit/prompts/cacheBreakDetection.test.ts`

- [ ] **Step 1: Write cache break detection tests**

```typescript
// tests/unit/prompts/cacheBreakDetection.test.ts
import { detectCacheBreak, CacheBreakResult } from '../../../src/main/prompts/cacheBreakDetection';

describe('cacheBreakDetection', () => {
  it('reports no break when prompts are identical', () => {
    const result = detectCacheBreak('System prompt v1', 'System prompt v1');
    expect(result.broken).toBe(false);
  });

  it('detects break when system prompt changes', () => {
    const result = detectCacheBreak('System prompt v1', 'System prompt v2');
    expect(result.broken).toBe(true);
    expect(result.reason).toContain('system prompt');
  });

  it('detects break when model changes', () => {
    const result = detectCacheBreak('prompt', 'prompt', { prevModel: 'kimi-k2.5', currModel: 'deepseek-chat' });
    expect(result.broken).toBe(true);
    expect(result.reason).toContain('model');
  });

  it('ignores dynamic section changes', () => {
    const prev = 'STATIC_PREFIX|||DYNAMIC:old_value';
    const curr = 'STATIC_PREFIX|||DYNAMIC:new_value';
    const result = detectCacheBreak(prev, curr, { dynamicBoundary: '|||' });
    expect(result.broken).toBe(false);
  });
});
```

- [ ] **Step 2: Implement cache break detection**

```typescript
// src/main/prompts/cacheBreakDetection.ts

export interface CacheBreakResult {
  broken: boolean;
  reason: string;
}

export interface CacheBreakOptions {
  prevModel?: string;
  currModel?: string;
  dynamicBoundary?: string;
}

const DYNAMIC_BOUNDARY_MARKER = '\n<!-- DYNAMIC_SECTION -->\n';

export { DYNAMIC_BOUNDARY_MARKER };

export function detectCacheBreak(
  prevPrompt: string,
  currPrompt: string,
  options: CacheBreakOptions = {},
): CacheBreakResult {
  const { prevModel, currModel, dynamicBoundary = DYNAMIC_BOUNDARY_MARKER } = options;

  // Check model change
  if (prevModel && currModel && prevModel !== currModel) {
    return { broken: true, reason: `model changed: ${prevModel} → ${currModel}` };
  }

  // Split at dynamic boundary
  const prevStatic = prevPrompt.split(dynamicBoundary)[0] ?? prevPrompt;
  const currStatic = currPrompt.split(dynamicBoundary)[0] ?? currPrompt;

  // Compare static prefix
  if (prevStatic !== currStatic) {
    return { broken: true, reason: 'system prompt static prefix changed' };
  }

  return { broken: false, reason: '' };
}

/**
 * Splits a system prompt into cacheable prefix and dynamic section.
 * Usage: const [prefix, dynamic] = splitAtDynamicBoundary(prompt);
 */
export function splitAtDynamicBoundary(prompt: string): [string, string] {
  const idx = prompt.indexOf(DYNAMIC_BOUNDARY_MARKER);
  if (idx === -1) return [prompt, ''];
  return [prompt.substring(0, idx), prompt.substring(idx + DYNAMIC_BOUNDARY_MARKER.length)];
}
```

- [ ] **Step 3: Run cache break tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/prompts/cacheBreakDetection.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 4: Modify builder.ts to inject dynamic boundary**

Modify `src/main/prompts/builder.ts`:
- Import `DYNAMIC_BOUNDARY_MARKER` from `./cacheBreakDetection`
- In `buildPrompt()`, insert the boundary marker between stable and dynamic sections:

```typescript
// In buildPrompt():
export function buildPrompt(): string {
  // Stable prefix (cacheable)
  const stablePrefix = [
    getSoul(),
    TOOLS_PROMPT,
    ...getToolDescriptions(),
  ].join('\n\n');

  // Dynamic section (changes per turn)
  const dynamicSection = [
    ...getRulesForPrompt(),
    GENERATIVE_UI_PROMPT,
  ].join('\n\n');

  return `${stablePrefix}${DYNAMIC_BOUNDARY_MARKER}${dynamicSection}`;
}
```

- [ ] **Step 5: Typecheck + test**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck && npx vitest run tests/unit/prompts/ --reporter=verbose`
Expected: No type errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/main/prompts/cacheBreakDetection.ts src/main/prompts/builder.ts tests/unit/prompts/cacheBreakDetection.test.ts
git commit -m "feat(prompts): add cache stability layer with dynamic boundary

Split system prompt into cacheable prefix (identity+tools) and dynamic
section (rules+reminders). Cache break detection tracks prompt/model changes.
Enables prompt cache TTL stability across turns."
```

---

## Task 6: /context Observability Command (M1-S6)

**Files:**
- Create: `src/main/ipc/context.ipc.ts`
- Create: `src/renderer/components/ContextPanel.tsx`
- Create: `src/cli/commands/context.ts` (if CLI supports custom commands)
- Test: `tests/unit/ipc/context.ipc.test.ts`

- [ ] **Step 1: Write /context IPC handler tests**

```typescript
// tests/unit/ipc/context.ipc.test.ts
import { getContextView } from '../../../src/main/ipc/context.ipc';

// Mock dependencies
vi.mock('../../../src/main/context/projectionEngine', () => ({
  ProjectionEngine: vi.fn().mockImplementation(() => ({
    projectMessages: vi.fn().mockReturnValue([
      { id: '1', role: 'system', content: 'System prompt' },
      { id: '2', role: 'user', content: 'Hello' },
      { id: '3', role: 'assistant', content: 'Hi!' },
    ]),
  })),
}));

vi.mock('../../../src/main/context/tokenEstimator', () => ({
  estimateTokens: vi.fn().mockReturnValue(10),
  countTokensExact: vi.fn().mockReturnValue(30),
}));

describe('context IPC handler', () => {
  it('returns token distribution by role', async () => {
    const result = await getContextView({ sessionId: 'test' });
    expect(result.tokenDistribution).toBeDefined();
    expect(result.tokenDistribution.system).toBeGreaterThan(0);
    expect(result.tokenDistribution.user).toBeGreaterThan(0);
    expect(result.tokenDistribution.assistant).toBeGreaterThan(0);
  });

  it('returns compression status', async () => {
    const result = await getContextView({ sessionId: 'test' });
    expect(result.compressionStatus).toBeDefined();
    expect(result.compressionStatus.layersTriggered).toBeDefined();
  });

  it('returns total token count and usage percent', async () => {
    const result = await getContextView({ sessionId: 'test' });
    expect(result.totalTokens).toBeDefined();
    expect(result.usagePercent).toBeDefined();
  });
});
```

- [ ] **Step 2: Implement /context IPC handler**

```typescript
// src/main/ipc/context.ipc.ts
import { ProjectionEngine } from '../context/projectionEngine';
import { estimateTokens, countTokensExact } from '../context/tokenEstimator';
import { CompressionState } from '../context/compressionState';

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

/**
 * Get the current context view for observability.
 * Shows what the model actually sees after all projections.
 */
export async function getContextView(
  request: ContextViewRequest,
  // These would be injected from the active session in real integration
  transcript?: Array<{ id: string; role: string; content: string }>,
  compressionState?: CompressionState,
  maxTokens?: number,
): Promise<ContextViewResponse> {
  const engine = new ProjectionEngine();
  const state = compressionState ?? new CompressionState();
  const messages = transcript ?? [];
  const contextWindow = maxTokens ?? 128000;

  const apiView = engine.projectMessages(messages, state);
  const totalTokens = countTokensExact(apiView as Array<{ role: string; content: string }>);

  // Calculate per-role distribution
  const distribution = { system: 0, user: 0, assistant: 0, tool: 0 };
  for (const msg of apiView) {
    const tokens = estimateTokens(msg.content);
    const role = msg.role as keyof typeof distribution;
    if (role in distribution) {
      distribution[role] += tokens;
    }
  }

  // Compression status
  const snapshot = state.getSnapshot();
  const commits = state.getCommitLog();

  return {
    totalTokens,
    maxTokens: contextWindow,
    usagePercent: totalTokens / contextWindow,
    messageCount: apiView.length,
    tokenDistribution: distribution,
    compressionStatus: {
      layersTriggered: [...new Set(commits.map(c => c.layer))],
      totalCommits: commits.length,
      snippedCount: snapshot.snippedIds.size,
      collapsedSpans: snapshot.collapsedSpans.length,
      savedTokens: commits
        .filter(c => c.metadata?.originalTokens && c.metadata?.truncatedTokens)
        .reduce((sum, c) => sum + ((c.metadata!.originalTokens as number) - (c.metadata!.truncatedTokens as number)), 0),
    },
    apiViewPreview: apiView.map(msg => ({
      id: msg.id,
      role: msg.role,
      contentPreview: msg.content.substring(0, 100) + (msg.content.length > 100 ? '...' : ''),
      tokens: estimateTokens(msg.content),
    })),
  };
}
```

- [ ] **Step 3: Create ContextPanel React component**

```tsx
// src/renderer/components/ContextPanel.tsx
import React, { useState, useEffect } from 'react';

interface ContextViewData {
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

export function ContextPanel() {
  const [data, setData] = useState<ContextViewData | null>(null);
  const [loading, setLoading] = useState(false);

  const loadContext = async () => {
    setLoading(true);
    try {
      // IPC call to get context view
      const result = await window.electronAPI?.invoke('context:getView', {});
      if (result) setData(result);
    } catch (e) {
      console.error('Failed to load context view:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadContext(); }, []);

  if (loading) return <div className="p-4 text-gray-400">Loading context view...</div>;
  if (!data) return <div className="p-4 text-gray-400">No context data available</div>;

  const usageColor = data.usagePercent > 0.85 ? 'text-red-400' :
    data.usagePercent > 0.60 ? 'text-yellow-400' : 'text-green-400';

  return (
    <div className="p-4 space-y-4 text-sm font-mono">
      <h2 className="text-lg font-bold">Context View</h2>

      {/* Token Usage Bar */}
      <div>
        <div className="flex justify-between mb-1">
          <span>Token Usage</span>
          <span className={usageColor}>
            {data.totalTokens.toLocaleString()} / {data.maxTokens.toLocaleString()}
            ({Math.round(data.usagePercent * 100)}%)
          </span>
        </div>
        <div className="w-full bg-gray-700 rounded h-2">
          <div
            className={`h-2 rounded ${data.usagePercent > 0.85 ? 'bg-red-500' : data.usagePercent > 0.60 ? 'bg-yellow-500' : 'bg-green-500'}`}
            style={{ width: `${Math.min(100, data.usagePercent * 100)}%` }}
          />
        </div>
      </div>

      {/* Distribution */}
      <div>
        <h3 className="font-bold mb-1">Token Distribution</h3>
        <div className="grid grid-cols-4 gap-2">
          {Object.entries(data.tokenDistribution).map(([role, tokens]) => (
            <div key={role} className="bg-gray-800 p-2 rounded">
              <div className="text-gray-400 text-xs">{role}</div>
              <div>{tokens.toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Compression Status */}
      <div>
        <h3 className="font-bold mb-1">Compression</h3>
        <div className="text-gray-400">
          <div>Layers triggered: {data.compressionStatus.layersTriggered.join(', ') || 'none'}</div>
          <div>Commits: {data.compressionStatus.totalCommits} | Snipped: {data.compressionStatus.snippedCount} | Collapsed: {data.compressionStatus.collapsedSpans}</div>
        </div>
      </div>

      {/* API View Preview */}
      <div>
        <h3 className="font-bold mb-1">API View ({data.messageCount} messages)</h3>
        <div className="max-h-64 overflow-y-auto space-y-1">
          {data.apiViewPreview.map(msg => (
            <div key={msg.id} className="flex gap-2 text-xs">
              <span className={`w-16 shrink-0 ${msg.role === 'system' ? 'text-purple-400' : msg.role === 'user' ? 'text-blue-400' : msg.role === 'tool' ? 'text-yellow-400' : 'text-green-400'}`}>
                {msg.role}
              </span>
              <span className="text-gray-400 w-12 shrink-0">{msg.tokens}t</span>
              <span className="text-gray-300 truncate">{msg.contentPreview}</span>
            </div>
          ))}
        </div>
      </div>

      <button onClick={loadContext} className="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 text-xs">
        Refresh
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npx vitest run tests/unit/ipc/context.ipc.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Typecheck**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/context.ipc.ts src/renderer/components/ContextPanel.tsx tests/unit/ipc/context.ipc.test.ts
git commit -m "feat(context): add /context observability command and panel

Shows API true view (after projection), token distribution by role,
compression status (layers triggered, snipped/collapsed counts),
and message preview. CLI + Web UI support."
```

---

## Task 7: Integration — Wire Pipeline into Agent Loop

**Files:**
- Modify: `src/main/agent/runtime/contextAssembly.ts`
- Modify: `src/main/agent/agentLoop.ts`
- Modify: `src/main/agent/loopTypes.ts`

- [ ] **Step 1: Add CompressionState to RuntimeContext**

Modify `src/main/agent/loopTypes.ts`:
```typescript
import { CompressionState } from '../context/compressionState';
import { CompressionPipeline } from '../context/compressionPipeline';

// Add to RuntimeContext interface:
export interface RuntimeContext {
  // ... existing fields
  compressionState: CompressionState;
  compressionPipeline: CompressionPipeline;
}
```

- [ ] **Step 2: Initialize in agentLoop.ts**

Modify `src/main/agent/agentLoop.ts` constructor:
```typescript
import { CompressionState } from '../context/compressionState';
import { CompressionPipeline } from '../context/compressionPipeline';

// In AgentLoop constructor, add to runtimeContext:
this.runtimeContext.compressionState = new CompressionState();
this.runtimeContext.compressionPipeline = new CompressionPipeline();
```

- [ ] **Step 3: Wire contextAssembly to use ProjectionEngine**

Modify `src/main/agent/runtime/contextAssembly.ts`:
- Import `ProjectionEngine` from `../../context/projectionEngine`
- In the message building flow, use `projectionEngine.projectMessages()` to generate the final API view
- Ensure messages sent to model are projected, not raw transcript
- Key change: `buildAPIMessages()` method calls projection before returning

- [ ] **Step 4: Wire pipeline evaluation into conversation runtime**

Modify `src/main/agent/runtime/conversationRuntime.ts`:
- Before each model call, run `compressionPipeline.evaluate()` if token pressure detected
- After model call, feed results to `decideNextAction()`
- Handle each action branch (already added in Task 4)

- [ ] **Step 5: Typecheck + run all tests**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck && npx vitest run --reporter=verbose`
Expected: All pass

- [ ] **Step 6: Manual smoke test**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run dev`
- Start a conversation
- Send 10+ messages
- Verify token counting works (check logs for real token counts)
- Verify no regression in basic conversation flow

- [ ] **Step 7: Commit**

```bash
git add src/main/agent/runtime/contextAssembly.ts src/main/agent/runtime/conversationRuntime.ts src/main/agent/agentLoop.ts src/main/agent/loopTypes.ts
git commit -m "feat(context): wire projection pipeline into agent loop

CompressionState + CompressionPipeline integrated into RuntimeContext.
contextAssembly uses ProjectionEngine for API view generation.
conversationRuntime uses loopDecision for multi-branch iteration control.
Completes M1 architecture: projection-first context management."
```

---

## Verification Checklist (M1 Complete)

After all 7 tasks:

- [ ] `npm run typecheck` — no errors
- [ ] `npx vitest run` — all tests pass (new + existing)
- [ ] Manual test: long conversation (20+ turns) — context compression triggers, no crash
- [ ] Manual test: send message that causes overflow — verify compact/fallback/terminate decision
- [ ] Manual test: `/context` command — shows token distribution and compression status
- [ ] `git log --oneline` — 7 clean commits, one per task
