// ============================================================================
// 共享详情页日期时间格式化：全 renderer 的日期展示统一收口到这里，语言跟 UI language
// （N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1：自 cron/types.ts 迁出，供非 cron 屏复用）。
// ============================================================================

import type { Language } from '../i18n';

/**
 * 详情页时间（FB-567/FB-570）：zh 固定 24 小时制 `YYYY/MM/DD HH:mm`（手工拼，绝不裸
 * toLocaleString() 跟机器 locale 走）；en 维持 en-US 原样。运行列表仍用 cron 的
 * formatRunListTime（月/日短格式，避免撑出容器）。
 */
export function formatDateTime(value?: string | number | Date, lang: Language = 'zh'): string {
  if (value == null) return '未设置';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '无效时间';
  if (lang === 'en') return date.toLocaleString('en-US');
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
