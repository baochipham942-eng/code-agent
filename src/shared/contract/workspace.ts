// ============================================================================
// Workspace Types
// ============================================================================

export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: number;
}

export interface FileChange {
  path: string;
  type: 'created' | 'modified' | 'deleted';
  diff?: string;
  timestamp: number;
}

export interface WorkspaceDirectorySummary {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  git: {
    isRepository: boolean;
    branch: string | null;
    dirtyFiles: number;
    ahead: number;
    behind: number;
  };
  recentSessionCount: number;
}
