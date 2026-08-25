type PromptLanguage = 'zh' | 'en';

function readUserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Formats the user's current calendar date once for every prompt consumer.
 * Keep callers on these returned date parts so the system prompt, web search,
 * and cron prompts cannot drift onto independently calculated dates.
 */
export function formatTodayAnchor(
  now: Date = new Date(),
  timeZone: string = readUserTimeZone(),
  language: PromptLanguage = 'zh',
): {
  prompt: string;
  isoDate: string;
  year: number;
  month: number;
  day: number;
} {
  const locale = language === 'en' ? 'en-US' : 'zh-CN';
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  const year = Number(part('year'));
  const month = Number(part('month'));
  const day = Number(part('day'));
  const weekday = part('weekday');
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const previousYear = year - 1;
  const prompt = language === 'en'
    ? `Today's date: ${isoDate} (${weekday}).\nThe current year is ${year}, not ${previousYear} — treat this date as authoritative.`
    : `今天的日期：${isoDate}（${weekday}）。\n当前年份是 ${year}，不是 ${previousYear}；请将此日期视为权威信息。`;

  return { prompt, isoDate, year, month, day };
}
