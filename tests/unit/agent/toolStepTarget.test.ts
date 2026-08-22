import { describe, expect, it } from 'vitest';
import { extractToolStepTarget } from '../../../src/host/agent/toolStepTarget';

describe('extractToolStepTarget', () => {
  it('uses the agreed field priority without inventing a tool-specific table', () => {
    expect(extractToolStepTarget({
      agentId: 'agent-1',
      command: 'npm test',
      notebook_path: '/repo/book.ipynb',
      path: '/repo/fallback.md',
      file_path: '/repo/report.md',
    })).toBe('/repo/report.md');
  });

  it('limits command previews to 80 characters', () => {
    expect(extractToolStepTarget({ command: 'x'.repeat(100) })).toBe('x'.repeat(80));
  });

  it('omits a target when none of the agreed fields has a string value', () => {
    expect(extractToolStepTarget({ query: 'unrelated', path: 42 })).toBeUndefined();
  });
});
