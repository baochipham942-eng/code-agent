import { describe, expect, it } from 'vitest';
import {
  buildSummaryRepairInstruction,
  validateCompactionSummary,
  type CompactionSummaryManifest,
} from '../../../src/host/context/compactionSummaryValidator';
import type { CompactionSurvivorManifest } from '../../../src/shared/contract';

describe('validateCompactionSummary', () => {
  const manifest: CompactionSummaryManifest = {
    files: [
      { path: 'src/host/context/autoCompressor.ts' },
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
      'Files covered: src/host/context/autoCompressor.ts and tests/unit/context/autoCompressor.test.ts.',
      'Unresolved error: autoCompressor retry test is still failing.',
      'Open work: wire validator into the retry prompt later.',
    ].join('\n');

    expect(validateCompactionSummary(summary, sharedManifest)).toEqual({
      ok: true,
      emptyOrWhitespace: false,
      truncated: false,
      overBudget: false,
      missingPaths: [],
      missingErrors: [],
      missingOpenWork: [],
      warnings: [],
    });
  });

  it('fails when a required file path is missing', () => {
    const summary = [
      'Files covered: src/host/context/autoCompressor.ts.',
      'Unresolved error: autoCompressor retry test is still failing.',
      'Open work: wire validator into the retry prompt later.',
    ].join('\n');

    const result = validateCompactionSummary(summary, manifest);

    expect(result.ok).toBe(false);
    expect(result.missingPaths).toEqual(['tests/unit/context/autoCompressor.test.ts']);
  });

  it('fails when an unresolved error is missing', () => {
    const summary = [
      'Files covered: src/host/context/autoCompressor.ts and tests/unit/context/autoCompressor.test.ts.',
      'Open work: wire validator into the retry prompt later.',
    ].join('\n');

    const result = validateCompactionSummary(summary, manifest);

    expect(result.ok).toBe(false);
    expect(result.missingErrors).toEqual(['Vitest failure: autoCompressor retry test is still failing']);
  });

  it('fails when open work is missing', () => {
    const summary = [
      'Files covered: src/host/context/autoCompressor.ts and tests/unit/context/autoCompressor.test.ts.',
      'Unresolved error: autoCompressor retry test is still failing.',
    ].join('\n');

    const result = validateCompactionSummary(summary, manifest);

    expect(result.ok).toBe(false);
    expect(result.missingOpenWork).toEqual(['Todo: wire validator into the retry prompt later']);
  });

  it('weakly passes basename coverage when needs re-read is explicit', () => {
    const summary = [
      'Files covered: src/host/context/autoCompressor.ts.',
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

  it('rejects an empty or whitespace-only summary', () => {
    const result = validateCompactionSummary(' \n\t ', { files: [], errors: [], openWork: [] });

    expect(result.ok).toBe(false);
    expect(result.emptyOrWhitespace).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.overBudget).toBe(false);
    expect(result.warnings).toContain('Summary is empty or contains only whitespace.');
  });

  it('rejects a provider-truncated summary', () => {
    const result = validateCompactionSummary(
      'A complete-looking summary.',
      { files: [], errors: [], openWork: [] },
      { truncated: true },
    );

    expect(result.ok).toBe(false);
    expect(result.emptyOrWhitespace).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.overBudget).toBe(false);
    expect(result.warnings).toContain('Summary was truncated by the model provider.');
  });

  it('rejects a summary over the configured token budget', () => {
    const result = validateCompactionSummary(
      'A summary that exceeded its admission budget.',
      { files: [], errors: [], openWork: [] },
      { tokenCount: 201, maxSummaryTokens: 200 },
    );

    expect(result.ok).toBe(false);
    expect(result.emptyOrWhitespace).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.overBudget).toBe(true);
    expect(result.warnings).toContain('Summary exceeds the configured token budget (201 > 200).');
  });
});

describe('buildSummaryRepairInstruction', () => {
  it('includes missing paths, unresolved errors, and open work', () => {
    const instruction = buildSummaryRepairInstruction({
      ok: false,
      emptyOrWhitespace: false,
      truncated: false,
      overBudget: false,
      missingPaths: ['src/host/context/autoCompressor.ts'],
      missingErrors: ['Vitest failure: autoCompressor retry test is still failing'],
      missingOpenWork: ['Todo: wire validator into the retry prompt later'],
      warnings: [],
    });

    expect(instruction).toContain('src/host/context/autoCompressor.ts');
    expect(instruction).toContain('Vitest failure: autoCompressor retry test is still failing');
    expect(instruction).toContain('Todo: wire validator into the retry prompt later');
  });
});
