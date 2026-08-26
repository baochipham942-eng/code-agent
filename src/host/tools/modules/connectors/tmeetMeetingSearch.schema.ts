import type { ToolSchema } from '../../../protocol/tools';

export const tmeetMeetingSearchSchema: ToolSchema = {
  name: 'tmeetMeetingSearch',
  stepLabel: { default: 'tmeetMeetingSearch' },
  description: `Search Tencent Meetings through the official tmeet CLI by keyword, exact numeric meeting code, or time window.

Use this tool when the user gives a meeting subject/creator/note keyword, asks to find a meeting, or provides a meeting code. A time window matches when the scheduled start, actual start, or the user's join time falls within it. For time-only requests, prefer tmeetMeetingList with the appropriate upcoming/ended scope.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Meeting subject, creator, or note keyword.' },
      query_field: {
        type: 'string',
        enum: ['subject', 'creator', 'note', 'all'],
        description: 'Field searched by query. Defaults to all.',
      },
      meeting_code: { type: 'string', pattern: '^\\d+$', description: 'Exact meeting code: digits only, without dashes.' },
      start: { type: 'string', description: 'Inclusive lower time bound in ISO 8601 format with timezone.' },
      end: { type: 'string', description: 'Inclusive upper time bound in ISO 8601 format with timezone.' },
      page_token: { type: 'string', description: 'Opaque next_page_token from the previous response.' },
      page_size: { type: 'number', minimum: 1, description: 'Page size, at most 30.' },
      compact: { type: 'boolean', description: 'Use compact CLI output. Defaults to true.' },
    },
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
