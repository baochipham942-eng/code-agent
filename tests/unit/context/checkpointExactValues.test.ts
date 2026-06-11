import { describe, expect, it } from 'vitest';
import {
  collectExactFormLiterals,
  createCheckpointTemplate,
  replaceSectionBody,
  validateCheckpointDocument,
} from '../../../src/main/context/checkpoint';

describe('checkpoint exact-form preservation', () => {
  it('collects exact values that must survive byte-for-byte', () => {
    const userText = [
      'Use `MC_DB_DSN=postgres://mc_ro@host:5433/exp_2026`',
      'then run `npm run smoke -- --seed 2718281 --shard 1/3`',
      'write to `/data/runs/2026-06-09/output.tsv`',
      'and keep HF_TOKEN=hf_abc123456789.',
    ].join(' ');

    const literals = collectExactFormLiterals(userText).map((item) => item.literal);
    expect(literals).toContain('`MC_DB_DSN=postgres://mc_ro@host:5433/exp_2026`');
    expect(literals).toContain('`npm run smoke -- --seed 2718281 --shard 1/3`');
    expect(literals).toContain('`/data/runs/2026-06-09/output.tsv`');
    expect(literals).toContain('HF_TOKEN=hf_abc123456789.');
  });

  it('fails when one byte of an exact value is rewritten', () => {
    const exact = '`MC_DB_DSN=postgres://mc_ro@host:5433/exp_2026`';
    const checkpoint = replaceSectionBody(
      createCheckpointTemplate(),
      1,
      '> "implement checkpoint rebuild"\n\n`MC_DB_DSN=postgres://mc_ro@host:5432/exp_2026`',
    );

    const result = validateCheckpointDocument(checkpoint, {
      requiredExactLiterals: [exact],
    });

    expect(result.valid).toBe(false);
    expect(result.missingExactLiterals).toEqual([exact]);
  });
});

