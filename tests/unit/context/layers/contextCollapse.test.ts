import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompressionState } from '../../../../src/host/context/compressionState';
import { applyContextCollapse } from '../../../../src/host/context/layers/contextCollapse';

function collapsibleMessages() {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `tool-${index + 1}`,
    role: 'tool',
    content: 'large tool output '.repeat(100),
    turnIndex: index,
  }));
}

describe('applyContextCollapse summary admission', () => {
  let state: CompressionState;

  beforeEach(() => {
    state = new CompressionState();
  });

  it('does not commit a whitespace-only summary', async () => {
    const summarize = vi.fn().mockResolvedValue(' \n\t ');

    await applyContextCollapse(collapsibleMessages(), state, {
      minSpanSize: 3,
      maxSummaryTokens: 20,
      summarize,
    });

    expect(summarize).toHaveBeenCalledOnce();
    expect(state.getCommitLog()).toHaveLength(0);
    expect(state.getSnapshot().collapsedSpans).toHaveLength(0);
  });

  it('does not commit a summary over maxSummaryTokens', async () => {
    const summarize = vi.fn().mockResolvedValue('oversized summary '.repeat(20));

    await applyContextCollapse(collapsibleMessages(), state, {
      minSpanSize: 3,
      maxSummaryTokens: 20,
      summarize,
    });

    expect(summarize).toHaveBeenCalledOnce();
    expect(state.getCommitLog()).toHaveLength(0);
    expect(state.getSnapshot().collapsedSpans).toHaveLength(0);
  });
});
