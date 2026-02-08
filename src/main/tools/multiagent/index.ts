// ============================================================================
// Multi-Agent Tools - 多代理工具
// ============================================================================

// SDK-compatible Task tool (simplified interface)
export { sdkTaskTool } from './task';

// PascalCase aliases (recommended for new code)
export { agentSpawnTool } from './spawnAgent';
export { AgentMessageTool } from './agentMessage';
export { WorkflowOrchestrateTool } from './workflowOrchestrate';
export { TeammateTool } from './teammate';

// Legacy snake_case exports (backward compatibility)
export { spawnAgentTool } from './spawnAgent';
export { agentMessageTool } from './agentMessage';
export { workflowOrchestrateTool } from './workflowOrchestrate';
export { teammateTool } from './teammate';

// Helper exports
export { getSpawnedAgent, listSpawnedAgents, getAvailableAgents } from './spawnAgent';
export { getAvailableWorkflows } from './workflowOrchestrate';
