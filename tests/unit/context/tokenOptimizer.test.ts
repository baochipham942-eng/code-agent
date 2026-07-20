import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import {
  compressToolResult,
  estimateModelMessageTokens,
} from '../../../src/host/context/tokenOptimizer';
import { TOOL_RESULT_SPILL } from '../../../src/shared/constants';

describe('estimateModelMessageTokens', () => {
  it('keeps pure text message estimates unchanged', () => {
    expect(estimateModelMessageTokens([
      { role: 'user', content: 'Hello, world!' },
    ])).toBe(8);
  });

  it('counts image parts as a fixed image token estimate', () => {
    const tokens = estimateModelMessageTokens([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image' },
          { type: 'image' },
        ],
      },
    ]);

    expect(tokens).toBe(7 + 2 * 765);
  });
});

describe('compressToolResult spill notice preservation (GAP-009)', () => {
  function makeBashSpilledOutput(): string {
    const numbers = Array.from({ length: 5700 }, (_, index) => String(index + 1)).join('\n');
    return (
      '[cwd: /Users/linchen/.claude/worktrees/gap-phase2]\n'
      + numbers
      + '\n\n[Guidance: Output was 108894 chars, truncated to 30000. Use Read tool with offset/limit to read specific sections, or use Edit tool to make targeted changes without reading the entire file.]'
      + `\n${TOOL_RESULT_SPILL.NOTICE_MARKER} /Users/linchen/.code-agent/tmp/gap2-e2e-spill-1/tool-results/Bash-call_c8f816dc0dc448caa456c288.txt — use Read/Grep on this file to inspect the full output.]`
    );
  }

  it('keeps the spill notice line after aggressive compression', () => {
    const result = compressToolResult(makeBashSpilledOutput());

    expect(result.compressed).toBe(true);
    expect(result.content).toContain(TOOL_RESULT_SPILL.NOTICE_MARKER);
    expect(result.content).toContain('Bash-call_c8f816dc0dc448caa456c288.txt');
    expect(result.content.trimEnd().endsWith('the full output.]')).toBe(true);
  });

  it('does not duplicate multiple notice lines', () => {
    const output = makeBashSpilledOutput()
      + `\n${TOOL_RESULT_SPILL.NOTICE_MARKER} /tmp/another.txt — use Read/Grep on this file to inspect the full output.]`;

    const result = compressToolResult(output);
    const occurrences = result.content.split(TOOL_RESULT_SPILL.NOTICE_MARKER).length - 1;
    expect(occurrences).toBe(2);
  });

  it('leaves content without a spill notice unchanged in behavior', () => {
    const numbers = Array.from({ length: 3000 }, (_, index) => String(index + 1)).join('\n');
    const result = compressToolResult(numbers);

    expect(result.compressed).toBe(true);
    expect(result.content).not.toContain(TOOL_RESULT_SPILL.NOTICE_MARKER);
  });
});
