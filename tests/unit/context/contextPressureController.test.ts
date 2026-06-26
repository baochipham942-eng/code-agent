// P2-full / G11 / G12: ContextPressureController is the single decision point
// for whether context compaction should run. These tests pin the trigger
// priority and the threshold semantics.

import { describe, it, expect } from 'vitest';
import { assessContextPressure } from '../../../src/host/context/contextPressureController';

const BASE = {
  currentTokens: 10_000,
  tokenThresholdHit: false,
  usageRatio: undefined as number | undefined,
  warningThreshold: 0.75,
  pipelineAutocompactNeeded: false,
  compressionEnabled: true,
};

describe('assessContextPressure', () => {
  it('returns none when there is no pressure from any source', () => {
    const d = assessContextPressure({ ...BASE, usageRatio: 0.3 });
    expect(d.action).toBe('none');
    expect(d.trigger).toBe('none');
  });

  it('executes on the pipeline autocompact-needed signal (G12)', () => {
    const d = assessContextPressure({ ...BASE, pipelineAutocompactNeeded: true });
    expect(d.action).toBe('execute');
    expect(d.trigger).toBe('pipeline-signal');
  });

  it('executes on the absolute token threshold', () => {
    const d = assessContextPressure({ ...BASE, tokenThresholdHit: true });
    expect(d.action).toBe('execute');
    expect(d.trigger).toBe('token-threshold');
  });

  it('executes on the usage-percent warning threshold', () => {
    const d = assessContextPressure({ ...BASE, usageRatio: 0.8 });
    expect(d.action).toBe('execute');
    expect(d.trigger).toBe('usage-percent');
  });

  it('does not execute when usage is below the warning threshold', () => {
    const d = assessContextPressure({ ...BASE, usageRatio: 0.74 });
    expect(d.action).toBe('none');
  });

  it('gates the usage-percent trigger behind compressionEnabled', () => {
    const off = assessContextPressure({ ...BASE, usageRatio: 0.9, compressionEnabled: false });
    expect(off.action).toBe('none');
  });

  it('keeps the token threshold firing even when compression is disabled', () => {
    // hard threshold is "must compact" — not gated by the enable flag
    const d = assessContextPressure({ ...BASE, tokenThresholdHit: true, compressionEnabled: false });
    expect(d.action).toBe('execute');
    expect(d.trigger).toBe('token-threshold');
  });

  it('prioritises the pipeline signal over the token threshold', () => {
    const d = assessContextPressure({
      ...BASE,
      pipelineAutocompactNeeded: true,
      tokenThresholdHit: true,
      usageRatio: 0.9,
    });
    expect(d.trigger).toBe('pipeline-signal');
  });

  it('prioritises the token threshold over the usage percent', () => {
    const d = assessContextPressure({ ...BASE, tokenThresholdHit: true, usageRatio: 0.9 });
    expect(d.trigger).toBe('token-threshold');
  });

  it('prefers checkpoint rebuild over pure compaction when a checkpoint is available', () => {
    const d = assessContextPressure({
      ...BASE,
      pipelineAutocompactNeeded: true,
      checkpointRebuildAvailable: true,
      isMainAgent: true,
    });
    expect(d.action).toBe('checkpoint-rebuild');
    expect(d.trigger).toBe('pipeline-signal');
  });

  it('falls back to pure compaction when checkpoint rebuild already ran for the watermark', () => {
    const d = assessContextPressure({
      ...BASE,
      tokenThresholdHit: true,
      checkpointRebuildAvailable: true,
      checkpointRebuildAlreadyInserted: true,
      isMainAgent: true,
    });
    expect(d.action).toBe('execute');
    expect(d.trigger).toBe('token-threshold');
  });

  it('does not choose checkpoint rebuild for subagent runtimes', () => {
    const d = assessContextPressure({
      ...BASE,
      usageRatio: 0.9,
      checkpointRebuildAvailable: true,
      isMainAgent: false,
    });
    expect(d.action).toBe('execute');
    expect(d.trigger).toBe('usage-percent');
  });
});
