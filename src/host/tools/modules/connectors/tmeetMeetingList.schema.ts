import type { ToolSchema } from '../../../protocol/tools';

export const tmeetMeetingListSchema: ToolSchema = {
  name: 'tmeetMeetingList',
  description: `List Tencent Meetings through the official tmeet CLI. Choose scope by the user's meaning:
- scope="upcoming" (default): meetings that are waiting to start or in progress. Use for upcoming/current meetings. If start/end are omitted, keep the CLI default range.
- scope="ended": historical meetings that already ended. Always use this for “历史会议”, “已结束”, “最近开过”, or recent past meetings. If start is omitted, the tool automatically searches from exactly 30 days before now; do not invent a wider window.

Optional filters:
- start / end: ISO 8601 timestamps with timezone
- show_all_sub: 0 or 1, upcoming only
- page_token: token returned by the previous page
- page_size: upcoming 1 to 20; ended 1 to 30
- compact: return the CLI compact response (default true)`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['upcoming', 'ended'],
        description: 'upcoming lists waiting/in-progress meetings; ended lists historical meetings. Defaults to upcoming.',
      },
      start: { type: 'string', description: 'Inclusive start time in ISO 8601 format with timezone.' },
      end: { type: 'string', description: 'Inclusive end time in ISO 8601 format with timezone.' },
      show_all_sub: { type: 'number', description: 'For upcoming scope only, whether to include all sub-meetings: 0 or 1.' },
      page_token: { type: 'string', description: 'Opaque next_page_token from the previous response.' },
      page_size: { type: 'number', minimum: 1, description: 'Page size: at most 20 for upcoming or 30 for ended.' },
      compact: { type: 'boolean', description: 'Use compact CLI output. Defaults to true.' },
    },
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
