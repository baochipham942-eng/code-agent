// ============================================================================
// L0: Active Tool Result Prune Tests
// ============================================================================

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  applyActiveToolResultPrune,
  ACTIVE_PRUNE_PLACEHOLDER_MARKER,
} from '../../../../src/host/context/layers/activeToolResultPrune';
import { CompressionState } from '../../../../src/host/context/compressionState';
import { estimateTokens } from '../../../../src/host/context/tokenEstimator';
import { SPILL_NOTICE_MARKER } from '../../../../src/host/utils/toolResultSpill';
import { CompressionPipeline, type PipelineConfig } from '../../../../src/host/context/compressionPipeline';
import type { ProjectableMessage } from '../../../../src/host/context/projectionEngine';

// mock factory 与测试体各自计算同一确定性路径（避免 vi.hoisted 跨作用域引用）
const spillTestRoot = path.join(os.tmpdir(), `neo-active-prune-spill-test-${process.pid}`);

vi.mock('../../../../src/host/config/configPaths', async () => {
  const osMod = await import('os');
  const pathMod = await import('path');
  return {
    getUserConfigDir: () => pathMod.join(osMod.tmpdir(), `neo-active-prune-spill-test-${process.pid}`),
  };
});

type TestMessage = { id: string; role: string; content: string; toolCallId?: string; toolName?: string };

function makeToolMsg(id: string, content: string, toolName?: string): TestMessage {
  return { id, role: 'tool', content, toolName };
}

/** Generate text of approximately `targetTokens` tokens. */
function makeText(targetTokens: number): string {
  return 'word '.repeat(targetTokens);
}

describe('applyActiveToolResultPrune', () => {
  let state: CompressionState;

  beforeEach(() => {
    state = new CompressionState();
  });

  afterAll(() => {
    fs.rmSync(spillTestRoot, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Disabled / under budget
  // --------------------------------------------------------------------------
  describe('gating', () => {
    it('does nothing when disabled', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent);
      const pruned = applyActiveToolResultPrune([msg], state, {
        enabled: false,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-disabled',
      });
      expect(pruned).toBe(0);
      expect(msg.content).toBe(bigContent);
      expect(state.getCommitLog()).toHaveLength(0);
    });

    it('leaves content under the threshold untouched', () => {
      const content = 'short result';
      const msg = makeToolMsg('t1', content);
      const pruned = applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-under',
      });
      expect(pruned).toBe(0);
      expect(msg.content).toBe(content);
      expect(state.getCommitLog()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Placeholder replacement
  // --------------------------------------------------------------------------
  describe('placeholder replacement', () => {
    it('replaces oversized results with a placeholder that includes archive path and retrieval instructions', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent, 'Bash');

      const pruned = applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-1',
      });

      expect(pruned).toBe(1);
      expect(msg.content).toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
      expect(msg.content).toContain('Bash');
      expect(msg.content).toMatch(/archive: .+tool-results/);
      expect(msg.content).toContain('Read');
      expect(msg.content).toContain('Grep');
      expect(estimateTokens(msg.content)).toBeLessThan(estimateTokens(bigContent));

      const archiveMatch = msg.content.match(/archive: (.+)/);
      expect(archiveMatch).not.toBeNull();
      const archivePath = archiveMatch![1].trim();
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(fs.readFileSync(archivePath, 'utf-8')).toBe(bigContent);
    });

    it('includes a 200-char preview of the original content', () => {
      const bigContent = 'X'.repeat(50) + makeText(5000);
      const msg = makeToolMsg('t1', bigContent);

      applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-preview',
      });

      expect(msg.content).toContain(bigContent.slice(0, 200));
    });
  });

  // --------------------------------------------------------------------------
  // Protected messages
  // --------------------------------------------------------------------------
  describe('protected messages', () => {
    it('does not prune protected message ids', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent);

      const pruned = applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        protectedMessageIds: new Set(['t1']),
        spillSessionId: 'sess-protected',
      });

      expect(pruned).toBe(0);
      expect(msg.content).toBe(bigContent);
      expect(state.getCommitLog()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Spill failure — no-loss fallback
  // --------------------------------------------------------------------------
  describe('spill failure fallback', () => {
    it('leaves content unchanged when spill fails', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent);

      // MAX_SPILL_BYTES 之上的内容会让 spillToolResultArchive 返回 null
      const hugeContent = 'a'.repeat(11 * 1024 * 1024);
      const hugeMsg = makeToolMsg('t2', hugeContent);

      const pruned = applyActiveToolResultPrune([hugeMsg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-fail',
      });

      expect(pruned).toBe(0);
      expect(hugeMsg.content).toBe(hugeContent);
      expect(state.getCommitLog()).toHaveLength(0);
      // sanity: 用例本身确实构造了一个超预算内容（避免误判成"本来就没超"）
      expect(estimateTokens(bigContent)).toBeGreaterThan(4096);
      expect(msg.content).toBe(bigContent); // msg 未被此用例处理，保持原样
    });
  });

  // --------------------------------------------------------------------------
  // Skip already-processed content
  // --------------------------------------------------------------------------
  describe('skip already-processed content', () => {
    it('skips content that already carries a spill notice from an earlier truncation point', () => {
      const alreadySpilled = makeText(5000) + `\n${SPILL_NOTICE_MARKER} /earlier/path.txt — use Read/Grep on this file to inspect the full output.]`;
      const msg = makeToolMsg('t1', alreadySpilled);

      const pruned = applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-skip-spilled',
      });

      expect(pruned).toBe(0);
      expect(msg.content).toBe(alreadySpilled);
    });

    it('does not re-process its own placeholder', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent);

      applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-self',
      });
      const placeholder = msg.content;

      // Re-run directly on the already-placeholder'd message (defensive: pipeline
      // never actually does this within one round, but must not double-process).
      const pruned = applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-self',
      });

      expect(pruned).toBe(0);
      expect(msg.content).toBe(placeholder);
    });
  });

  // --------------------------------------------------------------------------
  // Determinism — the whole point (prompt cache prefix stability)
  // --------------------------------------------------------------------------
  describe('determinism across rounds', () => {
    it('produces byte-identical placeholders for the same content across two fresh-copy rounds', () => {
      const bigContent = makeText(5000);

      // Round 1: fresh message object with full content (simulates pipeline
      // rebuilding transcript from the original store each round)
      const round1Msg = makeToolMsg('t1', bigContent, 'Bash');
      applyActiveToolResultPrune([round1Msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-determinism',
      });
      const placeholderRound1 = round1Msg.content;

      // Round 2: brand-new message object, same id + same full content, same state
      const round2Msg = makeToolMsg('t1', bigContent, 'Bash');
      applyActiveToolResultPrune([round2Msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-determinism',
      });
      const placeholderRound2 = round2Msg.content;

      expect(placeholderRound2).toBe(placeholderRound1);
    });

    it('only writes one commit across repeated rounds for the same message id', () => {
      const bigContent = makeText(5000);

      applyActiveToolResultPrune([makeToolMsg('t1', bigContent)], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-commit-once',
      });
      applyActiveToolResultPrune([makeToolMsg('t1', bigContent)], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-commit-once',
      });

      const commits = state.getCommitLog().filter((c) => c.layer === 'active-prune');
      expect(commits).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Commit bookkeeping
  // --------------------------------------------------------------------------
  describe('commit bookkeeping', () => {
    it('writes a commit with layer active-prune and operation truncate', () => {
      const msg = makeToolMsg('t1', makeText(5000));
      applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-commit-shape',
      });

      const commits = state.getCommitLog();
      expect(commits).toHaveLength(1);
      expect(commits[0].layer).toBe('active-prune');
      expect(commits[0].operation).toBe('truncate');
      expect(commits[0].targetMessageIds).toEqual(['t1']);
      expect(commits[0].metadata?.archiveRef).toBeDefined();
      expect(typeof commits[0].metadata?.originalTokens).toBe('number');
      expect(typeof commits[0].metadata?.placeholderTokens).toBe('number');
    });

    it('records the pruned message in the shared budgetedResults snapshot', () => {
      const msg = makeToolMsg('t1', makeText(5000));
      applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-snapshot',
      });

      expect(state.getSnapshot().budgetedResults.has('t1')).toBe(true);
    });
  });
});

// ============================================================================
// Pipeline integration
// ============================================================================
describe('CompressionPipeline integration with activeToolResultPrune', () => {
  function makeMsg(id: string, role: string, content: string): ProjectableMessage {
    return { id, role, content };
  }

  const BASE_CONFIG: PipelineConfig = {
    maxTokens: 100_000, // large enough that L2/L3/L4 thresholds never trigger
    currentTurnIndex: 0,
    isMainThread: true,
    cacheHot: false,
    idleMinutes: 0,
    enableSnip: false,
    enableMicrocompact: false,
    enableContextCollapse: false,
    toolResultBudget: 2000,
  };

  let pipeline: CompressionPipeline;
  let state: CompressionState;

  beforeEach(() => {
    pipeline = new CompressionPipeline();
    state = new CompressionState();
  });

  afterAll(() => {
    fs.rmSync(spillTestRoot, { recursive: true, force: true });
  });

  it('does not run L0 when activeToolResultPrune is not configured', async () => {
    const bigContent = makeText(5000);
    const transcript: ProjectableMessage[] = [makeMsg('t1', 'tool', bigContent)];

    const result = await pipeline.evaluate(transcript, state, BASE_CONFIG);

    expect(result.layersTriggered).not.toContain('active-prune');
    // 没配置 L0，落到 L1 有损截断（不是本层的确定性占位符）
    expect(transcript[0].content).not.toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
  });

  it('does not run L0 when enabled=false', async () => {
    const bigContent = makeText(5000);
    const transcript: ProjectableMessage[] = [makeMsg('t1', 'tool', bigContent)];

    const result = await pipeline.evaluate(transcript, state, {
      ...BASE_CONFIG,
      activeToolResultPrune: {
        enabled: false,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-pipeline-disabled',
      },
    });

    expect(result.layersTriggered).not.toContain('active-prune');
    expect(transcript[0].content).not.toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
  });

  it('replaces results over the L0 threshold with a placeholder before L1 truncation runs, when enabled', async () => {
    // > 4096 tokens: L0 threshold, would also exceed the L1 2000-token budget
    const bigContent = makeText(5000);
    const transcript: ProjectableMessage[] = [makeMsg('t1', 'tool', bigContent)];

    const result = await pipeline.evaluate(transcript, state, {
      ...BASE_CONFIG,
      activeToolResultPrune: {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-pipeline-enabled',
      },
    });

    expect(result.layersTriggered).toContain('active-prune');
    expect(result.layersTriggered).toContain('tool-result-budget');
    // Final content is the L0 placeholder, not L1's "...[truncated]..." head+tail form
    expect(transcript[0].content).toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
    expect(transcript[0].content).not.toContain('...[truncated]...');
  });

  it('leaves results between the L1 and L0 thresholds to L1 lossy truncation', async () => {
    // ~2500 tokens: over L1's 2000-token budget but under L0's 4096 threshold
    const midContent = makeText(2500);
    const transcript: ProjectableMessage[] = [makeMsg('t1', 'tool', midContent)];

    const result = await pipeline.evaluate(transcript, state, {
      ...BASE_CONFIG,
      activeToolResultPrune: {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-pipeline-mid',
      },
    });

    expect(result.layersTriggered).not.toContain('active-prune');
    expect(transcript[0].content).not.toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
    expect(transcript[0].content).toContain('...[truncated]...');
  });

  it('respects protected message ids collected from interventions', async () => {
    const bigContent = makeText(5000);
    const transcript: ProjectableMessage[] = [makeMsg('t1', 'tool', bigContent)];

    const result = await pipeline.evaluate(transcript, state, {
      ...BASE_CONFIG,
      activeToolResultPrune: {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-pipeline-protected',
      },
      interventions: { pinned: ['t1'], excluded: [], retained: [] },
    });

    expect(result.layersTriggered).not.toContain('active-prune');
    expect(transcript[0].content).toBe(bigContent);
  });
});
