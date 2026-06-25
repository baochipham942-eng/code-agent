// ============================================================================
// Config directory names (shared between main / web / renderer)
// ============================================================================
// 纯字符串常量，无 node-only 依赖，可被 renderer 打包安全引用。
// main 侧的 configPaths.ts 从此处 re-export 以保持单一真值来源。
// ============================================================================

/** New config directory name */
export const CONFIG_DIR_NEW = '.code-agent';

/** Legacy config directory name (for backward compatibility) */
export const CONFIG_DIR_LEGACY = '.claude';
