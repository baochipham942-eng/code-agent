// ============================================================================
// Multi-Agent Tools - 多代理工具
// ============================================================================

// SDK-compatible Task tool (simplified interface)
export { sdkTaskTool } from './task';

// Legacy explore subagent launcher (registered as protocol tool "Explore")
export { exploreTool } from './explore';

// PascalCase aliases (recommended for new code)
export { agentSpawnTool } from './spawnAgent';
// AgentMessageTool — migrated to native; see src/main/tools/modules/multiagent/agentMessage.ts
export { WorkflowOrchestrateTool } from './workflowOrchestrate';
export { TeammateTool } from './teammate';

// Phase 2: Agent lifecycle tools — migrated to native; see src/main/tools/modules/multiagent/{waitAgent,closeAgent}.ts
// Phase 3: Agent communication — migrated to native; see src/main/tools/modules/multiagent/sendInput.ts

// Legacy snake_case exports (backward compatibility)
export { spawnAgentTool } from './spawnAgent';
// agentMessageTool — migrated to native (see above)
export { workflowOrchestrateTool } from './workflowOrchestrate';
export { teammateTool } from './teammate';

// Plan Review — migrated to native; see src/main/tools/modules/multiagent/planReview.ts

// Helper exports
export { getSpawnedAgent, listSpawnedAgents, getAvailableAgents } from './spawnAgent';
export { getAvailableWorkflows } from './workflowOrchestrate';
