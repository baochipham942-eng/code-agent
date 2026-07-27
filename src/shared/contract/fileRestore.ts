export interface RestoreWorkspaceFilesAtCheckpointRequest {
  sessionId: string;
  checkpointMessageId: string;
}

export interface RestoreWorkspaceFilesAtCheckpointResult {
  success: true;
  sessionId: string;
  checkpointMessageId: string;
  restoredFileCount: number;
  deletedFileCount: number;
  workspaceChanged: boolean;
  conversationChanged: false;
}

export type WorkspaceFileRestoreErrorCode =
  | 'INVALID_FILE_RESTORE_REQUEST'
  | 'SESSION_ACCESS_DENIED'
  | 'SESSION_RUNNING'
  | 'CHECKPOINT_NOT_FOUND'
  | 'WORKSPACE_FILE_RESTORE_FAILED';

export class WorkspaceFileRestoreError extends Error {
  readonly name = 'WorkspaceFileRestoreError';

  constructor(
    readonly code: WorkspaceFileRestoreErrorCode,
    message: string,
    readonly restoredFileCount = 0,
    readonly deletedFileCount = 0,
    readonly failedFileCount = 0,
  ) {
    super(`${code}: ${message}`);
  }
}
