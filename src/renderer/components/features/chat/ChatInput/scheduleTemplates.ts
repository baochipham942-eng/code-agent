// ============================================================================
// 定时任务模板库（Codex 式预置卡片）
//
// /schedule 不带参数时，ScheduleComposerCard 用这些模板做「点选填空即建」。
// 每个模板把填空值拼成一句自然语言描述，仍走现有 cron:generateFromPrompt → createJob
// 单一创建路径——模板只负责降低输入成本，不另起 schedule 解析逻辑。
// ============================================================================

import type { Translations } from '../../../../i18n/zh';

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

/** 词条来自 t.scheduleTemplates（zh 默认值内嵌进 compose，随 t 一起本地化）。 */
export function getScheduleTemplates(t: Translations): ScheduleTemplate[] {
  const s = t.scheduleTemplates;
  return [
    {
      id: 'daily-briefing',
      emoji: '📰',
      name: s.dailyBriefing.name,
      blurb: s.dailyBriefing.blurb,
      fields: [
        { key: 'time', label: s.dailyBriefing.timeLabel, placeholder: s.dailyBriefing.timeDefault, defaultValue: s.dailyBriefing.timeDefault },
        { key: 'topic', label: s.dailyBriefing.topicLabel, placeholder: s.dailyBriefing.topicPlaceholder },
      ],
      compose: (v) => s.dailyBriefing.composeTemplate
        .replace('{time}', v.time || s.dailyBriefing.timeDefault)
        .replace('{topic}', v.topic || s.dailyBriefing.topicDefault),
    },
    {
      id: 'bug-scan',
      emoji: '🐛',
      name: s.bugScan.name,
      blurb: s.bugScan.blurb,
      fields: [
        { key: 'time', label: s.dailyBriefing.timeLabel, placeholder: s.bugScan.timeDefault, defaultValue: s.bugScan.timeDefault },
        { key: 'scope', label: s.bugScan.scopeLabel, placeholder: s.bugScan.scopePlaceholder },
      ],
      compose: (v) => s.bugScan.composeTemplate
        .replace('{time}', v.time || s.bugScan.timeDefault)
        .replace('{scope}', v.scope || s.bugScan.scopeDefault),
    },
    {
      id: 'weekly-review',
      emoji: '📅',
      name: s.weeklyReview.name,
      blurb: s.weeklyReview.blurb,
      fields: [
        { key: 'when', label: s.weeklyReview.whenLabel, placeholder: s.weeklyReview.whenDefault, defaultValue: s.weeklyReview.whenDefault },
        { key: 'focus', label: s.weeklyReview.focusLabel, placeholder: s.weeklyReview.focusPlaceholder },
      ],
      compose: (v) => s.weeklyReview.composeTemplate
        .replace('{when}', v.when || s.weeklyReview.whenDefault)
        .replace('{focus}', v.focus || s.weeklyReview.focusDefault),
    },
    {
      id: CUSTOM_TEMPLATE_ID,
      emoji: '✏️',
      name: s.custom.name,
      blurb: s.custom.blurb,
      fields: [
        {
          key: 'description',
          label: s.custom.descriptionLabel,
          placeholder: s.custom.descriptionPlaceholder,
          multiline: true,
        },
      ],
      compose: (v) => (v.description || '').trim(),
    },
  ];
}

/** 用模板默认值初始化填空 state。 */
export function initTemplateValues(template: ScheduleTemplate): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of template.fields) {
    values[field.key] = field.defaultValue ?? '';
  }
  return values;
}
