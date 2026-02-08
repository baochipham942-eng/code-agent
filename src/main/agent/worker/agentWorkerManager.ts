// ============================================================================
// Agent Worker Manager - Phase 2 进程隔离（Stub）
// ============================================================================
// 预留接口，实际实现待 Phase 2 开发

export interface AgentWorkerManagerConfig {
  processIsolation: boolean;
  maxWorkers: number;
  workerTimeout: number;
}

export interface WorkerSpawnConfig {
  role: string;
  taskId: string;
  modelConfig: unknown;
  systemPrompt: string;
  task: string;
  allowedTools: string[];
  workingDirectory: string;
  timeout: number;
  maxIterations: number;
}

export interface AgentWorkerManager {
  setToolCallHandler(handler: (workerId: string, tool: string, args: unknown) => Promise<unknown>): void;
  setPermissionHandler(handler: (workerId: string, tool: string, args: unknown) => Promise<boolean>): void;
  spawn(config: WorkerSpawnConfig): Promise<string>;
  on(event: string, listener: (event: unknown) => void): void;
  removeListener(event: string, listener: (event: unknown) => void): void;
  terminateAll(reason: string): Promise<void>;
}

export function getAgentWorkerManager(_config: AgentWorkerManagerConfig): AgentWorkerManager {
  throw new Error('AgentWorkerManager is not yet implemented (Phase 2)');
}
