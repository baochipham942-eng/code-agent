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
