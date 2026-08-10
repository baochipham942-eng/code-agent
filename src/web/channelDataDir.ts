// ============================================================================
// 运行通道 → 数据目录解析（测试/开发包与生产包并存的核心）
// ============================================================================
// 生产包用 ~/.code-agent，测试/开发通道用 ~/.code-agent-dev，两套数据（DB、密钥、
// 会话、缓存）物理隔离，互不污染。本模块只负责"决定切不切、切到哪"，是纯函数，
// 由 webEnvInit 在所有其他 import 之前应用到 process.env。
// ============================================================================

import * as fs from 'fs';
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

/**
 * 把数据目录展开为真实长路径。Windows 8.3 短名（RUNNER~1、长用户名机器的
 * TEMP/AppData）会让 webServer 内 fs.watch 的 libuv 断言直接 abort 进程
 * （src/win/fs-event.c:72，0xC0000409，issue #1072）；Rust 侧 compile-cache
 * warmup 更是把 env::temp_dir() 原样注入 CODE_AGENT_DATA_DIR。目录可能尚不
 * 存在（首启），先建再解析；解析失败返回原值——宁可维持旧行为也不能把数据
 * 目录改坏。macOS 上仅解析 /var→/private/var 一类 symlink，前后一致使用无
 * 行为差异（同 scripts/acceptance/_helpers.ts 的 mkdtempLongPath）。
 */
export function expandDataDirLongPath(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync.native(dir);
  } catch (error) {
    console.warn(`[channelDataDir] data dir realpath normalization failed, keeping as-is: ${dir}`, error);
    return dir;
  }
}
