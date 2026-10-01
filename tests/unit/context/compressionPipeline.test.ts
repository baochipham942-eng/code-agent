// ============================================================================
// CompressionPipeline Tests
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CompressionPipeline,
  getCompressionPipelineOverride,
  setCompressionPipelineOverride,
  type PipelineConfig,
} from '../../../src/host/context/compressionPipeline';
import { CompressionState } from '../../../src/host/context/compressionState';
import { type ProjectableMessage } from '../../../src/host/context/projectionEngine';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';
import { resolveTriggerTokens } from '../../../src/host/context/triggerTokens';
import { resolveToolResultBudget } from '../../../src/host/context/layers/toolResultBudget';

function makeMsg(id: string, role: string, content: string, turnIndex = 0): ProjectableMessage {
  return { id, role, content, turnIndex };
}

/** Generate ~N tokens of English text */
function makeText(targetTokens: number): string {
  return 'word '.repeat(targetTokens);
}

/** One user message whose projected count is at least `target` and as small as the estimator allows. */
function userTranscriptReaching(target: number): {
  transcript: ProjectableMessage[];
  projected: number;
} {
  const projectedFor = (words: number) => 7 + estimateTokens('word '.repeat(words));
  let low = 1;
  let high = Math.max(target, 1);
  while (projectedFor(high) < target) high *= 2;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (projectedFor(mid) >= target) high = mid;
    else low = mid + 1;
  }
  const content = 'word '.repeat(low);
  return {
    transcript: [makeMsg('u1', 'user', content)],
    projected: 3 + 4 + estimateTokens(content),
  };
}

const BASE_CONFIG: PipelineConfig = {
  maxTokens: 10000,
  currentTurnIndex: 20,
  isMainThread: true,
  cacheHot: false,
  idleMinutes: 0,
  enableSnip: true,
  enableMicrocompact: true,
  enableContextCollapse: true,
  toolResultBudget: 2000,
};

describe('CompressionPipeline', () => {
  let pipeline: CompressionPipeline;
  let state: CompressionState;

  beforeEach(() => {
    pipeline = new CompressionPipeline();
    state = new CompressionState();
  });

  // --------------------------------------------------------------------------
  // L1 always runs
  // --------------------------------------------------------------------------
  describe('L1 tool result budget (always runs)', () => {
    it('should always include tool-result-budget in triggered layers', async () => {
      const transcript: ProjectableMessage[] = [
        makeMsg('u1', 'user', 'Hello'),
        makeMsg('a1', 'assistant', 'World'),
      ];

      const result = await pipeline.evaluate(transcript, state, BASE_CONFIG);

      expect(result.layersTriggered).toContain('tool-result-budget');
    });

    it('should truncate large tool result', async () => {
      const bigContent = makeText(3000);
      const transcript: ProjectableMessage[] = [
        makeMsg('u1', 'user', 'Run tool'),
        makeMsg('t1', 'tool', bigContent),
        makeMsg('a1', 'assistant', 'Result consumed'),
      ];

      await pipeline.evaluate(transcript, state, BASE_CONFIG);

      expect(estimateTokens(transcript[1].content)).toBeLessThan(estimateTokens(bigContent));
    });

    it('should not truncate protected tool result', async () => {
      const bigContent = makeText(3000);
      const transcript: ProjectableMessage[] = [
        makeMsg('u1', 'user', 'Run tool'),
        makeMsg('t1', 'tool', bigContent),
      ];

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        interventions: {
          pinned: ['t1'],
          excluded: [],
          retained: [],
        },
      });

      expect(transcript[1].content).toBe(bigContent);
      expect(result.compressionState.getSnapshot().budgetedResults.has('t1')).toBe(false);
    });

    it('should preserve file evidence tool results from automatic tool budgeting', async () => {
      const bigContent = makeText(3000);
      const transcript: ProjectableMessage[] = [
        makeMsg('u1', 'user', 'Read file'),
        { ...makeMsg('t1', 'tool', bigContent), preserveObservation: true },
      ];

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        protectedToolResultPredicate: (message) => message.preserveObservation === true,
      });

      expect(transcript[1].content).toBe(bigContent);
      expect(result.compressionState.getSnapshot().budgetedResults.has('t1')).toBe(false);
    });

    it('derives the L1 budget from the pipeline context window when no override is supplied', async () => {
      const contextWindow = 200_000;
      const derived = resolveToolResultBudget(contextWindow);
      const content = makeText(5_000);
      const transcript: ProjectableMessage[] = [
        makeMsg('u1', 'user', 'Run tool'),
        makeMsg('t1', 'tool', content),
        makeMsg('a1', 'assistant', 'Result consumed'),
      ];

      await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        maxTokens: contextWindow,
        toolResultBudget: undefined,
        activeToolResultPrune: { enabled: false, maxTokensPerResult: derived.l0MaxTokens },
      });

      expect(estimateTokens(transcript[1].content)).toBeLessThanOrEqual(derived.l1MaxTokens + 40);
    });

    it('applies a resultBudgetTokens override to both compression layers', async () => {
      const content = makeText(3_000);
      const transcript: ProjectableMessage[] = [
        { ...makeMsg('t1', 'tool', content), toolName: 'custom', resultBudgetTokens: 700 },
        makeMsg('a1', 'assistant', 'Result consumed'),
      ];

      await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        maxTokens: 200_000,
        toolResultBudget: undefined,
        activeToolResultPrune: { enabled: true, maxTokensPerResult: 6_250 },
      });

      expect(transcript[0].content).toContain('[TOOL_RESULT_ARCHIVED]');
    });
  });

  // --------------------------------------------------------------------------
  // Threshold-based layer triggering
  // --------------------------------------------------------------------------
  describe('threshold-based triggering', () => {
    it('counts image attachments toward compression pressure', async () => {
      const pngHeader = Buffer.alloc(24);
      pngHeader.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      pngHeader.writeUInt32BE(1280, 16);
      pngHeader.writeUInt32BE(720, 20);
      const transcript: ProjectableMessage[] = [{
        ...makeMsg('u-image', 'user', 'image', 0),
        attachments: [{
          id: 'image-1',
          type: 'image',
          category: 'image',
          data: `data:image/png;base64,${pngHeader.toString('base64')}`,
        }],
      }];

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        provider: 'anthropic',
        model: 'claude-sonnet',
        maxTokens: 100_000,
        enableSnip: false,
        enableMicrocompact: false,
        enableContextCollapse: false,
      });

      expect(result.totalTokens).toBeGreaterThanOrEqual(1196);
    });

    it('should not trigger snip when usage is under 50%', async () => {
      // 4000 tokens on 10000 max = 40%
      const transcript: ProjectableMessage[] = [
        makeMsg('u1', 'user', makeText(2000)),
        makeMsg('a1', 'assistant', makeText(2000)),
      ];

      const result = await pipeline.evaluate(transcript, state, BASE_CONFIG);

      expect(result.layersTriggered).not.toContain('snip');
    });

    it('should trigger snip when usage is at or above 50%', async () => {
      // Create a big old assistant message (turnIndex 0) and recent messages
      const oldMsg = { ...makeMsg('a_old', 'assistant', makeText(2500), 0), turnIndex: 0 };
      const recentMsgs = Array.from({ length: 3 }, (_, i) =>
        ({ ...makeMsg(`u${i}`, 'user', makeText(700), 18 + i), turnIndex: 18 + i }),
      );

      const transcript = [oldMsg, ...recentMsgs];

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        maxTokens: 5000,
        enableMicrocompact: false,
        enableContextCollapse: false,
      });

      expect(result.layersTriggered).toContain('snip');
    });

    it('should not trigger snip when enableSnip=false', async () => {
      const transcript: ProjectableMessage[] = Array.from({ length: 20 }, (_, i) =>
        ({ ...makeMsg(`a${i}`, 'assistant', makeText(400), i), turnIndex: i }),
      );

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        maxTokens: 1000, // very small to force high usage
        enableSnip: false,
        enableMicrocompact: false,
        enableContextCollapse: false,
      });

      expect(result.layersTriggered).not.toContain('snip');
    });

    it('should preserve pinned old messages from snip while still snipping unprotected peers', async () => {
      const transcript: ProjectableMessage[] = [
        { ...makeMsg('a-protected', 'assistant', makeText(1200), 1), turnIndex: 1 },
        { ...makeMsg('a-unprotected', 'assistant', makeText(1200), 2), turnIndex: 2 },
        { ...makeMsg('u-recent', 'user', 'recent question', 19), turnIndex: 19 },
      ];

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        maxTokens: 2000,
        enableMicrocompact: false,
        enableContextCollapse: false,
        interventions: {
          pinned: ['a-protected'],
          excluded: [],
          retained: [],
        },
      });

      expect(result.layersTriggered).toContain('snip');
      expect(result.compressionState.getSnapshot().snippedIds.has('a-protected')).toBe(false);
      expect(result.compressionState.getSnapshot().snippedIds.has('a-unprotected')).toBe(true);
      expect(result.apiView.some((message) => message.id === 'a-protected' && message.content.includes('[snipped'))).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // L4: Context collapse
  // --------------------------------------------------------------------------
  describe('context collapse', () => {
    it('marks an explicit skip when the threshold is reached but no summarize fn is provided', async () => {
      // snip/microcompact off so usage stays above the L4 threshold — exercises
      // the no-summarizer branch deterministically (G12: no longer a silent skip).
      const transcript: ProjectableMessage[] = Array.from({ length: 10 }, (_, i) =>
        makeMsg(`t${i}`, 'tool', makeText(400), i),
      );

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        maxTokens: 1000,
        summarize: undefined,
        enableSnip: false,
        enableMicrocompact: false,
      });

      expect(result.layersTriggered).not.toContain('contextCollapse');
      expect(result.layersTriggered).toContain('contextCollapse-skipped-no-summarizer');
    });

    it('should call summarize when contextCollapse triggers', async () => {
      const summarize = vi.fn().mockResolvedValue('Tool results showed successful execution');

      // Build a transcript with enough tool messages to trigger collapse
      const toolMsgs = Array.from({ length: 5 }, (_, i) =>
        ({ ...makeMsg(`t${i}`, 'tool', makeText(600), i), turnIndex: i }),
      );
      const recentMsgs = [{ ...makeMsg('u_recent', 'user', 'hello', 19), turnIndex: 19 }];
      const transcript = [...toolMsgs, ...recentMsgs];

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        maxTokens: 2000, // force high usage
        summarize,
        enableSnip: false,
        enableMicrocompact: false,
      });

      // A3 臂激活断言：此前这里是 expect(summarize).toBeDefined()——对 vi.fn()
      // 恒真的空跑断言（正是 A3 要根治的病）。该 fixture 下触发是确定性的：
      // 5×600 tokens 占用 150% ≥ 75% 阈值；span=5 ≥ 3；节省 2800 > 3×200。
      expect(summarize).toHaveBeenCalled();
      expect(result.layersTriggered).toContain('contextCollapse');
    });

    it('keeps a structured tool call and its output together while collapsing unrelated tool history', async () => {
      const summarize = vi.fn().mockResolvedValue('Older unrelated tool results');
      const pairedCall = {
        ...makeMsg('a_pair', 'assistant', '', 1),
        toolCalls: [{ id: 'call_pair', name: 'Write', arguments: '{}' }],
      };
      const pairedOutput = {
        ...makeMsg('t_pair', 'tool', 'Denied by user', 1),
        toolCallId: 'call_pair',
      };
      const unrelated = Array.from({ length: 3 }, (_, index) => ({
        ...makeMsg(`t_old_${index}`, 'tool', makeText(700), index + 2),
        toolCallId: `old_${index}`,
      }));
      const transcript = [pairedCall, pairedOutput, ...unrelated];

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        maxTokens: 1800,
        summarize,
        enableSnip: false,
        enableMicrocompact: false,
      });

      expect(summarize).toHaveBeenCalledTimes(1);
      expect(result.apiView).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'a_pair', role: 'assistant' }),
        expect.objectContaining({ id: 't_pair', role: 'tool', toolCallId: 'call_pair' }),
      ]));
    });
  });

  // --------------------------------------------------------------------------
  // Return value structure
  // --------------------------------------------------------------------------
  describe('return value', () => {
    it('should return apiView, totalTokens, layersTriggered, compressionState', async () => {
      const transcript: ProjectableMessage[] = [
        makeMsg('u1', 'user', 'Hello'),
        makeMsg('a1', 'assistant', 'Hi'),
      ];

      const result = await pipeline.evaluate(transcript, state, BASE_CONFIG);

      expect(result).toHaveProperty('apiView');
      expect(result).toHaveProperty('totalTokens');
      expect(result).toHaveProperty('layersTriggered');
      expect(result).toHaveProperty('compressionState');
      expect(Array.isArray(result.apiView)).toBe(true);
      expect(typeof result.totalTokens).toBe('number');
      expect(Array.isArray(result.layersTriggered)).toBe(true);
    });

    it('should return totalTokens > 0 for non-empty transcript', async () => {
      const transcript = [makeMsg('u1', 'user', 'Hello world')];
      const result = await pipeline.evaluate(transcript, state, BASE_CONFIG);
      expect(result.totalTokens).toBeGreaterThan(0);
    });

    it('should return the same state instance', async () => {
      const transcript = [makeMsg('u1', 'user', 'hi')];
      const result = await pipeline.evaluate(transcript, state, BASE_CONFIG);
      expect(result.compressionState).toBe(state);
    });

    it('should report autocompact-needed when usage exceeds 85%', async () => {
      // Jam 9000 tokens into 10000 max
      const transcript: ProjectableMessage[] = [
        makeMsg('u1', 'user', makeText(9000)),
      ];

      const result = await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        enableSnip: false,
        enableMicrocompact: false,
        enableContextCollapse: false,
      });

      expect(result.layersTriggered).toContain('autocompact-needed');
    });

    it('reports autocompact-needed from the reserved trigger below the occupancy line', async () => {
      const window = 10_000;
      const maxOutput = 3_000;
      const reserved = resolveTriggerTokens(window, undefined, maxOutput);
      const occupancy = resolveTriggerTokens(window);
      expect(reserved).toBe(5_976);
      expect(occupancy).toBe(8_500);

      const transcript: ProjectableMessage[] = [
        makeMsg('u1', 'user', makeText(6_500)),
      ];
      const quietConfig: PipelineConfig = {
        ...BASE_CONFIG,
        maxTokens: window,
        enableSnip: false,
        enableMicrocompact: false,
        enableContextCollapse: false,
      };
      const reservedResult = await pipeline.evaluate(transcript, state, {
        ...quietConfig,
        autocompactTriggerTokens: reserved,
      });
      expect(reservedResult.totalTokens).toBeGreaterThanOrEqual(reserved);
      expect(reservedResult.totalTokens).toBeLessThan(occupancy);
      expect(reservedResult.layersTriggered).toContain('autocompact-needed');

      const occupancyResult = await pipeline.evaluate(transcript, new CompressionState(), quietConfig);
      expect(occupancyResult.totalTokens).toBe(reservedResult.totalTokens);
      expect(occupancyResult.layersTriggered).not.toContain('autocompact-needed');
    });

    it('fires autocompact-needed at the window ceiling when explicit triggerTokens exceeds it', async () => {
      // Review scenario: a stored 200K trigger on a 128K window. The forced line
      // stays at floor(128_000 × 0.85) = 108_800, not at the unbounded 200_000.
      const window = 128_000;
      const explicit = 200_000;
      const windowCeiling = 108_800;
      const line = resolveTriggerTokens(window, explicit);

      const quietConfig: PipelineConfig = {
        ...BASE_CONFIG,
        maxTokens: window,
        enableSnip: false,
        enableMicrocompact: false,
        enableContextCollapse: false,
      };
      const above = userTranscriptReaching(windowCeiling);
      expect(above.projected).toBeGreaterThanOrEqual(windowCeiling);
      expect(above.projected).toBeLessThan(explicit);

      const fired = await pipeline.evaluate(above.transcript, state, {
        ...quietConfig,
        autocompactTriggerTokens: line,
      });
      expect(fired.totalTokens).toBeGreaterThanOrEqual(windowCeiling);
      expect(fired.totalTokens).toBeLessThan(explicit);
      expect(fired.layersTriggered).toContain('autocompact-needed');
      expect(line).toBe(windowCeiling);

      const below = await pipeline.evaluate(
        [makeMsg('u1', 'user', makeText(1_000))],
        new CompressionState(),
        { ...quietConfig, autocompactTriggerTokens: line },
      );
      expect(below.totalTokens).toBeLessThan(windowCeiling);
      expect(below.layersTriggered).not.toContain('autocompact-needed');
    });
  });

  // --------------------------------------------------------------------------
  // handleOverflow
  // --------------------------------------------------------------------------
  describe('handleOverflow', () => {
    it('should write a drain commit to state', () => {
      pipeline.handleOverflow(state);

      const commits = state.getCommitLog();
      expect(commits).toHaveLength(1);
      expect(commits[0].layer).toBe('overflow-recovery');
      expect(commits[0].operation).toBe('drain');
    });

    it('should append drain commit on each overflow call', () => {
      pipeline.handleOverflow(state);
      pipeline.handleOverflow(state);

      const commits = state.getCommitLog().filter((c) => c.layer === 'overflow-recovery');
      expect(commits).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // No mutation of original transcript
  // --------------------------------------------------------------------------
  describe('transcript immutability', () => {
    it('should not remove messages from the original transcript array', async () => {
      const transcript: ProjectableMessage[] = [
        { ...makeMsg('a_old', 'assistant', makeText(500), 0), turnIndex: 0 },
        { ...makeMsg('u1', 'user', 'recent', 19), turnIndex: 19 },
      ];
      const originalLength = transcript.length;

      await pipeline.evaluate(transcript, state, {
        ...BASE_CONFIG,
        maxTokens: 500,
      });

      expect(transcript).toHaveLength(originalLength);
    });
  });
});

describe('compression pipeline runtime override', () => {
  it('supports set/get/clear', () => {
    setCompressionPipelineOverride(false);
    expect(getCompressionPipelineOverride()).toBe(false);
    setCompressionPipelineOverride(true);
    expect(getCompressionPipelineOverride()).toBe(true);
    setCompressionPipelineOverride(undefined);
    expect(getCompressionPipelineOverride()).toBeUndefined();
  });
});
