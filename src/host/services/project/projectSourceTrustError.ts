import type {
  ProjectSourceTrustFailureKind,
  ProjectSourceTrustFailureMarker,
} from '../../../shared/contract/project';

export class ProjectSourceTrustError extends Error {
  readonly code = 'PROJECT_SOURCE_TRUST' as const;

  constructor(
    readonly kind: ProjectSourceTrustFailureKind,
    readonly sourcePath: string,
  ) {
    super(ProjectSourceTrustError.messageFor(kind, sourcePath));
    this.name = 'ProjectSourceTrustError';
  }

  private static messageFor(kind: ProjectSourceTrustFailureKind, sourcePath: string): string {
    switch (kind) {
      case 'source_missing':
        return `Project Source is missing: ${sourcePath}`;
      case 'identity_changed':
        return `Project Source trust identity changed: ${sourcePath}`;
      case 'not_trusted':
        return `Project Source is not trusted: ${sourcePath}`;
    }
  }
}

/** TaskManager 边界序列化用；只认自有 code/kind，不从 message 猜类型。 */
export function getProjectSourceTrustFailureMarker(error: unknown): ProjectSourceTrustFailureMarker | undefined {
  let cursor = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth += 1) {
    const candidate = cursor as { code?: unknown; kind?: unknown; cause?: unknown };
    if (
      candidate.code === 'PROJECT_SOURCE_TRUST'
      && (
        candidate.kind === 'source_missing'
        || candidate.kind === 'identity_changed'
        || candidate.kind === 'not_trusted'
      )
    ) {
      return { code: 'PROJECT_SOURCE_TRUST', kind: candidate.kind };
    }
    cursor = candidate.cause;
  }
  return undefined;
}
