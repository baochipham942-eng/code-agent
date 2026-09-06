// ============================================================================
// Config directory names (shared between main / web / renderer)
// ============================================================================
// 纯字符串常量，无 node-only 依赖，可被 renderer 打包安全引用。
// main 侧的 configPaths.ts 从此处 re-export 以保持单一真值来源。
// ============================================================================

/** New config directory name */
export const CONFIG_DIR_NEW = '.code-agent';

/** 测试/开发通道的数据目录名，与生产 CONFIG_DIR_NEW 并存、互不污染 */
export const CONFIG_DIR_DEV = `${CONFIG_DIR_NEW}-dev`;

/** Legacy config directory name (for backward compatibility) */
export const CONFIG_DIR_LEGACY = '.claude';

/**
 * 显式允许跨槽读取其它数据目录。仅评测/诊断用，默认关闭。
 * 取值 `'1'` 才放行；不要靠路径长得像来猜。
 */
export const CROSS_SLOT_READ_ALLOW_ENV = 'CODE_AGENT_ALLOW_CROSS_SLOT_READ';

/**
 * 逗号分隔的允许跨槽读取的数据目录绝对路径白名单。
 * 命中的是槽根（getUserConfigDir 那种目录），不是文件名模式。
 */
export const CROSS_SLOT_READ_ALLOWLIST_ENV = 'CODE_AGENT_CROSS_SLOT_READ_ALLOWLIST';
