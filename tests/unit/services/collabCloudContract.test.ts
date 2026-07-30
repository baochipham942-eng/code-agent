import { describe, expect, it } from 'vitest';
import {
  COLLAB_CARD_METADATA_FIELDS,
  pickCollabCardMetadata,
} from '../../../src/host/services/project/collabCloudContract';

describe('collaboration card metadata cloud whitelist', () => {
  it('keeps only the six approved card metadata fields', () => {
    const cloudPayload = pickCollabCardMetadata({
      title: 'Ship C1',
      status: 'working',
      priority: 'high',
      dueAt: 1_800_000_000_000,
      updatedAt: 1_799_999_999_999,
      requesterUserId: 'user-1',
      readScope: ['private'],
      writeScope: ['owner'],
      content: 'private conversation body',
      workspacePath: '/Users/private/repo',
      filePath: '/Users/private/repo/secret.txt',
      files: ['/Users/private/repo/secret.txt'],
    });

    expect(Object.keys(cloudPayload).sort()).toEqual(
      [...COLLAB_CARD_METADATA_FIELDS].sort(),
    );
    expect(cloudPayload).not.toHaveProperty('readScope');
    expect(cloudPayload).not.toHaveProperty('writeScope');
    expect(cloudPayload).not.toHaveProperty('content');
    expect(cloudPayload).not.toHaveProperty('workspacePath');
    expect(cloudPayload).not.toHaveProperty('filePath');
    expect(cloudPayload).not.toHaveProperty('files');
  });
});
