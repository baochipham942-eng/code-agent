// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const mailDraftSchema: ToolSchema = {
  name: 'mail_draft',
  description: `Create a draft in local macOS Mail via the native connector.

Required parameters:
- subject
- to

Optional parameters:
- content
- cc
- bcc
- attachments

Use this when the user wants a real email draft prepared locally, but not sent yet.`,
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Draft subject.',
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
        description: 'Draft body content.',
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
