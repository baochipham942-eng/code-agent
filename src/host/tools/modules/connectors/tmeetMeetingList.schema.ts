import type { ToolSchema } from '../../../protocol/tools';

export const tmeetMeetingListSchema: ToolSchema = {
  name: 'tmeetMeetingList',
  description: `List upcoming or in-progress Tencent Meetings through the official tmeet CLI.

Optional filters:
- start / end: ISO 8601 timestamps with timezone
- show_all_sub: 0 or 1
- page_token: token returned by the previous page
- page_size: 1 to 20
- compact: return the CLI compact response (default true)`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'Inclusive start time in ISO 8601 format with timezone.' },
      end: { type: 'string', description: 'Inclusive end time in ISO 8601 format with timezone.' },
      show_all_sub: { type: 'number', description: 'Whether to include all sub-meetings: 0 or 1.' },
      page_token: { type: 'string', description: 'Opaque next_page_token from the previous response.' },
      page_size: { type: 'number', minimum: 1, description: 'Page size, at most 20.' },
      compact: { type: 'boolean', description: 'Use compact CLI output. Defaults to true.' },
    },
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
