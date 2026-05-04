// ============================================================================
// Multi-Agent Tools - 多代理工具
// ============================================================================

// SDK-compatible Task tool — migrated to native; see src/main/tools/modules/multiagent/task.ts

// Legacy explore subagent launcher (registered as protocol tool "Explore")
export { exploreTool } from './explore';

// PascalCase aliases (recommended for new code)
// AgentSpawn / AgentMessageTool / TeammateTool — migrated to native;
// see src/main/tools/modules/multiagent/{spawnAgent,agentMessage,teammate}.ts
export { WorkflowOrchestrateTool } from './workflowOrchestrate';

// Phase 2: Agent lifecycle tools — migrated to native; see src/main/tools/modules/multiagent/{waitAgent,closeAgent}.ts
// Phase 3: Agent communication — migrated to native; see src/main/tools/modules/multiagent/sendInput.ts

// Legacy snake_case exports (backward compatibility)
// spawn_agent / agentMessageTool / teammateTool — migrated to native (see above)
export { workflowOrchestrateTool } from './workflowOrchestrate';

// Plan Review — migrated to native; see src/main/tools/modules/multiagent/planReview.ts

// Helper exports
export { getSpawnedAgent, listSpawnedAgents, getAvailableAgents } from './spawnAgent';
export { getAvailableWorkflows } from './workflowOrchestrate';
