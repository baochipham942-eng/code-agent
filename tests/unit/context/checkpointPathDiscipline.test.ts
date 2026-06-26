import { describe, expect, it } from 'vitest';
import {
  createCheckpointTemplate,
  replaceSectionBody,
  validateCheckpointDocument,
} from '../../../src/host/context/checkpoint';

const PATH_TABLE = {
  CHECKPOINT_PATH: '/tmp/checkpoints/session/checkpoint.md',
  MEMORY_PATH: '/tmp/checkpoints/MEMORY.md',
  TASK_MEM_DIR: '/tmp/checkpoints/session/tasks',
};

describe('checkpoint path discipline', () => {
  it('rejects absolute paths that are not in the writer path table', () => {
    const checkpoint = replaceSectionBody(
      createCheckpointTemplate(),
      1,
      '> "build checkpoint writer"\n\nRead /Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts',
    );

    const result = validateCheckpointDocument(checkpoint, { pathTable: PATH_TABLE });
    expect(result.valid).toBe(false);
    expect(result.pathViolations).toEqual([
      expect.objectContaining({
        path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts',
      }),
    ]);
  });

  it('allows path-table paths and task progress children', () => {
    const checkpoint = replaceSectionBody(
      createCheckpointTemplate(),
      1,
      [
        '> "build checkpoint writer"',
        `Checkpoint file: ${PATH_TABLE.CHECKPOINT_PATH}`,
        `Memory file: ${PATH_TABLE.MEMORY_PATH}`,
        `${PATH_TABLE.TASK_MEM_DIR}/T1/progress.md`,
      ].join('\n'),
    );

    const result = validateCheckpointDocument(checkpoint, { pathTable: PATH_TABLE });
    expect(result.pathViolations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('does not flag single-segment tokens like regex flags as absolute paths (live-run false positive)', () => {
    const checkpoint = replaceSectionBody(
      createCheckpointTemplate(),
      1,
      '> "fix the regex"\n\n正则带 /m 标志导致多行截断；另一个例子是 /s 标志。',
    );

    const result = validateCheckpointDocument(checkpoint, { pathTable: PATH_TABLE });
    expect(result.pathViolations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('does not reject user exact-form path literals while still rejecting stray paths', () => {
    const exactPath = '`/data/runs/2026-06-09/output.tsv`';
    const checkpoint = replaceSectionBody(
      createCheckpointTemplate(),
      1,
      [
        '> "build checkpoint writer"',
        `Preserve ${exactPath}`,
        'But do not leak /Users/old/session/file.ts',
      ].join('\n'),
    );

    const result = validateCheckpointDocument(checkpoint, {
      requiredExactLiterals: [exactPath],
      pathTable: PATH_TABLE,
    });
    expect(result.pathViolations).toEqual([
      expect.objectContaining({ path: '/Users/old/session/file.ts' }),
    ]);
  });
});

