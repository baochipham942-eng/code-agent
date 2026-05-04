// ============================================================================
// Multi-Agent Tools - 多代理工具
// ============================================================================

// SDK-compatible Task tool — migrated to native; see src/main/tools/modules/multiagent/task.ts

// Legacy explore subagent launcher (registered as protocol tool "Explore")
export { exploreTool } from './explore';

// PascalCase aliases (recommended for new code)
// AgentSpawn / AgentMessageTool / TeammateTool / WorkflowOrchestrateTool —
// migrated to native;
// see src/main/tools/modules/multiagent/{spawnAgent,agentMessage,teammate,workflowOrchestrate}.ts

// Phase 2: Agent lifecycle tools — migrated to native; see src/main/tools/modules/multiagent/{waitAgent,closeAgent}.ts
// Phase 3: Agent communication — migrated to native; see src/main/tools/modules/multiagent/sendInput.ts

// Legacy snake_case exports — all multiagent tools migrated to native; only
// service helpers remain (see Helper exports section below).

// Plan Review — migrated to native; see src/main/tools/modules/multiagent/planReview.ts

// Helper exports
export { getSpawnedAgent, listSpawnedAgents, getAvailableAgents } from './spawnAgent';
export { getAvailableWorkflows } from './workflowOrchestrate';
