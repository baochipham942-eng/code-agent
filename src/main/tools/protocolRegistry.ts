// ============================================================================
// Protocol Tool Registry — 单例 + 工具注册
//
// 职责：
// 1. 暴露 getProtocolRegistry() 单例，首次调用时 lazy 创建 + 注册已迁移工具
// 2. 暴露 isProtocolToolName() 判断一个工具名是否在 protocol registry 中
//
// 和 legacy toolRegistry.ts 完全独立，不互相 import。
// ============================================================================

import { ToolRegistry } from './registry';
import { registerMigratedTools } from './modules';

let singleton: ToolRegistry | null = null;

/** 单例访问，首次调用时注册已迁移 tool */
export function getProtocolRegistry(): ToolRegistry {
  if (!singleton) {
    singleton = new ToolRegistry();
    registerMigratedTools(singleton);
  }
  return singleton;
}

/** 测试用：重置单例，让下一次 get 重新注册 */
export function resetProtocolRegistry(): void {
  singleton = null;
}

/** 判断一个 tool 名字是否已在 protocol registry 中注册 */
export function isProtocolToolName(name: string): boolean {
  return getProtocolRegistry().has(name);
}
