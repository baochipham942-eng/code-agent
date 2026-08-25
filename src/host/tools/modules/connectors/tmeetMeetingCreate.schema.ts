import type { ToolSchema } from '../../../protocol/tools';

export const tmeetMeetingCreateSchema: ToolSchema = {
  name: 'tmeetMeetingCreate',
  description: `Create a Tencent Meeting through the official tmeet CLI.

Required: subject, start, end. Times must be ISO 8601 with timezone.
This is a real write action and must pass the write permission gate.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Meeting subject.' },
      start: { type: 'string', description: 'Meeting start time in ISO 8601 format with timezone.' },
      end: { type: 'string', description: 'Meeting end time in ISO 8601 format with timezone.' },
      password: { type: 'string', description: 'Optional 4 to 6 digit meeting password.' },
      timezone: { type: 'string', description: 'Optional timezone, for example Asia/Shanghai.' },
      meeting_type: { type: 'number', description: '0 normal, 1 recurring.' },
      join_type: { type: 'number', description: 'Join restriction: 1 all members, 2 invited only, or 3 internal only.' },
      waiting_room: { type: 'boolean', description: 'Enable the waiting room.' },
      recurring_type: { type: 'number', description: 'Recurring cadence from 0 through 4.' },
      until_type: { type: 'number', description: 'Recurring end mode: 0 by date, 1 by count.' },
      until_count: { type: 'number', minimum: 1, description: 'Recurring occurrence count, at most 500.' },
      until_date: { type: 'string', description: 'Recurring end date in ISO 8601 format with timezone.' },
      invitees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tencent Meeting openid values to invite, at most 100.',
      },
      water_mark_type: { type: 'number', description: 'Text watermark mode: 0, 1, or 2.' },
      audio_watermark: { type: 'boolean', description: 'Enable or explicitly disable audio watermark.' },
      auto_record_type: { type: 'string', enum: ['none', 'local', 'cloud'], description: 'Automatic recording mode.' },
      auto_asr: { type: 'boolean', description: 'Enable or explicitly disable automatic transcription.' },
    },
    required: ['subject', 'start', 'end'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
