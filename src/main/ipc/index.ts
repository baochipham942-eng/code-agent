// ============================================================================
// IPC Module - IPC 处理器统一导出
// ============================================================================
//
// 目录结构规划（后续拆分用）:
// - agent.ipc.ts      # agent:* 通道
// - session.ipc.ts    # session:* 通道
// - generation.ipc.ts # generation:* 通道
// - auth.ipc.ts       # auth:* 通道
// - sync.ipc.ts       # sync:* 通道
// - cloud.ipc.ts      # cloud:* 通道
// - workspace.ipc.ts  # workspace:* 通道
// - settings.ipc.ts   # settings:* 通道
// - update.ipc.ts     # update:* 通道
// - mcp.ipc.ts        # mcp:* 通道
//
// 当前阶段: IPC handlers 仍在 main/index.ts 中
// 后续可逐步迁移到各领域文件

export * from './types';

// TODO: 后续拆分时导出各领域模块
// export { registerAgentHandlers } from './agent.ipc';
// export { registerSessionHandlers } from './session.ipc';
// export { registerGenerationHandlers } from './generation.ipc';
// export { registerAuthHandlers } from './auth.ipc';
// export { registerSyncHandlers } from './sync.ipc';
// export { registerCloudHandlers } from './cloud.ipc';
// export { registerWorkspaceHandlers } from './workspace.ipc';
// export { registerSettingsHandlers } from './settings.ipc';
// export { registerUpdateHandlers } from './update.ipc';
// export { registerMcpHandlers } from './mcp.ipc';
