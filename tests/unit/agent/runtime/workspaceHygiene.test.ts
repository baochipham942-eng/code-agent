import { describe, expect, it } from 'vitest';
import path from 'path';
import { evaluateWorkspaceHygiene } from '../../../../src/host/agent/runtime/workspaceHygiene';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';

const workingDirectory = '/work';

function declared(
  finalArtifacts: string[],
  scratchDir?: string,
): NonNullable<RuntimeContext['declaredDeliverables']> {
  return {
    finalArtifacts,
    scratchDir,
    declaredAtMs: 1,
  };
}

describe('evaluateWorkspaceHygiene', () => {
  it('treats written files that exactly match declared final artifacts as clean', () => {
    const result = evaluateWorkspaceHygiene({
      declared: declared(['dist/index.html', 'report.md']),
      writtenFiles: ['dist/index.html', 'report.md'],
      workingDirectory,
    });

    expect(result.clean).toBe(true);
    expect(result.strayFiles).toEqual([]);
    expect(result.checks).toContain('0 of 2 written files stray');
  });

  it('does not flag a written file inside scratchDir as stray', () => {
    const result = evaluateWorkspaceHygiene({
      declared: declared(['dist/index.html'], 'draft'),
      writtenFiles: ['draft/notes.md'],
      workingDirectory,
    });

    expect(result.clean).toBe(true);
    expect(result.strayFiles).toEqual([]);
  });

  it('flags a non-hidden file outside final artifacts and scratchDir as stray', () => {
    const result = evaluateWorkspaceHygiene({
      declared: declared(['dist/index.html'], 'draft'),
      writtenFiles: ['dist/index.html', 'extra/platformer.html'],
      workingDirectory,
    });

    expect(result.clean).toBe(false);
    expect(result.strayFiles).toEqual(['extra/platformer.html']);
  });

  it('matches relative and absolute paths for the same logical file', () => {
    const result = evaluateWorkspaceHygiene({
      declared: declared(['dist/index.html']),
      writtenFiles: [path.join(workingDirectory, 'dist/index.html')],
      workingDirectory,
    });

    expect(result.clean).toBe(true);
    expect(result.strayFiles).toEqual([]);
  });

  it('does not flag nested files several levels inside scratchDir', () => {
    const result = evaluateWorkspaceHygiene({
      declared: declared(['dist/index.html'], 'draft'),
      writtenFiles: ['draft/a/b/c/temp.json'],
      workingDirectory,
    });

    expect(result.clean).toBe(true);
    expect(result.strayFiles).toEqual([]);
  });

  it('exempts hidden directory writes even when not declared', () => {
    const result = evaluateWorkspaceHygiene({
      declared: declared(['dist/index.html']),
      writtenFiles: ['.code-agent/session.json'],
      workingDirectory,
    });

    expect(result.clean).toBe(true);
    expect(result.strayFiles).toEqual([]);
  });

  it('does not treat a scratchDir name prefix sibling as inside scratchDir', () => {
    const result = evaluateWorkspaceHygiene({
      declared: declared(['dist/index.html'], '/work/draft'),
      writtenFiles: ['/work/draft-other/x.txt'],
      workingDirectory,
    });

    expect(result.clean).toBe(false);
    expect(result.strayFiles).toEqual(['/work/draft-other/x.txt']);
  });
});
