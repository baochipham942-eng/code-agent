import { describe, expect, it, vi } from 'vitest';
import { collectDroppedAttachmentsAndSkillZips } from '../../../src/renderer/components/features/chat/ChatInput/utils';
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

describe('collectDroppedAttachmentsAndSkillZips', () => {
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

    const result = await collectDroppedAttachmentsAndSkillZips(
      dataTransferFrom([file], [
        {
          kind: 'file',
          webkitGetAsEntry: () => null,
        } as unknown as DataTransferItem,
      ]),
      processFile,
      vi.fn(async () => null),
      async () => [],
    );

    expect(processFile).toHaveBeenCalledWith(file);
    expect(result).toEqual([attachment]);
  });

  it('does not turn a dropped ZIP into a chat attachment when install consumes it', async () => {
    const zip = new File(['PK'], 'demo.skill.zip', { type: 'application/zip' });
    const processFile = vi.fn(async () => ({
      id: 'att-zip',
      type: 'file',
      category: 'archive',
      name: 'demo.skill.zip',
      size: zip.size,
      mimeType: 'application/zip',
      data: 'data:application/zip;base64,UEs=',
    } as MessageAttachment));
    const onSkillZips = vi.fn(async (files: File[]) => {
      expect(files.map((file) => file.name)).toEqual(['demo.skill.zip']);
      return [];
    });

    const result = await collectDroppedAttachmentsAndSkillZips(
      dataTransferFrom([zip]),
      processFile,
      vi.fn(async () => null),
      onSkillZips,
    );

    expect(onSkillZips).toHaveBeenCalled();
    expect(processFile).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('keeps non-zip attachments after DataTransfer is cleared during zip install', async () => {
    const file = new File(['hello'], 'screenshot.png', { type: 'image/png' });
    const zip = new File(['PK'], 'demo.zip', { type: 'application/zip' });
    const attachment: MessageAttachment = {
      id: 'att-1',
      type: 'image',
      category: 'image',
      name: 'screenshot.png',
      size: file.size,
      mimeType: 'image/png',
      data: 'data:image/png;base64,abc',
    };
    const processFile = vi.fn(async (dropped: File) => (
      dropped.name === 'screenshot.png' ? attachment : null
    ));
    const dataTransfer = dataTransferFrom([file, zip]);
    const onSkillZips = vi.fn(async () => {
      Object.defineProperty(dataTransfer, 'files', { value: fileListFrom([]) });
      Object.defineProperty(dataTransfer, 'items', { value: [] });
      return [];
    });

    const result = await collectDroppedAttachmentsAndSkillZips(
      dataTransfer,
      processFile,
      vi.fn(async () => null),
      onSkillZips,
    );

    expect(processFile).toHaveBeenCalledWith(file);
    expect(result).toEqual([attachment]);
  });
});
