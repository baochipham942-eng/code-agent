import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 延迟加载 keytar，处理 native 模块版本不匹配的情况。
 * 纯 CLI 模式下 keytar 为 Electron headers 编译，系统 Node.js 加载会 segfault，
 * 必须在 require 前直接跳过。桌面 Web 后端也会设置 CODE_AGENT_CLI_MODE，
 * 但随包 Node 已携带可用的 keytar，须由 CODE_AGENT_WEB_MODE 区分并正常加载。
 * 加载失败时仍由 secure store 兜底。
 *
 * macOS 上 $HOME 没有默认登录钥匙串时（无头/隔离验证环境把 HOME 指到 scratch 目录）
 * 必须整体放弃 keytar：SecKeychainAddGenericPassword 会走 defaultKeychainUI →
 * AuthorizationCopyRights，无 UI 会话的进程里 XPC 永久阻塞，且 KeychainCore 全局
 * 互斥锁被占住，后续 keytar 调用全部排在锁上——这些都跑在 libuv 线程池（默认 4 线程），
 * 几次调用就把线程池吃满，连带 fs（express.static）与 dns（Supabase 出站）一起饿死，
 * webServer 表现为 `/`、`/assets/*` 零字节与 signInEmail 悬死（N-APPROVAL-LANE-CLICK-DROP-FU1）。
 * 跳过后 session/设置落回按数据目录隔离的文件态 secure store（无槽验证本就依赖它）。
 */
function hasDarwinLoginKeychain(): boolean {
  if (process.platform !== 'darwin') return true;
  const home = process.env.HOME || os.homedir();
  if (!home) return false;
  return existsSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'));
}

export function loadKeytar(
  loader: () => typeof import('keytar') = () => require('keytar') as typeof import('keytar')
): typeof import('keytar') | null {
  if (process.env.CODE_AGENT_CLI_MODE && process.env.CODE_AGENT_WEB_MODE !== 'true') return null;
  if (!hasDarwinLoginKeychain()) {
    console.warn(
      '[SecureStorage] keytar skipped: no default login keychain under $HOME'
      + ' (headless/scratch HOME would wedge the Keychain and starve the libuv threadpool);'
      + ' falling back to the file-backed secure store',
    );
    return null;
  }
  try {
    return loader();
  } catch (error) {
    console.warn('[SecureStorage] keytar not available:', (error as Error).message?.split('\n')[0]);
    return null;
  }
}
