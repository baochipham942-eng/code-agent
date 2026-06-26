// ============================================================================
// 运行通道 → 数据目录解析（测试/开发包与生产包并存的核心）
// ============================================================================
// 生产包用 ~/.code-agent，测试/开发通道用 ~/.code-agent-dev，两套数据（DB、密钥、
// 会话、缓存）物理隔离，互不污染。本模块只负责"决定切不切、切到哪"，是纯函数，
// 由 webEnvInit 在所有其他 import 之前应用到 process.env。
// ============================================================================

import * as path from 'path';
import { CONFIG_DIR_DEV } from '../host/config/configPaths';

/**
 * 决定当前 node 进程是否应把数据目录切到测试/开发通道。
 *
 * - 已显式设置 CODE_AGENT_DATA_DIR（如打包测试包由 Rust 注入）→ 返回 undefined（尊重既有值，不覆盖）
 * - 否则按通道判断：CODE_AGENT_CHANNEL==='dev'，或 NODE_ENV 非 'production'（cargo tauri dev /
 *   npm run dev 下 NODE_ENV 通常缺省）→ 切到 <home>/.code-agent-dev
 * - 生产（NODE_ENV==='production' 且无 dev 通道标记）→ 返回 undefined（沿用 ~/.code-agent）
 *
 * 纯函数，不读取/写入真实环境，便于单测。
 */
export function resolveChannelDataDir(
  env: NodeJS.ProcessEnv,
  homedir: string,
): string | undefined {
  const explicit = env.CODE_AGENT_DATA_DIR?.trim();
  if (explicit) return undefined; // 已显式指定，不覆盖

  const channel = env.CODE_AGENT_CHANNEL?.trim().toLowerCase();
  const isDevChannel = channel === 'dev' || (env.NODE_ENV ?? '').trim() !== 'production';
  if (!isDevChannel) return undefined;

  return path.join(homedir, CONFIG_DIR_DEV);
}
