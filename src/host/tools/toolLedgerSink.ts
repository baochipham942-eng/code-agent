import type { PermissionDecisionInput } from '../services/core/repositories/PermissionDecisionRepository';
import type { ToolExecutionBeginInput, ToolExecutionCompleteInput } from '../services/core/repositories/ToolExecutionEventRepository';
import { getDatabase } from '../services/core/databaseService';

export interface ToolLedgerSink {
  appendPermissionDecision(input: PermissionDecisionInput): void;
  appendToolExecutionBegin(input: ToolExecutionBeginInput): void;
  appendToolExecutionComplete(input: ToolExecutionCompleteInput): void;
}

const desktopLedgerSink: ToolLedgerSink = {
  appendPermissionDecision: (input) => getDatabase().appendPermissionDecision(input),
  appendToolExecutionBegin: (input) => getDatabase().appendToolExecutionBegin(input),
  appendToolExecutionComplete: (input) => getDatabase().appendToolExecutionComplete(input),
};

let ledgerSink: ToolLedgerSink = desktopLedgerSink;

/** CLI 在自身数据库就绪后注册；桌面默认仍只走核心数据库单例。 */
export function setToolLedgerSink(sink: ToolLedgerSink): void {
  ledgerSink = sink;
}

export function getToolLedgerSink(): ToolLedgerSink {
  return ledgerSink;
}
