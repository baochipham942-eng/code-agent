import { describe, expect, it } from 'vitest';

import { isSameGitCommit } from '../../scripts/scenario/harness.mjs';

describe('scenario harness commit identity', () => {
  const fullCommit = '5a62db1cc35f4f014da13d89b692649f4a27c8e3';

  it('matches a full build commit to the local HEAD', () => {
    expect(isSameGitCommit(fullCommit, fullCommit)).toBe(true);
  });

  it('matches stable and repository-configured abbreviations to the full commit', () => {
    expect(isSameGitCommit('5a62db1', fullCommit)).toBe(true);
    expect(isSameGitCommit('5a62db1cc', fullCommit)).toBe(true);
  });

  it('rejects different and malformed commit identities', () => {
    expect(isSameGitCommit('5a62db2', fullCommit)).toBe(false);
    expect(isSameGitCommit('5a62db', fullCommit)).toBe(false);
    expect(isSameGitCommit('', fullCommit)).toBe(false);
  });
});
