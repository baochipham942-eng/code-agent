// ============================================================================
// Mail Draft Tool - Create a local macOS Mail draft
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

function normalizeAddresses(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
      .split(/[,\n;]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export const mailDraftTool: Tool = {
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
  requiresPermission: true,
  permissionLevel: 'write',
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
  tags: ['planning'],
  aliases: ['draft email', 'mail draft', 'create draft'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const connector = getConnectorRegistry().get('mail');
    if (!connector) {
      return { success: false, error: 'Mail connector is not available.' };
    }

    try {
      const result = await connector.execute('draft_message', params);
      const draft = result.data as {
        subject: string;
        to: string[];
        cc: string[];
        bcc: string[];
        attachments: string[];
        saved: boolean;
      };

      const to = normalizeAddresses(draft.to);
      const cc = normalizeAddresses(draft.cc);
      const bcc = normalizeAddresses(draft.bcc);

      return {
        success: true,
        output: [
          `已创建邮件草稿：${draft.subject}`,
          `To: ${to.join(', ')}`,
          cc.length > 0 ? `CC: ${cc.join(', ')}` : null,
          bcc.length > 0 ? `BCC: ${bcc.join(', ')}` : null,
          draft.attachments.length > 0 ? `Attachments: ${draft.attachments.join(', ')}` : null,
          `状态：${draft.saved ? '已保存到草稿' : '未保存'}`,
        ].filter(Boolean).join('\n'),
        result: draft,
      };
    } catch (error) {
      return {
        success: false,
        error: `Mail draft failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
