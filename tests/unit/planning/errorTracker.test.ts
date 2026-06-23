import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ErrorTracker } from '../../../src/main/planning/errorTracker';
import { CONFIG_DIR_NEW } from '../../../src/main/config/configPaths';
import type { PlanningConfig } from '../../../src/main/planning/types';

let workingDirectory: string;
const SESSION_ID = 'sess-err';

const makeConfig = (): PlanningConfig => ({ workingDirectory, sessionId: SESSION_ID });

const errorsFile = () =>
  path.join(workingDirectory, CONFIG_DIR_NEW, 'plans', SESSION_ID, 'errors.md');

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'error-tracker-'));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true });
});

describe('ErrorTracker.log + getErrorCount', () => {
  it('records a new error with count 1 and persists to disk', async () => {
    const tracker = new ErrorTracker(makeConfig());
    await tracker.log({ toolName: 'bash', message: 'command failed' });

    expect(await tracker.getErrorCount('bash', 'command failed')).toBe(1);
    const md = await fs.readFile(errorsFile(), 'utf-8');
    expect(md).toContain('ERRORS_JSON');
    expect(md).toContain('command failed');
  });

  it('increments count for the same error key instead of duplicating', async () => {
    const tracker = new ErrorTracker(makeConfig());
    await tracker.log({ toolName: 'bash', message: 'boom' });
    await tracker.log({ toolName: 'bash', message: 'boom' });
    await tracker.log({ toolName: 'bash', message: 'boom' });

    expect(await tracker.getErrorCount('bash', 'boom')).toBe(3);
    expect(await tracker.getAll()).toHaveLength(1);
  });

  it('normalizes numbers and quoted strings so similar errors collapse', async () => {
    const tracker = new ErrorTracker(makeConfig());
    // Differ only by numbers and quoted literals → same normalized key.
    await tracker.log({ toolName: 'bash', message: "file '/a/b' line 12 failed" });
    await tracker.log({ toolName: 'bash', message: "file '/c/d' line 99 failed" });

    expect(await tracker.getAll()).toHaveLength(1);
    expect(await tracker.getErrorCount('bash', "file '/a/b' line 12 failed")).toBe(2);
  });

  it('treats different tools as distinct keys', async () => {
    const tracker = new ErrorTracker(makeConfig());
    await tracker.log({ toolName: 'bash', message: 'same' });
    await tracker.log({ toolName: 'write_file', message: 'same' });

    expect(await tracker.getAll()).toHaveLength(2);
    expect(await tracker.getErrorCount('bash', 'same')).toBe(1);
    expect(await tracker.getErrorCount('write_file', 'same')).toBe(1);
  });

  it('returns 0 for an error that was never logged', async () => {
    const tracker = new ErrorTracker(makeConfig());
    expect(await tracker.getErrorCount('bash', 'never')).toBe(0);
  });
});

describe('ErrorTracker.hasReachedStrikeLimit (3-strike rule)', () => {
  it('is false below the limit and true at/above it', async () => {
    const tracker = new ErrorTracker(makeConfig());
    await tracker.log({ toolName: 'bash', message: 'strike' });
    await tracker.log({ toolName: 'bash', message: 'strike' });
    expect(await tracker.hasReachedStrikeLimit('bash', 'strike')).toBe(false);

    await tracker.log({ toolName: 'bash', message: 'strike' });
    expect(await tracker.hasReachedStrikeLimit('bash', 'strike')).toBe(true);
  });

  it('respects a custom limit', async () => {
    const tracker = new ErrorTracker(makeConfig());
    await tracker.log({ toolName: 'bash', message: 'x' });
    await tracker.log({ toolName: 'bash', message: 'x' });
    expect(await tracker.hasReachedStrikeLimit('bash', 'x', 2)).toBe(true);
    expect(await tracker.hasReachedStrikeLimit('bash', 'x', 5)).toBe(false);
  });
});

describe('ErrorTracker.getRecentErrors', () => {
  it('filters by tool and respects the limit', async () => {
    const tracker = new ErrorTracker(makeConfig());
    await tracker.log({ toolName: 'bash', message: 'a' });
    await tracker.log({ toolName: 'write_file', message: 'b' });
    await tracker.log({ toolName: 'bash', message: 'c' });

    // Order within the same millisecond is a tie, so assert membership not order.
    const bashErrors = await tracker.getRecentErrors('bash');
    expect(bashErrors.map((e) => e.message).sort()).toEqual(['a', 'c']);
    expect(bashErrors.every((e) => e.toolName === 'bash')).toBe(true);

    const limited = await tracker.getRecentErrors(undefined, 1);
    expect(limited).toHaveLength(1);
  });
});

describe('ErrorTracker persistence + clearing', () => {
  it('reloads errors from disk in a fresh instance', async () => {
    const first = new ErrorTracker(makeConfig());
    await first.log({ toolName: 'bash', message: 'persisted', params: { a: 1 } });

    const second = new ErrorTracker(makeConfig());
    const all = await second.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].message).toBe('persisted');
    expect(all[0].params).toEqual({ a: 1 });
  });

  it('starts fresh when no file exists yet', async () => {
    const tracker = new ErrorTracker(makeConfig());
    expect(await tracker.getAll()).toEqual([]);
  });

  it('falls back to empty when the persisted JSON is corrupt', async () => {
    await fs.mkdir(path.dirname(errorsFile()), { recursive: true });
    await fs.writeFile(errorsFile(), '<!-- ERRORS_JSON: {not valid json -->', 'utf-8');

    const tracker = new ErrorTracker(makeConfig());
    expect(await tracker.getAll()).toEqual([]);
  });

  it('clear() removes all errors and persists the empty state', async () => {
    const tracker = new ErrorTracker(makeConfig());
    await tracker.log({ toolName: 'bash', message: 'gone' });
    await tracker.clear();

    expect(await tracker.getAll()).toEqual([]);
    const md = await fs.readFile(errorsFile(), 'utf-8');
    expect(md).toContain('No errors recorded');
  });

  it('clearForTool() removes only the matching tool entries', async () => {
    const tracker = new ErrorTracker(makeConfig());
    await tracker.log({ toolName: 'bash', message: 'b1' });
    await tracker.log({ toolName: 'write_file', message: 'w1' });
    await tracker.clearForTool('bash');

    const all = await tracker.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].toolName).toBe('write_file');
  });

  it('marks 3-strike entries in the rendered markdown', async () => {
    const tracker = new ErrorTracker(makeConfig());
    for (let i = 0; i < 3; i++) {
      await tracker.log({ toolName: 'bash', message: 'repeat', params: { n: i } });
    }
    const md = await fs.readFile(errorsFile(), 'utf-8');
    expect(md).toContain('[3-STRIKE]');
    expect(md).toContain('**Params:**');
  });
});
