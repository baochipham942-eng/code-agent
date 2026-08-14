// ============================================================================
// Prompt Index - 强制加载所有接入 registry 的 prompt 模块
// ============================================================================
// 原因：模块只有被 import 时才执行 applyOverride() 注册自己。被 builder 直接
// 引用的会自动加载；只在别处按需拼接的模块要在这里显式 import，否则不会出现在
// 提示词管理器（设置页）里。
//
// ⚠️ 只登记「真的会被某条产品路径下发给模型」的模块。提示词管理器给用户的承诺是
// 「下一轮对话立即生效」——登记一个不下发的模块 = 用户改了没效果的欺骗性 UI。
// 这条由 tests/unit/prompts/promptRegistryReachability.test.ts 守着：每个注册 id
// 都要能在真实拼出来的提示词里找到，找不到就报红。
//
// 历史（2026-08-14 L8 规则分流三单 + N-L8-GHOSTRULES）：
// - rules/ 下 16 个块：已覆盖的删、真缺的接回 identity、讲工具怎么用的下沉到该工具的
//   description、讲产物怎么写的并进 artifactGeneration 的按需注入块，目录已整体删除。
// - constitution/ 6 块 + base/orchestrator.ts 6 块：从来没有任何调用者，只在设置页
//   露脸。人格类归 templates/soulTemplates.ts 与用户 SOUL.md，安全红线与
//   「确认由权限层负责」两条真缺的搬进 identity，其余删除。
// ============================================================================

// Identity 系列
import './identity';

// Base
import './base/tools';

// 能力 / 产物
import './artifactGeneration';
import './generativeUI';
import './questionForm';

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
