import { describe, expect, it, vi } from 'vitest';
import { collectDroppedAttachments } from '../../../src/renderer/components/features/chat/ChatInput/utils';
import type { MessageAttachment } from '../../../src/shared/contract';

function fileListFrom(files: File[]): FileList {
  return {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* () {
      yield* files;
    },
  } as FileList;
}

function dataTransferFrom(files: File[], items?: DataTransferItem[]): DataTransfer {
  return {
    files: fileListFrom(files),
    items: items as unknown as DataTransferItemList,
  } as DataTransfer;
}

describe('collectDroppedAttachments', () => {
  it('falls back to files when DataTransfer items expose no entries', async () => {
    const file = new File(['hello'], 'screenshot.png', { type: 'image/png' });
    const attachment: MessageAttachment = {
      id: 'att-1',
      type: 'image',
      category: 'image',
      name: 'screenshot.png',
      size: file.size,
      mimeType: 'image/png',
      data: 'data:image/png;base64,abc',
    };
    const processFile = vi.fn(async () => attachment);

    const result = await collectDroppedAttachments(
      dataTransferFrom([file], [
        {
          kind: 'file',
          webkitGetAsEntry: () => null,
        } as unknown as DataTransferItem,
      ]),
      processFile,
      vi.fn(async () => null),
    );

    expect(processFile).toHaveBeenCalledWith(file);
    expect(result).toEqual([attachment]);
  });
});
