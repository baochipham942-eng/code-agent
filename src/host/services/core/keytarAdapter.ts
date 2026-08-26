/**
 * 延迟加载 keytar，处理 native 模块版本不匹配的情况。
 * CLI 模式下 keytar 为 Electron headers 编译，系统 Node.js 加载会 segfault，
 * 必须在 require 前直接跳过；Electron 中加载失败则由 secure store 兜底。
 */
export function loadKeytar(): typeof import('keytar') | null {
  if (process.env.CODE_AGENT_CLI_MODE) return null;
  try {
    const loadedKeytar: unknown = require('keytar');
    return loadedKeytar as typeof import('keytar');
  } catch (error) {
    console.warn('[SecureStorage] keytar not available:', (error as Error).message?.split('\n')[0]);
    return null;
  }
}
