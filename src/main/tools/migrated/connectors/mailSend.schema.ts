// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const mailSendSchema: ToolSchema = {
  name: 'mail_send',
  description: `Send a real email via local macOS Mail.

Required parameters:
- subject
- to

Optional parameters:
- content
- cc
- bcc
- attachments

Use this only when the user explicitly wants to send an email now.`,
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Email subject.',
      },
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'Primary recipient email addresses.',
      },
      cc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional CC recipient email addresses.',
      },
      bcc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional BCC recipient email addresses.',
      },
      content: {
        type: 'string',
        description: 'Email body content.',
      },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional attachment file paths.',
      },
    },
    required: ['subject', 'to'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
