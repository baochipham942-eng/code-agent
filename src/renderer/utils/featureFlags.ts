// ============================================================================
// Renderer 端 Feature Flag — 轻量 localStorage-based 开关
// ============================================================================
// 主进程 cloudConfigService 提供集中式 Feature Flag，但跨 IPC 异步读取对
// UI 渲染热路径不友好。renderer 这一层只放纯客户端可控的产品视角实验开关：
// 用户自己想 A/B 对比新旧 UI 时可以一键回退，不依赖云端配置。
//
// 关闭某个 flag：在 DevTools console 跑 `localStorage.setItem('cca.<name>', 'false')`
// 重新启用：移除 key 或设为 'true'。
// ============================================================================

const KEY_PREFIX = 'cca.';

function readFlag(name: string, defaultValue: boolean): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return defaultValue;
  const raw = window.localStorage.getItem(KEY_PREFIX + name);
  if (raw === null) return defaultValue;
  return raw !== 'false' && raw !== '0';
}

/**
 * 产品视角 UI 升级（shortDescription / targetContext / rationale 等语义元数据
 * 在前端一等公民展示）。默认开启，关闭后回退到机械拼接式渲染。
 */
export function isSemanticToolUIEnabled(): boolean {
  return readFlag('semanticToolUI', true);
}
