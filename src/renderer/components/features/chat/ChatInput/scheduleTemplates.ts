// ============================================================================
// 定时任务模板库（Codex 式预置卡片）
//
// /schedule 不带参数时，ScheduleComposerCard 用这些模板做「点选填空即建」。
// 每个模板把填空值拼成一句自然语言描述，仍走现有 cron:generateFromPrompt → createJob
// 单一创建路径——模板只负责降低输入成本，不另起 schedule 解析逻辑。
// ============================================================================

export interface ScheduleTemplateField {
  key: string;
  label: string;
  placeholder: string;
  defaultValue?: string;
  /** 多行输入（自定义模式用）。 */
  multiline?: boolean;
}

export interface ScheduleTemplate {
  id: string;
  emoji: string;
  name: string;
  /** 一句话说明这个模板做什么。 */
  blurb: string;
  fields: ScheduleTemplateField[];
  /** 把填空值拼成给 generateFromPrompt 的自然语言描述。 */
  compose: (values: Record<string, string>) => string;
}

/** 自定义模板 id——card 据此切到自由文本模式。 */
export const CUSTOM_TEMPLATE_ID = 'custom';

export const SCHEDULE_TEMPLATES: ScheduleTemplate[] = [
  {
    id: 'daily-briefing',
    emoji: '📰',
    name: '每日简报',
    blurb: '每天定点整理一份简报',
    fields: [
      { key: 'time', label: '时间', placeholder: '09:00', defaultValue: '09:00' },
      { key: 'topic', label: '主题 / 数据来源', placeholder: '汇总昨天的行业要闻和团队动态' },
    ],
    compose: (v) => `每天 ${v.time || '09:00'}，${v.topic || '汇总当天要点'}，整理成一份简报发给我`,
  },
  {
    id: 'bug-scan',
    emoji: '🐛',
    name: '缺陷扫描',
    blurb: '定期扫描缺陷并汇报',
    fields: [
      { key: 'time', label: '时间', placeholder: '09:30', defaultValue: '09:30' },
      { key: 'scope', label: '扫描范围', placeholder: '主仓库 main 分支的最新改动' },
    ],
    compose: (v) =>
      `每天 ${v.time || '09:30'} 扫描 ${v.scope || '代码仓库'} 的缺陷、报错与异常，汇总成一份报告`,
  },
  {
    id: 'weekly-review',
    emoji: '📅',
    name: '周回顾',
    blurb: '每周复盘并输出总结',
    fields: [
      { key: 'when', label: '时间', placeholder: '周五 18:00', defaultValue: '周五 18:00' },
      { key: 'focus', label: '回顾内容', placeholder: '本周的进展、卡点和下周计划' },
    ],
    compose: (v) =>
      `每周 ${v.when || '周五 18:00'}，回顾 ${v.focus || '本周工作'}，输出一份周回顾总结`,
  },
  {
    id: CUSTOM_TEMPLATE_ID,
    emoji: '✏️',
    name: '自定义',
    blurb: '用自然语言描述你要的定时任务',
    fields: [
      {
        key: 'description',
        label: '任务描述',
        placeholder: '例如：每个工作日下午 5 点提醒我提交日报',
        multiline: true,
      },
    ],
    compose: (v) => (v.description || '').trim(),
  },
];

/** 用模板默认值初始化填空 state。 */
export function initTemplateValues(template: ScheduleTemplate): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of template.fields) {
    values[field.key] = field.defaultValue ?? '';
  }
  return values;
}
