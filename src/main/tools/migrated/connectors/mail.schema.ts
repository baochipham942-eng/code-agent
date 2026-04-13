// Schema-only file (P0-7 方案 A — single source of truth)
// Imported by both mail.ts (handler) and migrated/index.ts (registry).
import type { ToolSchema } from '../../../protocol/tools';

export const mailSchema: ToolSchema = {
  name: 'mail',
  description: `Read local macOS Mail data via the native connector.

Supported actions:
- get_status
- list_accounts
- list_mailboxes
- list_messages
- read_message

For list_messages and read_message, provide mailbox. Account is optional but recommended when mailbox names may overlap.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_status', 'list_accounts', 'list_mailboxes', 'list_messages', 'read_message'],
        description: 'Mail action to perform.',
      },
      account: {
        type: 'string',
        description: 'Optional account name, used by list_mailboxes/list_messages/read_message.',
      },
      mailbox: {
        type: 'string',
        description: 'Mailbox name, required for list_messages/read_message.',
      },
      query: {
        type: 'string',
        description: 'Optional subject/sender filter for list_messages.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of messages to return. Default: 10.',
      },
      scan_limit: {
        type: 'number',
        description: 'Maximum number of messages to scan before applying query filter. Optional.',
      },
      message_id: {
        type: 'number',
        description: 'Message id for read_message.',
      },
    },
    required: ['action'],
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
