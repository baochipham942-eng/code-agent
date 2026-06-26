// ============================================================================
// MailDraft (P0-6.3 Batch 4 — connectors: native ToolModule rewrite)
//
// 旧版: src/host/tools/connectors/mailDraft.ts (legacy Tool + wrapLegacyTool)
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { mailDraftSchema as schema } from './mailDraft.schema';

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

function textArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function executeMailDraft(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.subject !== 'string' || args.subject.length === 0) {
    return { ok: false, error: 'subject must be a non-empty string', code: 'INVALID_ARGS' };
  }
  if (!Array.isArray(args.to) || args.to.length === 0) {
    return { ok: false, error: 'to must be a non-empty array of strings', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const connector = getConnectorRegistry().get('mail');
  if (!connector) {
    return { ok: false, error: 'Mail connector is not available.', code: 'NOT_INITIALIZED' };
  }

  try {
    const result = await connector.execute('draft_message', args);
    const draft = result.data as {
      subject: string;
      to: string[];
      cc: string[];
      bcc: string[];
      attachments: string[];
      saved: boolean;
    };
    ctx.logger.debug('mail_draft', { subject: draft.subject, saved: draft.saved });

    const to = normalizeAddresses(draft.to);
    const cc = normalizeAddresses(draft.cc);
    const bcc = normalizeAddresses(draft.bcc);
    const output = [
      `已创建邮件草稿：${draft.subject}`,
      `To: ${to.join(', ')}`,
      cc.length > 0 ? `CC: ${cc.join(', ')}` : null,
      bcc.length > 0 ? `BCC: ${bcc.join(', ')}` : null,
      draft.attachments.length > 0 ? `Attachments: ${draft.attachments.join(', ')}` : null,
      `状态：${draft.saved ? '已保存到草稿' : '未保存'}`,
    ].filter(Boolean).join('\n');

    return {
      ok: true,
      output,
      meta: {
        action: 'draft_message',
        connector: 'mail',
        saved: draft.saved,
        subject: draft.subject,
        to,
        cc,
        bcc,
        attachments: draft.attachments,
        previewItem: {
          kind: 'message_draft',
          title: draft.subject,
          subtitle: to.join(', '),
          status: draft.saved ? 'ready' : 'draft',
          content: {
            text: [
              `To: ${to.join(', ')}`,
              cc.length > 0 ? `CC: ${cc.join(', ')}` : null,
              bcc.length > 0 ? `BCC: ${bcc.join(', ')}` : null,
              `Subject: ${draft.subject}`,
              '',
              textArg(args.content),
            ].filter((line) => line !== null).join('\n'),
            summary: `To: ${to.join(', ')}`,
          },
          actions: [
            { kind: 'copy', label: 'Copy' },
            { kind: 'send', label: 'Send' },
          ],
          priority: 80,
        },
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          sessionId: ctx.sessionId,
          name: `mail-draft-${draft.subject}`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            connector: 'mail',
            action: 'draft_message',
            subject: draft.subject,
            saved: draft.saved,
            toCount: to.length,
            attachmentCount: draft.attachments.length,
          },
        }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Mail draft failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

class MailDraftHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeMailDraft(args, ctx, canUseTool, onProgress);
  }
}

export const mailDraftModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new MailDraftHandler();
  },
};
