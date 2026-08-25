type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function firstString(item: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function formatMeetingTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]}` : value;
}

function meetingItems(response: JsonObject): JsonObject[] {
  const data = asObject(response.data);
  if (!data) return [];
  const items = data.meeting_info_list ?? data.meetings;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const meeting = asObject(item);
    return meeting ? [meeting] : [];
  });
}

function formatMeetingLine(meeting: JsonObject): string {
  const subject = firstString(meeting, ['subject', 'meeting_subject', 'title']) ?? '未命名会议';
  const start = formatMeetingTime(firstString(meeting, [
    'actual_start_time',
    'start_time',
    'scheduled_start_time',
    'meeting_start_time',
  ]));
  const end = formatMeetingTime(firstString(meeting, [
    'actual_end_time',
    'end_time',
    'scheduled_end_time',
    'meeting_end_time',
  ]));
  const time = start && end ? `${start} 至 ${end}` : start ?? end ?? '时间未知';
  const creator = firstString(meeting, [
    'creator_name',
    'creator_nickname',
    'creator',
    'host_name',
  ]) ?? '未知';
  return `- ${subject}｜${time}｜发起人：${creator}`;
}

export function formatTmeetMeetingReceipt(
  response: JsonObject,
  emptyMessage: string,
): string {
  const meetings = meetingItems(response);
  if (meetings.length === 0) return emptyMessage;
  return `${meetings.length} 场会议：\n${meetings.map(formatMeetingLine).join('\n')}`;
}
