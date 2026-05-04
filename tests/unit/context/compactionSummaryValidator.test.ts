import { describe, expect, it } from 'vitest';
import {
  buildSummaryRepairInstruction,
  validateCompactionSummary,
  type CompactionSummaryManifest,
} from '../../../src/main/context/compactionSummaryValidator';
import type { CompactionSurvivorManifest } from '../../../src/shared/contract';

describe('validateCompactionSummary', () => {
  const manifest: CompactionSummaryManifest = {
    files: [
      { path: 'src/main/context/autoCompressor.ts' },
      { path: 'tests/unit/context/autoCompressor.test.ts' },
    ],
    errors: [
      { label: 'Vitest failure', detail: 'autoCompressor retry test is still failing' },
    ],
    openWork: [
      { label: 'Todo', detail: 'wire validator into the retry prompt later' },
    ],
  };

  it('passes when all survivor manifest items are covered', () => {
    const sharedManifest: CompactionSurvivorManifest = manifest;
    const summary = [
      'Files covered: src/main/context/autoCompressor.ts and tests/unit/context/autoCompressor.test.ts.',
      'Unresolved error: autoCompressor retry test is still failing.',
      'Open work: wire validator into the retry prompt later.',
    ].join('\n');

    expect(validateCompactionSummary(summary, sharedManifest)).toEqual({
      ok: true,
      missingPaths: [],
      missingErrors: [],
      missingOpenWork: [],
      warnings: [],
    });
  });

  it('fails when a required file path is missing', () => {
    const summary = [
      'Files covered: src/main/context/autoCompressor.ts.',
      'Unresolved error: autoCompressor retry test is still failing.',
      'Open work: wire validator into the retry prompt later.',
    ].join('\n');

    const result = validateCompactionSummary(summary, manifest);

    expect(result.ok).toBe(false);
    expect(result.missingPaths).toEqual(['tests/unit/context/autoCompressor.test.ts']);
  });

  it('fails when an unresolved error is missing', () => {
    const summary = [
      'Files covered: src/main/context/autoCompressor.ts and tests/unit/context/autoCompressor.test.ts.',
      'Open work: wire validator into the retry prompt later.',
    ].join('\n');

    const result = validateCompactionSummary(summary, manifest);

    expect(result.ok).toBe(false);
    expect(result.missingErrors).toEqual(['Vitest failure: autoCompressor retry test is still failing']);
  });

  it('fails when open work is missing', () => {
    const summary = [
      'Files covered: src/main/context/autoCompressor.ts and tests/unit/context/autoCompressor.test.ts.',
      'Unresolved error: autoCompressor retry test is still failing.',
    ].join('\n');

    const result = validateCompactionSummary(summary, manifest);

    expect(result.ok).toBe(false);
    expect(result.missingOpenWork).toEqual(['Todo: wire validator into the retry prompt later']);
  });

  it('weakly passes basename coverage when needs re-read is explicit', () => {
    const summary = [
      'Files covered: src/main/context/autoCompressor.ts.',
      'autoCompressor.test.ts needs re-read before continuing because the full path was compacted away.',
      'Unresolved error: autoCompressor retry test is still failing.',
      'Open work: wire validator into the retry prompt later.',
    ].join('\n');

    const result = validateCompactionSummary(summary, manifest);

    expect(result.ok).toBe(true);
    expect(result.missingPaths).toEqual([]);
    expect(result.warnings).toEqual([
      'Path tests/unit/context/autoCompressor.test.ts was covered only by basename with needs re-read instruction.',
    ]);
  });
});

describe('buildSummaryRepairInstruction', () => {
  it('includes missing paths, unresolved errors, and open work', () => {
    const instruction = buildSummaryRepairInstruction({
      ok: false,
      missingPaths: ['src/main/context/autoCompressor.ts'],
      missingErrors: ['Vitest failure: autoCompressor retry test is still failing'],
      missingOpenWork: ['Todo: wire validator into the retry prompt later'],
      warnings: [],
    });

    expect(instruction).toContain('src/main/context/autoCompressor.ts');
    expect(instruction).toContain('Vitest failure: autoCompressor retry test is still failing');
    expect(instruction).toContain('Todo: wire validator into the retry prompt later');
  });
});
