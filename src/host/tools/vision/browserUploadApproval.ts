import path from 'node:path';
import type { ToolContext } from '../types';
import {
  inspectBrowserUploadFile,
  relayBrowserUploadApprovalRegistry,
  verifyBrowserUploadFile,
  type ApprovedBrowserUploadFile,
  type BrowserUploadOwner,
} from '../../services/infra/browser/browserUploadApprovalRegistry';

export type BrowserUploadApprovalResult =
  | {
      approved: true;
      file: ApprovedBrowserUploadFile;
      relayToken?: string;
    }
  | {
      approved: false;
      reason: string;
      code: 'SURFACE_APPROVAL_REQUIRED' | 'SURFACE_APPROVAL_INVALID';
    };

function uploadOwner(context: ToolContext): BrowserUploadOwner | null {
  const conversationId = context.sessionId?.trim();
  const runId = context.runId?.trim();
  const agentId = context.agentId?.trim();
  const operationId = context.currentToolCallId?.trim();
  return conversationId && runId && agentId && operationId
    ? { conversationId, runId, agentId, operationId }
    : null;
}

export async function requestBrowserUploadApproval(input: {
  filePath: string;
  context: ToolContext;
  engine: 'managed' | 'relay';
}): Promise<BrowserUploadApprovalResult> {
  let file: ApprovedBrowserUploadFile;
  try {
    file = inspectBrowserUploadFile(input.filePath);
  } catch (error) {
    return {
      approved: false,
      reason: error instanceof Error ? error.message : 'The requested upload file is unavailable.',
      code: 'SURFACE_APPROVAL_INVALID',
    };
  }
  const requestedName = file.name || path.basename(path.resolve(input.filePath)) || 'selected-file';
  const approved = await input.context.requestPermission({
    type: 'file_read',
    tool: 'browser_action.upload_file',
    forceConfirm: true,
    dangerLevel: 'warning',
    reason: '把一个本地文件交给网页前，必须对当前文件和当前浏览器动作做一次性确认。',
    details: {
      file: `.../${requestedName}`,
      action: 'upload_file',
      engine: input.engine,
      approvalMode: 'host_one_time_exact_file',
      sizeBytes: file.size,
      sha256: file.sha256.slice(0, 12),
    },
  });
  if (!approved) {
    return {
      approved: false,
      reason: 'The selected upload file was not explicitly approved.',
      code: 'SURFACE_APPROVAL_REQUIRED',
    };
  }

  try {
    file = verifyBrowserUploadFile(file);
  } catch (error) {
    return {
      approved: false,
      reason: error instanceof Error ? error.message : 'The approved upload file is unavailable.',
      code: 'SURFACE_APPROVAL_INVALID',
    };
  }
  if (input.engine === 'managed') return { approved: true, file };

  const owner = uploadOwner(input.context);
  if (!owner) {
    return {
      approved: false,
      reason: 'Relay upload approval requires conversation, run, agent, and operation ownership.',
      code: 'SURFACE_APPROVAL_INVALID',
    };
  }
  const issued = relayBrowserUploadApprovalRegistry.issue({ owner, file });
  return { approved: true, file, relayToken: issued.token };
}
