import { describe, expect, it } from 'vitest';
import {
  EXPERT_THREAD_METADATA_KEY,
  readPersistedExpertThread,
} from '../../../src/shared/contract/expertThread';

describe('expertThread session metadata contract', () => {
  it('reads a valid marker and rejects malformed values', () => {
    expect(readPersistedExpertThread({
      [EXPERT_THREAD_METADATA_KEY]: { roleId: '牧之', setAt: 42 },
    })).toEqual({ roleId: '牧之', setAt: 42 });
    expect(readPersistedExpertThread({ [EXPERT_THREAD_METADATA_KEY]: { roleId: '', setAt: 42 } })).toBeNull();
    expect(readPersistedExpertThread({ [EXPERT_THREAD_METADATA_KEY]: { roleId: '牧之' } })).toBeNull();
  });
});
