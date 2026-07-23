import type { AppshotCapture } from '@shared/contract/appshot';
import type { MessageAttachment } from '../../../../../shared/contract';
import { AppshotChip } from './AppshotChip';
import { AttachmentBar } from './AttachmentBar';
import { NeoContinuationChip } from './NeoContinuationChip';
import { SelectedCapabilityChips } from './SelectedCapabilityChips';

interface ComposerChipsRowProps {
  pendingAppshot: AppshotCapture | null;
  clearAppshot: () => void;
  attachments: MessageAttachment[];
  removeAttachment: (id: string) => void;
}

export function ComposerChipsRow({ pendingAppshot, clearAppshot, attachments, removeAttachment }: ComposerChipsRowProps) {
  return (
    <>
      {pendingAppshot && (
        <div className="mb-2 px-2">
          <AppshotChip capture={pendingAppshot} onRemove={clearAppshot} />
        </div>
      )}
      <div className="empty:hidden mb-2 px-2">
        <NeoContinuationChip />
      </div>
      <SelectedCapabilityChips />
      {attachments.length > 0 && (
        <div className="mb-2">
          <AttachmentBar attachments={attachments} onRemove={removeAttachment} />
        </div>
      )}
    </>
  );
}
