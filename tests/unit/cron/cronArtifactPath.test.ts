import { describe, expect, it } from 'vitest';
import { resolveCronArtifactsForReview } from '../../../src/shared/cronArtifactPath';

describe('resolveCronArtifactsForReview', () => {
  it('resolves relative paths against an absolute working directory and caps at ten', () => {
    const many = Array.from({ length: 12 }, (_, index) => `file-${index}.md`);
    const stored = resolveCronArtifactsForReview(
      ['/abs/a.md', 'nested/b.md', '~/nope', '', 3, ...many],
      '/work/run',
    );
    expect(stored).toHaveLength(10);
    expect(stored[0]).toEqual({ path: '/abs/a.md', openable: true });
    expect(stored[1]).toEqual({ path: '/work/run/nested/b.md', openable: true });
    expect(stored[2]).toEqual({ path: '~/nope', openable: false });
    expect(stored[3]).toEqual({ path: '/work/run/file-0.md', openable: true });
  });

  it('keeps relative paths as written when the working directory is missing', () => {
    expect(resolveCronArtifactsForReview(['report.md'], undefined)).toEqual([
      { path: 'report.md', openable: false },
    ]);
    expect(resolveCronArtifactsForReview(['report.md'], 'relative/cwd')).toEqual([
      { path: 'report.md', openable: false },
    ]);
  });
});
