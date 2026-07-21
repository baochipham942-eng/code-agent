import { describe, expect, it } from 'vitest';
import {
  evaluateWorkBuddyBusinessReadback,
  renderWorkBuddyArtifact,
} from '../../../scripts/acceptance/fixtures/surface-execution-workbuddy';

describe('Surface Execution WorkBuddy acceptance fixture', () => {
  it('generates an intentionally incomplete draft with a visible failure state', () => {
    const html = renderWorkBuddyArtifact('draft');

    expect(html).toContain('data-artifact-stage="draft"');
    expect(html).toContain('Launch status: Needs revision');
    expect(html).toContain('Checklist: 2 / 3 PASS');
    expect(html).toContain('Completion: 67%');
    expect(html).toContain('background: #dc2626');
    expect(html).toContain('id="release-token" type="password"');
  });

  it('generates the repaired final artifact with every required business marker', () => {
    const html = renderWorkBuddyArtifact('final');

    expect(html).toContain('data-artifact-stage="final"');
    expect(html).toContain('Launch status: Ready to ship');
    expect(html).toContain('Checklist: 3 / 3 PASS');
    expect(html).toContain('Completion: 100%');
    expect(html).toContain('Release package: Final artifact saved');
    expect(html).toContain('background: #16a34a');
  });

  it('rejects the draft readback and accepts the repaired readback', () => {
    const draft = evaluateWorkBuddyBusinessReadback([
      'Launch status: Needs revision',
      'Checklist: 2 / 3 PASS',
      'Completion: 67%',
      'Release package: Draft only',
    ].join('\n'));
    const final = evaluateWorkBuddyBusinessReadback([
      'Launch status: Ready to ship',
      'Checklist: 3 / 3 PASS',
      'Completion: 100%',
      'Release package: Final artifact saved',
    ].join('\n'));

    expect(draft.verdict).toBe('fail');
    expect(draft.checks.filter((check) => !check.passed)).toHaveLength(4);
    expect(final).toMatchObject({ verdict: 'pass', findings: [] });
    expect(final.checks.every((check) => check.passed)).toBe(true);
  });
});
