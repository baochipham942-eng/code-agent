// ============================================================================
// Web 环境初始化 — 必须在所有其他 import 之前加载
// ============================================================================
// secureStorage.ts 在模块加载时检查 CODE_AGENT_CLI_MODE 来决定是否 require('keytar')
// keytar 是 Electron native 模块，在系统 Node.js 下 require 会 SIGSEGV（exit 139）
// 所以必须在 secureStorage 模块初始化之前设置这个环境变量
// ============================================================================

process.env.CODE_AGENT_CLI_MODE = 'true';
process.env.CODE_AGENT_WEB_MODE = 'true';
