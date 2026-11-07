/** 浏览器面板 stage 视口跟随 + 帧采集（三期 R4） */
export const BROWSER_STAGE_VIEWPORT = {
  /** ResizeObserver 上报去抖 */
  DEBOUNCE_MS: 300,
  /** 视口 CSS 最小宽/高 */
  MIN_CSS_WIDTH: 320,
  MIN_CSS_HEIGHT: 240,
  /** 视口 CSS 最大宽/高（防异常大面板） */
  MAX_CSS_WIDTH: 3840,
  MAX_CSS_HEIGHT: 2160,
  /** 帧采集物理像素封顶（宽优先；高按比例封） */
  CAPTURE_MAX_WIDTH: 2560,
  CAPTURE_MAX_HEIGHT: 1600,
  /** JPEG 质量（CDP screencast 0-100） */
  JPEG_QUALITY: 72,
  /** 拖拽判定阈值（显示 CSS px） */
  DRAG_THRESHOLD_PX: 4,
  /** 拖拽路径中间点上限 */
  DRAG_PATH_MAX_POINTS: 48,
} as const;

/** IM 通道入站幂等（WP3-2）：去重状态容量上界，防内存无界增长 */
export const CHANNEL_INGRESS = {
  /** channel 层入站去重集容量（feishu event_id/message_id、telegram update_id） */
  DEDUPE_MAX_ENTRIES: 2048,
  /** bridge processedMessages 容量上界（此前仅 24h TTL 无上界） */
  PROCESSED_MESSAGES_MAX: 5000,
} as const;

/** 更新检查配置 */
export const UPDATE = {
  /** 检查间隔 (24 小时) */
  CHECK_INTERVAL: 86400000,
  /** 下载超时 (5 分钟) */
  DOWNLOAD_TIMEOUT: 300000,
  /** 启动后首次检查延迟 (5 秒) */
  INITIAL_CHECK_DELAY: 5000,
  /** 云端检查间隔 (1 小时) */
  CLOUD_CHECK_INTERVAL: 3600000,
} as const;

/** 网络端口配置 */
export const PORTS = {
  /** Log Bridge 默认端口 */
  logBridge: typeof process !== 'undefined' && process.env?.LOG_BRIDGE_PORT
    ? parseInt(process.env.LOG_BRIDGE_PORT, 10)
    : 51820,
} as const;

/** macOS 原生连接器 id（仅枚举可用值，默认不自动启用）*/
export const NATIVE_CONNECTOR_IDS = ['calendar', 'mail', 'reminders', 'photos'] as const;
export type NativeConnectorId = typeof NATIVE_CONNECTOR_IDS[number];

/** MCP 配置中指向 SecureStorage integration 槽的凭据引用前缀。 */
export const MCP_SECRET_REF_PREFIX = 'secureref:';
