import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_SECTIONS,
  createCheckpointTemplate,
  getSectionBody,
  replaceSectionBody,
  validateCheckpointDocument,
} from '../../../src/host/context/checkpoint';

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

  it('round-trips multi-line section bodies without truncation (latent bug found via C-M1)', () => {
    const template = createCheckpointTemplate();
    const multiline = ['✅ 1 implement feature', '  🔄 1.1 write tests', '🔵 2 follow-up'].join('\n');
    const updated = replaceSectionBody(template, 4, multiline);
    expect(getSectionBody(updated, 4)).toBe(multiline);
    expect(getSectionBody(updated, 5)).toBe('(none)');
    // 再替换一次也必须替换整个多行 body，不能只换首行
    const replaced = replaceSectionBody(updated, 4, '(none)');
    expect(getSectionBody(replaced, 4)).toBe('(none)');
    expect(replaced).not.toContain('1.1 write tests');
  });

  it('requires a verbatim block quote in active intent', () => {
    const template = createCheckpointTemplate();
    expect(validateCheckpointDocument(template).activeIntentHasVerbatimQuote).toBe(false);

    const updated = replaceSectionBody(template, 1, '> "build checkpoint writer"');
    expect(validateCheckpointDocument(updated).activeIntentHasVerbatimQuote).toBe(true);
  });
});

