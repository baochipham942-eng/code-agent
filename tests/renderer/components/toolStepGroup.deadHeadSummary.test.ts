import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourcePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/renderer/components/features/chat/ToolStepGroup.tsx',
);

describe('ToolStepGroup dead head-summary helpers', () => {
  it('does not keep buildToolGroupHeadSummary or its helpers as live code', () => {
    const src = readFileSync(sourcePath, 'utf8');
    expect(src).not.toMatch(/\bbuildToolGroupHeadSummary\b/);
    expect(src).not.toMatch(/\bsummarizeSingleFailure\b/);
    expect(src).not.toMatch(/\bsummarizeToolGroupResults\b/);
  });
});
