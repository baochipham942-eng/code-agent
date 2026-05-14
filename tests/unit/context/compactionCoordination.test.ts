// ============================================================================
// Compaction entry-point coordination — G11/G22 baseline
// ============================================================================
// code-agent has two independent compression entry points:
//   - CompressionPipeline      (messageBuild.ts, during inference assembly)
//   - AutoContextCompressor    (contextAssembly/compression.ts)
// They share no state and don't read each other's signals. This test pins that
// current reality: under the same high-pressure transcript, both independently
// detect pressure. It is the regression baseline for a future unification
// (ContextPressureController, P2-full) — when that lands, this test should be
// updated to assert a single coordinated decision instead.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { CompressionPipeline, type PipelineConfig } from '../../../src/main/context/compressionPipeline';
import { CompressionState } from '../../../src/main/context/compressionState';
import { AutoContextCompressor } from '../../../src/main/context/autoCompressor';
import { type ProjectableMessage } from '../../../src/main/context/projectionEngine';
import { estimateTokens } from '../../../src/main/context/tokenEstimator';

function makeMsg(id: string, role: string, content: string, turnIndex = 0): ProjectableMessage {
  return { id, role, content, turnIndex };
}

function makeText(targetTokens: number): string {
  return 'word '.repeat(targetTokens);
}

describe('compaction entry-point coordination (G11 baseline)', () => {
  it('CompressionPipeline and AutoContextCompressor independently detect the same pressure', async () => {
    const transcript: ProjectableMessage[] = Array.from({ length: 12 }, (_, i) =>
      makeMsg(`t${i}`, 'tool', makeText(500), i),
    );
    const totalTokens = transcript.reduce(
      (sum, m) => sum + estimateTokens(String(m.content)),
      0,
    );

    // Path A — CompressionPipeline: snip/microcompact/collapse off + a small
    // maxTokens forces final usage past the L5 autocompact threshold (85%).
    const pipeline = new CompressionPipeline();
    const config: PipelineConfig = {
      maxTokens: 1000,
      currentTurnIndex: 20,
      isMainThread: true,
      cacheHot: false,
      idleMinutes: 0,
      enableSnip: false,
      enableMicrocompact: false,
      enableContextCollapse: false,
      toolResultBudget: 100000, // don't let L1 truncate, keep usage high
    };
    const pipelineResult = await pipeline.evaluate(transcript, new CompressionState(), config);
    expect(pipelineResult.layersTriggered).toContain('autocompact-needed');

    // Path B — AutoContextCompressor: triggerTokens well below the transcript size.
    const autoCompressor = new AutoContextCompressor({ triggerTokens: 100 });
    expect(autoCompressor.shouldTriggerByTokens(totalTokens)).toBe(true);

    // Both fired on the same input via separate code paths with no shared state
    // or handoff between them — this is G11. P2-min only contractualises the
    // pipeline's reporting (see compressionPipeline.test.ts); unifying the two
    // entry points is deferred to P2-full.
    expect(totalTokens).toBeGreaterThan(100);
  });
});
