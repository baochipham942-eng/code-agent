import { describe, expect, it } from 'vitest';
import {
  createCheckpointTemplate,
  replaceSectionBody,
  validateCheckpointDocument,
} from '../../../src/main/context/checkpoint';

function validDocument(): string {
  let doc = createCheckpointTemplate();
  doc = replaceSectionBody(doc, 1, '> "fix the bug"');
  return doc;
}

describe('validateCheckpointDocument structural fidelity (audit C-M1)', () => {
  it('accepts a template-faithful document', () => {
    const result = validateCheckpointDocument(validDocument());
    expect(result.valid).toBe(true);
    expect(result.tamperedInstructionSections).toEqual([]);
  });

  it('rejects a document whose italic instruction line was rewritten by the LLM', () => {
    const doc = validDocument().replace(
      '_Verbatim current user intent. Must include at least one block quote with exact user words._',
      '_I rewrote this instruction line_',
    );
    const result = validateCheckpointDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.tamperedInstructionSections).toContain(1);
  });

  it('rejects a document missing a section header entirely', () => {
    const doc = validDocument().replace('## §11 Open notes', '## §11 Renamed notes');
    const result = validateCheckpointDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain(11);
  });
});

describe('validateCheckpointDocument §4 task-tree cross-check (audit C-H2/C-M1)', () => {
  const tasks = [
    { id: '1', status: 'completed' },
    { id: '1.1', status: 'in_progress' },
  ];

  it('rejects §4 (none) when the task store has tasks', () => {
    const result = validateCheckpointDocument(validDocument(), { tasks });
    expect(result.valid).toBe(false);
    expect(result.taskTreeViolations.join(' ')).toContain('1.1');
  });

  it('accepts §4 listing every real task id', () => {
    const doc = replaceSectionBody(
      validDocument(),
      4,
      ['✅ 1 implement feature', '  🔄 1.1 write tests'].join('\n'),
    );
    const result = validateCheckpointDocument(doc, { tasks });
    expect(result.valid).toBe(true);
    expect(result.taskTreeViolations).toEqual([]);
  });

  it('rejects §4 containing invented task ids', () => {
    const doc = replaceSectionBody(
      validDocument(),
      4,
      ['✅ 1 implement feature', '  🔄 1.1 write tests', '🔵 7 invented task'].join('\n'),
    );
    const result = validateCheckpointDocument(doc, { tasks });
    expect(result.valid).toBe(false);
    expect(result.taskTreeViolations.join(' ')).toContain('7');
  });

  it('accepts §4 (none) when the task store is empty', () => {
    const result = validateCheckpointDocument(validDocument(), { tasks: [] });
    expect(result.valid).toBe(true);
  });
});
