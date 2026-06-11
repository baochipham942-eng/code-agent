import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_SECTIONS,
  createCheckpointTemplate,
  getSectionBody,
  replaceSectionBody,
  validateCheckpointDocument,
} from '../../../src/main/context/checkpoint';

describe('checkpoint templates', () => {
  it('renders all 11 required checkpoint sections', () => {
    const template = createCheckpointTemplate();
    expect(CHECKPOINT_SECTIONS).toHaveLength(11);
    for (const section of CHECKPOINT_SECTIONS) {
      expect(template).toContain(section.heading);
      expect(template).toContain(section.instruction);
      expect(getSectionBody(template, section.number)).toBe('(none)');
    }
  });

  it('updates only the requested section body', () => {
    const template = createCheckpointTemplate();
    const updated = replaceSectionBody(template, 1, '> "implement checkpoint rebuild"');
    expect(getSectionBody(updated, 1)).toBe('> "implement checkpoint rebuild"');
    expect(getSectionBody(updated, 2)).toBe('(none)');
  });

  it('requires a verbatim block quote in active intent', () => {
    const template = createCheckpointTemplate();
    expect(validateCheckpointDocument(template).activeIntentHasVerbatimQuote).toBe(false);

    const updated = replaceSectionBody(template, 1, '> "build checkpoint writer"');
    expect(validateCheckpointDocument(updated).activeIntentHasVerbatimQuote).toBe(true);
  });
});

