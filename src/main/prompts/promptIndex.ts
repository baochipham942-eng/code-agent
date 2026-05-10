// ============================================================================
// Prompt Index - 强制加载所有接入 registry 的 prompt 模块
// ============================================================================
// 原因：模块只有被 import 时才执行 applyOverride() 注册自己。被 builder 直接
// 引用的会自动加载，其他没人用的 prompt（比如 constitution/* 通过 index 拼装、
// rules/* 大部分按需加载）若不强制 import 就不会出现在 UI 列表里。
//
// 接入新的 prompt 模块就把路径加进来。
// ============================================================================

// Identity 系列
import './identity';

// Base
import './base/gen8';
import './base/orchestrator';

// Constitution
import './constitution/soul';
import './constitution/ethics';
import './constitution/hardConstraints';
import './constitution/judgment';
import './constitution/safety';
import './constitution/values';

// 能力 / 产物
import './artifactGeneration';
import './generativeUI';
import './questionForm';

// Rules
import './rules/attachmentHandling';
import './rules/codeReference';
import './rules/codeSnippet';
import './rules/errorHandling';
import './rules/githubRouting';
import './rules/gitSafety';
import './rules/htmlGeneration';
import './rules/outputFormat';
import './rules/parallelTools';
import './rules/planMode';
import './rules/professionalObjectivity';
import './rules/taskClassification';
import './rules/taskManagement';
import './rules/toolDecisionTree';
import './rules/toolUsagePolicy';

// Tools
import './tools/bash';
import './tools/edit';
import './tools/excel';
import './tools/fileWrite';
import './tools/task';

// Templates
import './templates/soulTemplates';

// Subagent core prompts (in src/main/agent/hybrid/coreAgents.ts)
import '../agent/hybrid/coreAgents';
