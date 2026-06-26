import type { AgentTaskPhase, Message } from '../../../shared/contract';

export interface TaskProgressPort {
  emitTaskProgress(
    phase: AgentTaskPhase,
    step?: string,
    extra?: { progress?: number; tool?: string; toolIndex?: number; toolTotal?: number; parallel?: boolean },
  ): void;
}

export interface MessageWriterPort {
  generateId(): string;
  addAndPersistMessage(message: Message): Promise<void>;
}
