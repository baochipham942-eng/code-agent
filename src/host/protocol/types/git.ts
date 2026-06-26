// ============================================================================
// Protocol — Git 相关类型
// 原位置: src/main/services/git/fileWatcherService.ts
// 迁移理由: 纯类型定义，跨 services/desktop/tools 使用；应走 protocol 中介
// ============================================================================

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: number;
}
