import { describe, expect, it } from 'vitest';
import type { UpdateInfo } from '../../../src/shared/contract';
import {
  getVisibleUpdateInfo,
  shouldClearUpdateInfoBeforeCheck,
} from '../../../src/renderer/components/features/settings/tabs/UpdateSettings';

const upToDateInfo: UpdateInfo = {
  hasUpdate: false,
  currentVersion: '0.16.75',
};

const availableUpdateInfo: UpdateInfo = {
  hasUpdate: true,
  currentVersion: '0.16.75',
  latestVersion: '0.16.76',
};

describe('UpdateSettings status visibility', () => {
  it('hides stale success status while a fresh check is running or failed', () => {
    expect(getVisibleUpdateInfo(upToDateInfo, false, null)).toBe(upToDateInfo);
    expect(getVisibleUpdateInfo(upToDateInfo, true, null)).toBeNull();
    expect(getVisibleUpdateInfo(upToDateInfo, false, '检查更新失败，请稍后重试')).toBeNull();
  });

  it('clears stale no-update results before rechecking while preserving known update availability', () => {
    expect(shouldClearUpdateInfoBeforeCheck(null)).toBe(true);
    expect(shouldClearUpdateInfoBeforeCheck(upToDateInfo)).toBe(true);
    expect(shouldClearUpdateInfoBeforeCheck(availableUpdateInfo)).toBe(false);
  });
});
