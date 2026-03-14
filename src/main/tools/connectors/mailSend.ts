// ============================================================================
// Mail Send Tool - Send a real local macOS Mail message
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

export const mailSendTool: Tool = {
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
  requiresPermission: true,
  permissionLevel: 'write',
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
  tags: ['planning'],
  aliases: ['send email', 'mail send', 'send mail'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const connector = getConnectorRegistry().get('mail');
    if (!connector) {
      return { success: false, error: 'Mail connector is not available.' };
    }

    try {
      const result = await connector.execute('send_message', params);
      const sent = result.data as {
        subject: string;
        to: string[];
        cc: string[];
        bcc: string[];
        attachments: string[];
        sent: boolean;
      };

      return {
        success: true,
        output: [
          `已发送邮件：${sent.subject}`,
          `To: ${sent.to.join(', ')}`,
          sent.cc.length > 0 ? `CC: ${sent.cc.join(', ')}` : null,
          sent.bcc.length > 0 ? `BCC: ${sent.bcc.join(', ')}` : null,
          sent.attachments.length > 0 ? `Attachments: ${sent.attachments.join(', ')}` : null,
        ].filter(Boolean).join('\n'),
        result: sent,
      };
    } catch (error) {
      return {
        success: false,
        error: `Mail send failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
