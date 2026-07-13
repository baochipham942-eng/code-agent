import path from 'path';
import type { DeclaredDeliverables } from './artifactState';

function resolveWorkspacePath(workingDirectory: string, targetPath: string): string {
  return path.resolve(workingDirectory, targetPath);
}

function isInsideOrEqual(parentDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentDir, candidatePath);
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function hasHiddenSegment(workingDirectory: string, writtenFile: string): boolean {
  const relativePath = path.isAbsolute(writtenFile)
    ? path.relative(workingDirectory, writtenFile)
    : writtenFile;
  return relativePath.split(path.sep).some((segment) =>
    segment.startsWith('.') && segment !== '.' && segment !== '..'
  );
}

export function evaluateWorkspaceHygiene(opts: {
  declared: DeclaredDeliverables;
  writtenFiles: string[];
  workingDirectory: string;
}): { clean: boolean; strayFiles: string[]; checks: string[] } {
  const finalArtifactPaths = new Set(
    opts.declared.finalArtifacts.map((artifactPath) => resolveWorkspacePath(opts.workingDirectory, artifactPath)),
  );
  const scratchDir = opts.declared.scratchDir
    ? resolveWorkspacePath(opts.workingDirectory, opts.declared.scratchDir)
    : undefined;

  const strayFiles = opts.writtenFiles.filter((writtenFile) => {
    const resolvedFile = resolveWorkspacePath(opts.workingDirectory, writtenFile);
    if (finalArtifactPaths.has(resolvedFile)) return false;
    if (scratchDir && isInsideOrEqual(scratchDir, resolvedFile)) return false;
    if (hasHiddenSegment(opts.workingDirectory, writtenFile)) return false;
    return true;
  });

  return {
    clean: strayFiles.length === 0,
    strayFiles,
    checks: [
      `${opts.declared.finalArtifacts.length} final artifacts declared`,
      scratchDir ? `scratch dir: ${opts.declared.scratchDir}` : 'no scratch dir declared',
      `${strayFiles.length} of ${opts.writtenFiles.length} written files stray`,
    ],
  };
}
