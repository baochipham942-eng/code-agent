import { describe, expect, it } from 'vitest';
import { todoEvidenceLabel, todoEvidenceOf } from '../../../src/renderer/utils/todoEvidence';

describe('todoEvidenceOf', () => {
  it('treats a checklist line with no probe as model-claimed', () => {
    expect(todoEvidenceOf(undefined)).toBe('claimed');
    expect(todoEvidenceLabel('claimed')).toBe('模型说的');
  });

  it('uses probe when the step carries evidence refs', () => {
    expect(todoEvidenceOf({ evidenceRefs: ['tool:1'] })).toBe('probe');
    expect(todoEvidenceLabel('probe')).toBe('有记录');
  });

  it('keeps a user correction distinct from a model claim', () => {
    expect(todoEvidenceOf({ evidence: 'user' })).toBe('user');
    expect(todoEvidenceLabel('user')).toBe('你改过');
  });
});
