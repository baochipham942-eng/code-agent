// ============================================================================
// L0: Active Tool Result Prune Tests
// ============================================================================
// NOTE on fixtures: L0 only prunes tool results the model has already moved
// past — i.e. results at or before the LAST assistant message in the array.
// A tool result with no later assistant message is the current step's
// freshly-returned result (model hasn't seen it yet) and is protected from
// both L0 archival and L1 lossy truncation. Fixtures below append a trailing
// assistant message wherever pruning is expected to happen.
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

function makeAssistantMsg(id: string, content: string): TestMessage {
  return { id, role: 'assistant', content };
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
      const pruned = applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
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
      const pruned = applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
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
  // Current-step exemption (回修 #1·MED)
  // --------------------------------------------------------------------------
  describe('current-step exemption', () => {
    it('does not prune a tool result with no assistant message after it (current step, model has not seen it yet)', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent);
      // assistant 在前（请求了工具调用），结果紧随其后 —— 模型还没看过这条结果
      const pruned = applyActiveToolResultPrune([makeAssistantMsg('a0', 'calling tool'), msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-current-step',
      });
      expect(pruned).toBe(0);
      expect(msg.content).toBe(bigContent);
      expect(state.getCommitLog()).toHaveLength(0);
    });

    it('exempts everything when the transcript has no assistant message at all (conservative default)', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent);
      const pruned = applyActiveToolResultPrune([msg], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-no-assistant',
      });
      expect(pruned).toBe(0);
      expect(msg.content).toBe(bigContent);
    });

    it('prunes a tool result that a later assistant message has already responded to (past step, consumed)', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent);
      const pruned = applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-past-step',
      });
      expect(pruned).toBe(1);
      expect(msg.content).toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
    });

    it('only exempts results after the LAST assistant message — earlier results in the same array still get pruned', () => {
      const oldBig = makeText(5000);
      const newBig = makeText(5000);
      const oldMsg = makeToolMsg('t-old', oldBig);
      const newMsg = makeToolMsg('t-new', newBig);

      const pruned = applyActiveToolResultPrune(
        [oldMsg, makeAssistantMsg('a-mid', 'first reply'), newMsg],
        state,
        { enabled: true, maxTokensPerResult: 4096, spillSessionId: 'sess-mixed-steps' },
      );

      expect(pruned).toBe(1);
      expect(oldMsg.content).toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
      expect(newMsg.content).toBe(newBig);
    });
  });

  // --------------------------------------------------------------------------
  // Placeholder replacement
  // --------------------------------------------------------------------------
  describe('placeholder replacement', () => {
    it('replaces oversized results with a placeholder that includes archive path and retrieval instructions', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent, 'Bash');

      const pruned = applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
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

    it('includes a 200-code-point preview of the original content', () => {
      const bigContent = 'X'.repeat(50) + makeText(5000);
      const msg = makeToolMsg('t1', bigContent);

      applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-preview',
      });

      expect(msg.content).toContain(bigContent.slice(0, 200));
    });

    it('does not split a surrogate pair (emoji) sitting at the 200-code-point boundary (回修 #3·LOW)', () => {
      const emoji = '😀'; // U+1F600 — 2 UTF-16 code units, 1 code point
      const padding = 'a'.repeat(199);
      const content = padding + emoji + makeText(5000);
      const msg = makeToolMsg('t1', content);

      applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-surrogate',
      });

      // 200 个码点 = 199 个 'a' + 完整的一个 emoji（不是被切开的半个代理对）
      expect(msg.content).toContain(padding + emoji);
      // 不应出现孤立代理项（naive string.slice 从代理对中间切开的乱码信号）
      expect(msg.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });
  });

  // --------------------------------------------------------------------------
  // Protected messages
  // --------------------------------------------------------------------------
  describe('protected messages', () => {
    it('does not prune protected message ids', () => {
      const bigContent = makeText(5000);
      const msg = makeToolMsg('t1', bigContent);

      const pruned = applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
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
      // MAX_SPILL_BYTES 之上的内容会让 spillToolResultArchive 返回 null
      const hugeContent = 'a'.repeat(11 * 1024 * 1024);
      const hugeMsg = makeToolMsg('t2', hugeContent);

      const pruned = applyActiveToolResultPrune([hugeMsg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-fail',
      });

      expect(pruned).toBe(0);
      expect(hugeMsg.content).toBe(hugeContent);
      expect(state.getCommitLog()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Skip already-processed content
  // --------------------------------------------------------------------------
  describe('skip already-processed content', () => {
    it('skips content that already carries a spill notice from an earlier truncation point', () => {
      const alreadySpilled = makeText(5000) + `\n${SPILL_NOTICE_MARKER} /earlier/path.txt — use Read/Grep on this file to inspect the full output.]`;
      const msg = makeToolMsg('t1', alreadySpilled);

      const pruned = applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
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
      const assistant = makeAssistantMsg('a1', 'done');

      applyActiveToolResultPrune([msg, assistant], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-self',
      });
      const placeholder = msg.content;

      // Re-run directly on the already-placeholder'd message (defensive: pipeline
      // never actually does this within one round, but must not double-process).
      const pruned = applyActiveToolResultPrune([msg, assistant], state, {
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

      // Round 1: fresh message objects with full content (simulates pipeline
      // rebuilding transcript from the original store each round)
      const round1Msg = makeToolMsg('t1', bigContent, 'Bash');
      applyActiveToolResultPrune([round1Msg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-determinism',
      });
      const placeholderRound1 = round1Msg.content;

      // Round 2: brand-new message objects, same ids + same full content, same state
      const round2Msg = makeToolMsg('t1', bigContent, 'Bash');
      applyActiveToolResultPrune([round2Msg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-determinism',
      });
      const placeholderRound2 = round2Msg.content;

      expect(placeholderRound2).toBe(placeholderRound1);
    });

    it('only writes one commit across repeated rounds for the same message id', () => {
      const bigContent = makeText(5000);

      applyActiveToolResultPrune([makeToolMsg('t1', bigContent), makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-commit-once',
      });
      applyActiveToolResultPrune([makeToolMsg('t1', bigContent), makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-commit-once',
      });

      const commits = state.getCommitLog().filter((c) => c.layer === 'active-prune');
      expect(commits).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // No redundant spill across rounds (回修 #2·MED)
  // --------------------------------------------------------------------------
  describe('no redundant spill across rounds', () => {
    // vi.spyOn(fs, 'writeFileSync') 在 ESM 下不可用（"Module namespace is not
    // configurable"），改用 mtime 黑盒断言：第二轮如果真的没有重新写盘，
    // 归档文件的 mtime 不会变化。
    it('does not write to disk again on a second round for the same message id, and reuses the existing archiveRef', () => {
      const bigContent = makeText(5000);

      const round1Msg = makeToolMsg('t1', bigContent, 'Bash');
      applyActiveToolResultPrune([round1Msg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-no-respill',
      });
      const archiveMatch = round1Msg.content.match(/archive: (.+)/);
      expect(archiveMatch).not.toBeNull();
      const archivePath = archiveMatch![1].trim();

      // 把 mtime 人为拨早 5 秒，避免文件系统时间戳精度掩盖「是否被重写」的判定
      const backdated = new Date(fs.statSync(archivePath).mtimeMs - 5000);
      fs.utimesSync(archivePath, backdated, backdated);
      const mtimeBeforeRound2 = fs.statSync(archivePath).mtimeMs;

      // Round 2: fresh message object, same id + same full content, same state
      const round2Msg = makeToolMsg('t1', bigContent, 'Bash');
      applyActiveToolResultPrune([round2Msg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-no-respill',
      });

      const mtimeAfterRound2 = fs.statSync(archivePath).mtimeMs;
      expect(mtimeAfterRound2).toBe(mtimeBeforeRound2); // 第二轮没有重新写盘
      expect(round2Msg.content).toBe(round1Msg.content);
    });
  });

  // --------------------------------------------------------------------------
  // Missing-archive fallback (R2-4·LOW)
  // --------------------------------------------------------------------------
  describe('missing-archive fallback', () => {
    it('re-spills when the recorded archiveRef no longer exists on disk (e.g. reaped by a cleanup cron), and reconstructs an identical placeholder', () => {
      const bigContent = makeText(5000);

      const round1Msg = makeToolMsg('t1', bigContent, 'Bash');
      applyActiveToolResultPrune([round1Msg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-missing-archive',
      });
      const placeholderRound1 = round1Msg.content;
      const archiveMatch = placeholderRound1.match(/archive: (.+)/);
      expect(archiveMatch).not.toBeNull();
      const archivePath = archiveMatch![1].trim();
      expect(fs.existsSync(archivePath)).toBe(true);

      // 模拟 session tmp 目录被每周清理 cron 收割：归档文件被删，但 state 里
      // 仍记着这条消息的 archiveRef（budgetedResults 快照不会跟着文件系统变化）。
      fs.rmSync(archivePath);
      expect(fs.existsSync(archivePath)).toBe(false);

      const round2Msg = makeToolMsg('t1', bigContent, 'Bash');
      const pruned = applyActiveToolResultPrune([round2Msg, makeAssistantMsg('a1', 'done')], state, {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-missing-archive',
      });

      // 重新落盘：内容 hash 相同 → 落回同一路径，文件重新存在
      expect(pruned).toBe(1);
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(fs.readFileSync(archivePath, 'utf-8')).toBe(bigContent);
      // 占位符字节和第一轮完全一致（archiveRef 的 bytes/sha256/filePath 都是内容确定性的）
      expect(round2Msg.content).toBe(placeholderRound1);
    });
  });

  // --------------------------------------------------------------------------
  // Commit bookkeeping
  // --------------------------------------------------------------------------
  describe('commit bookkeeping', () => {
    it('writes a commit with layer active-prune and operation truncate', () => {
      const msg = makeToolMsg('t1', makeText(5000));
      applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
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
      applyActiveToolResultPrune([msg, makeAssistantMsg('a1', 'done')], state, {
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
    const transcript: ProjectableMessage[] = [
      makeMsg('a0', 'assistant', 'calling tool'),
      makeMsg('t1', 'tool', bigContent),
      makeMsg('a1', 'assistant', 'done'),
    ];

    const result = await pipeline.evaluate(transcript, state, BASE_CONFIG);

    expect(result.layersTriggered).not.toContain('active-prune');
    // 没配置 L0，落到 L1 有损截断（不是本层的确定性占位符）
    expect(transcript[1].content).not.toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
  });

  it('does not run L0 when enabled=false', async () => {
    const bigContent = makeText(5000);
    const transcript: ProjectableMessage[] = [
      makeMsg('t1', 'tool', bigContent),
      makeMsg('a1', 'assistant', 'done'),
    ];

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

  it('replaces past-step results over the L0 threshold with a placeholder before L1 truncation runs, when enabled', async () => {
    // > 4096 tokens: L0 threshold, would also exceed the L1 2000-token budget.
    // A later assistant message marks it as consumed (past step).
    const bigContent = makeText(5000);
    const transcript: ProjectableMessage[] = [
      makeMsg('t1', 'tool', bigContent),
      makeMsg('a1', 'assistant', 'done'),
    ];

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

  it('preserves a fresh oversized result in full, then archives it after the model consumes it', async () => {
    const bigContent = makeText(5000);
    const transcript: ProjectableMessage[] = [
      makeMsg('a0', 'assistant', 'calling tool'),
      makeMsg('t1', 'tool', bigContent), // most recent — model has not seen this yet
    ];

    const result = await pipeline.evaluate(transcript, state, {
      ...BASE_CONFIG,
      activeToolResultPrune: {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-pipeline-current-step',
      },
    });

    expect(result.layersTriggered).not.toContain('active-prune');
    expect(transcript[1].content).not.toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
    expect(transcript[1].content).toBe(bigContent);
    expect(state.getSnapshot().budgetedResults.has('t1')).toBe(false);

    // Runtime rebuilds the projection from the full transcript on each turn.
    // Once an assistant message follows the result, L0 archives the full body
    // and replaces it with a bounded, recoverable pointer before L1 runs.
    transcript.push(makeMsg('a1', 'assistant', 'result consumed'));
    const consumedResult = await pipeline.evaluate(transcript, state, {
      ...BASE_CONFIG,
      activeToolResultPrune: {
        enabled: true,
        maxTokensPerResult: 4096,
        spillSessionId: 'sess-pipeline-current-step',
      },
    });
    const archiveRef = state.getSnapshot().budgetedResults.get('t1')?.archiveRef;

    expect(consumedResult.layersTriggered).toContain('active-prune');
    expect(transcript[1].content).toContain(ACTIVE_PRUNE_PLACEHOLDER_MARKER);
    expect(archiveRef).toBeDefined();
    expect(transcript[1].content).toContain(archiveRef?.filePath);
    expect(fs.readFileSync(archiveRef!.filePath, 'utf8')).toBe(bigContent);
  });

  it('still truncates a consumed result between the L1 and L0 thresholds', async () => {
    // ~2500 tokens: over L1's 2000-token budget but under L0's 4096 threshold
    const midContent = makeText(2500);
    const transcript: ProjectableMessage[] = [
      makeMsg('t1', 'tool', midContent),
      makeMsg('a1', 'assistant', 'done'),
    ];

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
    const transcript: ProjectableMessage[] = [
      makeMsg('t1', 'tool', bigContent),
      makeMsg('a1', 'assistant', 'done'),
    ];

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
