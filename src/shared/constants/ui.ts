/** UI 配置 */
export const UI = {
  /** 防抖延迟 (ms) */
  DEBOUNCE_DELAY: 300,
  /** 动画时长 (ms) */
  ANIMATION_DURATION: 200,
  /** 历史记录最大条数 */
  MAX_HISTORY_ITEMS: 100,
  /** Toast 默认显示时长 (ms) */
  TOAST_DURATION: 5000,
  /** 复制成功反馈时长 (ms) */
  COPY_FEEDBACK_DURATION: 2000,
  /** 侧边栏默认宽度 */
  SIDEBAR_WIDTH: 280,
  /** 启动延迟-更新检查 (ms) */
  STARTUP_UPDATE_CHECK_DELAY: 2000,
  /** 启动延迟-API Key 检查 (ms) */
  STARTUP_API_KEY_CHECK_DELAY: 1500,
  /** 面板刷新间隔 (ms) */
  PANEL_REFRESH_INTERVAL: 30000,
  /** 云任务刷新间隔 (ms) */
  CLOUD_TASK_REFRESH_INTERVAL: 5000,
  /** 预览文本截断长度 */
  PREVIEW_TEXT_MAX_LENGTH: 500,
  /** 最大附件数量（文件选择） */
  MAX_ATTACHMENTS_FILE_SELECT: 5,
  /** 最大附件数量（拖放） */
  MAX_ATTACHMENTS_DROP: 10,
  /** 文本域最大高度 (px) */
  TEXTAREA_MAX_HEIGHT: 200,
  /** 工具调用分组阈值：N 个以上自动归组 */
  TOOL_GROUP_THRESHOLD: 3,
  /** 工具组自动折叠延迟 (ms) */
  TOOL_GROUP_COLLAPSE_DELAY: 500,
  /** Todo 面板全部完成后淡出延迟 (ms) */
  TODO_PANEL_FADE_DELAY: 3000,
  /** Todo 面板计时更新间隔 (ms) */
  TODO_PANEL_TICK_INTERVAL: 1000,
} as const;

/** 窗口配置 */
export const WINDOW = {
  /** 默认宽度 */
  DEFAULT_WIDTH: 1200,
  /** 默认高度 */
  DEFAULT_HEIGHT: 800,
  /** 最小宽度 */
  MIN_WIDTH: 800,
  /** 最小高度 */
  MIN_HEIGHT: 600,
} as const;

export const TELEMETRY_TRUNCATION = {
  USER_PROMPT: 50000,
  ASSISTANT_RESPONSE: 50000,
  THINKING_CONTENT: 20000,
  TOOL_ARGUMENTS: 10000,
  TOOL_RESULT_SUMMARY: 2000,
  EVENT_SUMMARY: 500,
} as const;
