// ============================================================================
// Cron artifact paths — resolve at record time, render the stored shape.
// Relative paths join the run session's working directory. Anything that
// cannot become an absolute path is kept as written and is not clickable.
// ============================================================================

export interface CronStoredArtifact {
  /** Absolute when openable; otherwise the path as the run wrote it. */
  path: string;
  /** False when record time could not resolve this to an absolute path. */
  openable: boolean;
}

const MAX_STORED_ARTIFACTS = 10;

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(value);
}

function joinUnderCwd(cwd: string, relative: string): string | undefined {
  if (!isAbsolutePath(cwd) || relative.startsWith('~') || relative.includes('\0')) return undefined;
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  const drive = cwd.match(/^[A-Za-z]:/)?.[0];
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  for (const segment of relative.split(/[\\/]/)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      const rootLength = drive ? 1 : 0;
      if (segments.length > rootLength) segments.pop();
      continue;
    }
    if (segment.includes('\0')) return undefined;
    segments.push(segment);
  }
  if (drive) {
    const rest = segments.slice(1).join(sep);
    return rest ? `${drive}${sep}${rest}` : `${drive}${sep}`;
  }
  return `${sep}${segments.join(sep)}`;
}

/** Keep at most ten paths. Non-strings and blanks are dropped. */
export function resolveCronArtifactsForReview(
  artifacts: readonly unknown[],
  cwd: string | undefined,
): CronStoredArtifact[] {
  const stored: CronStoredArtifact[] = [];
  for (const item of artifacts) {
    if (stored.length >= MAX_STORED_ARTIFACTS) break;
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.includes('\0')) continue;
    if (isAbsolutePath(trimmed)) {
      stored.push({ path: trimmed, openable: true });
      continue;
    }
    const resolved = cwd ? joinUnderCwd(cwd, trimmed) : undefined;
    if (resolved && isAbsolutePath(resolved)) {
      stored.push({ path: resolved, openable: true });
    } else {
      stored.push({ path: trimmed, openable: false });
    }
  }
  return stored;
}

export function cronArtifactFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}
