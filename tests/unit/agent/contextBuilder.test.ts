import { describe, expect, it } from 'vitest';
import { injectWorkingDirectoryContext } from '../../../src/main/agent/messageHandling/contextBuilder';

describe('injectWorkingDirectoryContext', () => {
  it('clarifies that cwd is not the boundary for machine-level local tasks', () => {
    const prompt = injectWorkingDirectoryContext('BASE', process.cwd(), true);

    expect(prompt).toContain('Working Directory Boundary');
    expect(prompt).toContain('not as the full boundary of the user');
    expect(prompt).toContain('local disk, caches, downloads');
    expect(prompt).toContain('continue from the already established task scope');
    expect(prompt).toContain('unless the user actually wrote it');
  });
});
