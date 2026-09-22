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
}
