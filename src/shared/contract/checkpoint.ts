/**
 * 文件检查点记录
 */
export interface FileCheckpoint {
  id: string;
  sessionId: string;
  messageId: string;
  filePath: string;
  sourceId?: string;
  workspaceScopeVersion?: string;
  originalContent: string | null;  // null 表示文件原本不存在
  fileExisted: boolean;
  /** Digest captured after the agent write completed; absent on legacy/incomplete rows. */
  postWriteDigest?: string;
  /** Last checkout/redo operation that consumed this retained checkpoint. */
  restoredFrom?: string;
  createdAt: number;
}

export interface RewindSkippedFile {
  filePath: string;
  reason: 'human_edit' | 'missing_post_write_digest' | 'redo_snapshot_failed' | 'uncertain_write_target' | 'undeclared_tool_write';
  detail: string;
  /** reason 为 undeclared_tool_write 时的工具名（mcp__server__tool 原名，展示层自行美化）。 */
  toolName?: string;
}

/**
 * 回滚操作结果
 */
export interface RewindResult {
  success: boolean;
  restoredFiles: string[];   // 恢复的文件路径
  deletedFiles: string[];    // 删除的文件路径（原本不存在的）
  skippedFiles: RewindSkippedFile[];
  redoCheckpointMessageId?: string;
  errors: Array<{ filePath: string; error: string }>;
}

/**
 * 检查点服务配置
 */
export interface FileCheckpointConfig {
  maxFileSizeBytes: number;        // 默认 1MB
  maxCheckpointsPerSession: number; // 默认 50
  retentionDays: number;            // 默认 7
}
