import { useCallback } from 'react';
import type { MessageAttachment } from '@shared/contract';
import { collectDroppedAttachmentsAndSkillZips } from './ChatInput/utils';
import { divertDroppedSkillZips } from '../../../services/skillLocalZip';

export function useChatGlobalFileDrop(args: {
  processFile: (file: File) => Promise<MessageAttachment | null>;
  processFolderEntry: (
    dirEntry: FileSystemDirectoryEntry,
    folderName: string,
  ) => Promise<MessageAttachment | null>;
  sessionId?: string | null;
  successPrefix: string;
  failPrefix: string;
  confirmPrompt: string;
  onAttachments: (attachments: MessageAttachment[]) => void;
  onDropStart: () => void;
}): (event: React.DragEvent) => Promise<void> {
  const {
    processFile,
    processFolderEntry,
    sessionId,
    successPrefix,
    failPrefix,
    confirmPrompt,
    onAttachments,
    onDropStart,
  } = args;

  return useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onDropStart();
    const attachments = await collectDroppedAttachmentsAndSkillZips(
      event.dataTransfer,
      processFile,
      processFolderEntry,
      (zips) => divertDroppedSkillZips(zips, { sessionId, successPrefix, failPrefix, confirmPrompt }),
    );
    if (attachments.length > 0) onAttachments(attachments);
  }, [confirmPrompt, failPrefix, onAttachments, onDropStart, processFile, processFolderEntry, sessionId, successPrefix]);
}
