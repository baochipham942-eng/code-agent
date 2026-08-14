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
import './base/tools';
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

// Rules —— 空了。原 rules/ 下 16 个规则块全部处理完毕（2026-08-14 L8 规则分流三单）：
// 已覆盖的删、真缺的接回 identity、讲某个工具怎么用的下沉到那个工具的 description、
// 讲产物怎么写的并进 artifactGeneration 的按需注入块。剩下的 rules/injectionDefense.ts
// 不走这里（它由 inputSanitizer 直接消费，是活的）。
// 往这里加新 import 前先想清楚：builder.ts 的 RULE_TIERS 是空数组，登记进来只让规则
// 出现在设置页，不会发给模型——这正是这三单要清理的病。

// Tools
import './tools/bash';
import './tools/edit';
import './tools/excel';
import './tools/fileWrite';
import './tools/task';

// Templates
import './templates/soulTemplates';

// Subagent core prompts (in src/host/agent/hybrid/coreAgents.ts)
import '../agent/hybrid/coreAgents';
