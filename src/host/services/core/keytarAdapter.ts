/**
 * 延迟加载 keytar，处理 native 模块版本不匹配的情况。
 * 纯 CLI 模式下 keytar 为 Electron headers 编译，系统 Node.js 加载会 segfault，
 * 必须在 require 前直接跳过。桌面 Web 后端也会设置 CODE_AGENT_CLI_MODE，
 * 但随包 Node 已携带可用的 keytar，须由 CODE_AGENT_WEB_MODE 区分并正常加载。
 * 加载失败时仍由 secure store 兜底。
 */
export function loadKeytar(
  loader: () => typeof import('keytar') = () => require('keytar') as typeof import('keytar')
): typeof import('keytar') | null {
  if (process.env.CODE_AGENT_CLI_MODE && process.env.CODE_AGENT_WEB_MODE !== 'true') return null;
  try {
    return loader();
  } catch (error) {
    console.warn('[SecureStorage] keytar not available:', (error as Error).message?.split('\n')[0]);
    return null;
  }
}
