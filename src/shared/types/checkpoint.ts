/**
 * 文件检查点记录
 */
export interface FileCheckpoint {
  id: string;
  sessionId: string;
  messageId: string;
  filePath: string;
  originalContent: string | null;  // null 表示文件原本不存在
  fileExisted: boolean;
  createdAt: number;
}

/**
 * 回滚操作结果
 */
export interface RewindResult {
  success: boolean;
  restoredFiles: string[];   // 恢复的文件路径
  deletedFiles: string[];    // 删除的文件路径（原本不存在的）
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
