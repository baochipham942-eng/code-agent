/** lark-mcp 上游已近一年未更新，pin 住版本；升级需人工决策（工具名清单只对该版本成立） */
export const LARK_MCP_PINNED_VERSION = '0.5.1';

export const FEISHU_DEFAULT_DOMAIN = 'https://open.feishu.cn';

/**
 * 默认域名对应的 host，用于让 stdio 子进程绕过代理（飞书是国内服务，不该走代理）。
 * 从域名派生而不是再写一遍字面量：两处独立字面量迟早只改一处。
 * 注意国际版 open.larksuite.com 反而可能需要代理，所以只放行当前域名这一个 host。
 */
export const FEISHU_DEFAULT_HOST = new URL(FEISHU_DEFAULT_DOMAIN).hostname;

/** 日历接口现行 page_size 最小值，传 20 会 99992402 field validation failed（2026-07-24 真机实测） */
export const FEISHU_CALENDAR_MIN_PAGE_SIZE = 50;

/**
 * 飞书只读工具白名单。
 * 刻意不用 lark-mcp 的 preset：
 *  - preset.calendar.default 里没有 calendarEvent.list，做不出日程冲突提醒
 *  - preset.base.default 含 record.create/update，写权限不能给无人值守 cron
 * 刻意不含 calendar.v4.calendar.list：应用身份下它只返回应用自己的主日历，
 * 枚举不到用户新建的日历，模型会拿空列表报告"你没有日程"（2026-07-24 真机实测）。
 */
export const FEISHU_READONLY_TOOLS = [
  'bitable.v1.appTableRecord.search',
  'bitable.v1.appTableField.list',
  'bitable.v1.appTable.list',
  'calendar.v4.calendar.primary',
  'calendar.v4.calendarEvent.list',
  'calendar.v4.freebusy.list',
] as const;

/**
 * 业务事件监听（external_event 自动化）：在 agent 型 cron 任务的 action.context 里携带，
 * 让任务知道自己盯的是飞书哪个数据源。搭配 S4 的 trackChanges 快照做跨运行变化检测。
 * 检测本身走 agent prompt 调飞书 MCP + 对比上轮 <cron_snapshot>，这里只存"盯什么"。
 */
export const EXTERNAL_WATCH = {
  /** action.context 里携带监听配置的键；有它即派生 SessionAutomationType='external_event'。 */
  CONTEXT_KEY: 'externalWatch',
  SOURCE_CALENDAR: 'feishu-calendar',
  SOURCE_TABLE: 'feishu-table',
  /**
   * 有【新】冲突/变更时 agent 在回复里打的标记；无此标记 = 无新料 = 安静（不进待过目收件箱）。
   * 与 <cron_snapshot>（存当前全量状态供下轮对比）分开：alert 只在"这次比上次多出东西"时出现。
   */
  ALERT_TAG_PATTERN: /<cron_alert>\s*([\s\S]*?)\s*<\/cron_alert>/i,
} as const;

export interface ExternalWatchConfig {
  source: typeof EXTERNAL_WATCH.SOURCE_CALENDAR | typeof EXTERNAL_WATCH.SOURCE_TABLE;
  /** 日历冲突：用户必给。应用身份枚举不到用户新建的日历，calendar_id 只能显式配置。 */
  calendarId?: string;
  /** 表格行变更：多维表格 app_token + table_id。 */
  baseAppToken?: string;
  tableId?: string;
}
