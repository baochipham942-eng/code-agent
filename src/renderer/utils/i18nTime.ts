// ============================================================================
// i18n 时间工具：语言 → BCP47 locale 推导 + 相对时间格式化
// 仓内相对时间格式化此前散落 7+ 处且硬编码中文，统一收口到这里（逐批迁移接入）。
// ============================================================================

import type { Language, Translations } from '../i18n';

/** 当前 UI 语言对应的 BCP47 locale（Intl.* / toLocale* 的 locale 参数一律从这里拿） */
export function localeForLanguage(language: Language): string {
  return language === 'zh' ? 'zh-CN' : 'en-US';
}

/** 相对时间：刚刚 / N分钟前 / N小时前 / N天前 / N个月前 */
export function formatRelativeTime(t: Translations, timestamp: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return t.time.justNow;
  if (minutes < 60) return t.time.minutesAgo.replace('{n}', String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.time.hoursAgo.replace('{n}', String(hours));
  const days = Math.floor(hours / 24);
  if (days < 30) return t.time.daysAgo.replace('{n}', String(days));
  return t.time.monthsAgo.replace('{n}', String(Math.floor(days / 30)));
}
