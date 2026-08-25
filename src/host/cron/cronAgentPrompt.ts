import { CRON_AGENT_SNAPSHOT } from '../../shared/constants';
import { formatTodayAnchor } from '../../shared/todayAnchor';

/**
 * 只有开了变化追踪的任务才包装 prompt；没开的任务原样发送，行为完全不变。
 *
 * 首次运行（还没有旧快照）同样要带上「输出快照标记」这句——否则模型根本不知道
 * 要吐标记，第一次必然拿不到快照，就只能退而求其次拿整段回答顶替，
 * 于是把一坨叙述性文字当成状态注回下一轮。
 */
export function buildCronAgentPrompt(
  prompt: string,
  snapshot: unknown,
  enabled: boolean,
  now: Date = new Date(),
): string {
  // 注入当前时间锚点：LLM 默认拿训练期日期，会把「今天/明天」算成过去时间。
  // 真机 dogfood(2026-07-24)证明「只给 ISO 时间」不够：GLM-5 认出了今天日期，却仍把
  // 本地当天 epoch 算成 2025 年、错时区——模型的 epoch 算术不可信。所以直接把算好的
  // 当天/次日本地 00:00 的 Unix 秒喂给它，让它照抄不换算。
  // ponytail: 用机器本地时区（目标用户=Asia/Shanghai）；跨时区 cron 需按 job 时区算，届时接 tz 库。
  const todayAnchor = formatTodayAnchor(now);
  const startOfDay = new Date(todayAnchor.year, todayAnchor.month - 1, todayAnchor.day, 0, 0, 0, 0);
  const todayEpoch = Math.floor(startOfDay.getTime() / 1000);
  const tomorrowEpoch = todayEpoch + 86400;
  const timeAnchor =
    `【当前时间】${now.toISOString()}（UTC）。今天本地日期是 ${todayAnchor.isoDate}。`
    + `若要按「今天/本地当天」查询时间戳，直接用这两个算好的值，不要自己换算年份：`
    + `今天本地 00:00 = ${todayEpoch}（Unix 秒），次日本地 00:00 = ${tomorrowEpoch}（Unix 秒）。`
    + '其他相对时间以【当前时间】为基准，不要用你训练时的日期。';
  if (!enabled) return [prompt, '', timeAnchor].join('\n');

  const hasSnapshot = typeof snapshot === 'string' && Boolean(snapshot.trim());
  return [
    prompt,
    '',
    timeAnchor,
    ...(hasSnapshot
      ? [
        '',
        '上次运行看到的快照：',
        '<previous_snapshot>',
        snapshot as string,
        '</previous_snapshot>',
        '',
        '请把上面的快照和本次看到的内容对比，这次只需要说明变化。',
      ]
      : []),
    '',
    '回复末尾请用 <cron_snapshot>...</cron_snapshot> 包住本次需要记住的简短快照，供下次对比。',
  ].join('\n');
}

export function truncateUtf8Snapshot(snapshot: string): { value: string; truncated: boolean } {
  const bytes = Buffer.from(snapshot, 'utf8');
  if (bytes.length <= CRON_AGENT_SNAPSHOT.MAX_BYTES) {
    return { value: snapshot, truncated: false };
  }

  let end = CRON_AGENT_SNAPSHOT.MAX_BYTES;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return { value: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
