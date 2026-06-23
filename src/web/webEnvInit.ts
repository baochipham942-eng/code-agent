// ============================================================================
// Web 环境初始化 — 必须在所有其他 import 之前加载
// ============================================================================
// secureStorage.ts 在模块加载时检查 CODE_AGENT_CLI_MODE 来决定是否 require('keytar')
// keytar 是 Electron native 模块，在系统 Node.js 下 require 会 SIGSEGV（exit 139）
// 所以必须在 secureStorage 模块初始化之前设置这个环境变量
// ============================================================================

// channelDataDir 只依赖 configPaths（无 keytar 等 native 副作用），安全前置。
import * as os from 'os';
import { resolveChannelDataDir } from './channelDataDir';

process.env.CODE_AGENT_CLI_MODE = 'true';
process.env.CODE_AGENT_WEB_MODE = 'true';

// 测试/开发通道：在任何模块读取数据目录（含 getUserConfigDir 的 module-level const）之前，
// 把 CODE_AGENT_DATA_DIR 切到 ~/.code-agent-dev，确保调试不污染生产包的 ~/.code-agent。
// 打包测试包由 Rust 显式注入 CODE_AGENT_DATA_DIR，此处会因已设置而跳过。
const channelDataDir = resolveChannelDataDir(process.env, os.homedir());
if (channelDataDir) {
  process.env.CODE_AGENT_DATA_DIR = channelDataDir;
}
