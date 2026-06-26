import { describe, expect, it } from 'vitest';
import { matchDangerousBash } from '../../../src/host/planning/matchers';
import type { HookContext } from '../../../src/host/planning/types';

// Dedicated file (separate from matchers.test.ts) for the rm long/mixed-flag
// hardening, so it doesn't collide with parallel edits to matchers.test.ts.
const m = matchDangerousBash();
const ctx = (command: string): HookContext => ({ toolName: 'bash', toolParams: { command } });

describe('matchDangerousBash — rm long/short/mixed flags', () => {
  it.each([
    'rm -rf /',
    'rm -fr /',
    'rm -r -f /',
    'rm --recursive /',
    'rm --recursive --force /',
    'rm --force --recursive ~',
    'rm -r --force ~/Library',
    'rm -rf *',
    'rm --recursive --force *',
    'rm --recursive --force --interactive=never /', // =value long option
  ])('flags dangerous rm: %s', (command) => {
    expect(m(ctx(command))).toBe(true);
  });

  it.each([
    'rm file.txt',           // relative, no flags → not this matcher's concern
    'npm install lodash',    // unrelated
    'ls -la /',              // not rm
    'confirm --recursive /', // "rm" as a substring of confirm → word boundary
  ])('does not over-flag: %s', (command) => {
    expect(m(ctx(command))).toBe(false);
  });
});
