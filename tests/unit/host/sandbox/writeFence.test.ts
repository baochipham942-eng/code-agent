import { afterEach, describe, expect, it } from 'vitest';
import {
  isFencedInProjectWriteEligible,
  isOsWriteFenceAvailable,
  setOsWriteFenceAvailableOverride,
} from '../../../../src/host/sandbox/writeFence';
import { getSandboxManager } from '../../../../src/host/sandbox';

const context = { workingDirectory: '/tmp/proj', workspaceRoot: '/tmp/proj' };

describe('writeFence eligibility', () => {
  afterEach(() => {
    setOsWriteFenceAvailableOverride(undefined);
  });

  it('rejects quoted redirect targets including quotes after the path', () => {
    expect(isFencedInProjectWriteEligible('printf x > "/tmp/proj/out.txt"', context)).toBe(false);
    expect(isFencedInProjectWriteEligible("printf x > /tmp/proj/'o'", context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/"a"/"b"', context)).toBe(false);
  });

  it('rejects lookup and startup-file assignments that can change what runs', () => {
    expect(isFencedInProjectWriteEligible('PATH=/tmp/bin tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('BASH_ENV=/tmp/evil tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('ENV=/tmp/evil tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('SHELLOPTS=xtrace tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('BASH_FUNC_foo%%=() { :; } tee /tmp/proj/out.txt', context)).toBe(false);
  });

  it('keeps ordinary in-project printf/tee writes eligible', () => {
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/out.txt', context)).toBe(true);
    expect(isFencedInProjectWriteEligible('MODE=1 tee /tmp/proj/mode.txt', context)).toBe(true);
  });

  it('override pins fence availability independently of the host OS', () => {
    setOsWriteFenceAvailableOverride(true);
    expect(isOsWriteFenceAvailable()).toBe(true);
    setOsWriteFenceAvailableOverride(false);
    expect(isOsWriteFenceAvailable()).toBe(false);
    setOsWriteFenceAvailableOverride(undefined);
    expect(isOsWriteFenceAvailable()).toBe(getSandboxManager().isAvailable() && process.platform !== 'win32');
  });
});
