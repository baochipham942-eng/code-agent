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
}
