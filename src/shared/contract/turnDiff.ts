export interface TurnDiffFileChange {
  filePath: string;
  oldText: string;
  newText: string;
  added: number;
  removed: number;
  isNewFile: boolean;
  editCount: number;
}

export interface TurnDiffEventData {
  turnId: string;
  files: TurnDiffFileChange[];
  agentId?: string;
  runId?: string;
  parentToolUseId?: string;
  /** 模型说写了、磁盘上没有、催写次数用尽后的那一次用户可见清单。 */
  missingFiles?: string[];
  /**
   * false：这是缺文件通告，当时没有权威 diff。files 为空不算「确认无净改动」，
   * 卡片仍从工具节点反推已经写成的文件。
   */
  filesAuthoritative?: boolean;
}
