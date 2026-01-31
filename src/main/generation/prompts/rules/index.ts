// ============================================================================
// Rules Index - 导出所有规则模块
// ============================================================================

// Claude Code v2.0 借鉴的规则
export { PROFESSIONAL_OBJECTIVITY_RULES } from './professionalObjectivity';
export { GIT_SAFETY_RULES } from './gitSafety';
export { PARALLEL_TOOLS_RULES } from './parallelTools';
export { CODE_REFERENCE_RULES } from './codeReference';
export { PLAN_MODE_RULES } from './planMode';
export { INJECTION_DEFENSE_RULES } from './injectionDefense';

// 原有规则（从 GenerationManager 提取）
export { OUTPUT_FORMAT_RULES } from './outputFormat';
export { HTML_GENERATION_RULES } from './htmlGeneration';

// MCP 智能路由规则
export { GITHUB_ROUTING_RULES } from './githubRouting';

// 错误处理和代码片段规则
export { ERROR_HANDLING_RULES } from './errorHandling';
export { CODE_SNIPPET_RULES } from './codeSnippet';

// 附件处理规则
export { ATTACHMENT_HANDLING_RULES } from './attachmentHandling';

// 工具使用策略（强制规则）
export { TOOL_USAGE_POLICY } from './toolUsagePolicy';
