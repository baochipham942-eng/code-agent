import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';

const configState = vi.hoisted(() => ({ language: 'zh' }));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: configState.language } }) }),
}));

import { describeAppleScriptFailure } from '../../../src/host/connectors/native/osascript';

const SCRIPT = 'tell application "Mail"\nset x to every mailbox\nend tell';
const FORBIDDEN = /osascript|Command failed|tell application|every mailbox/;

function execError(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Command failed: osascript -e ${SCRIPT}\n${stderr}`), { stderr, ...extra });
}

describe('describeAppleScriptFailure', () => {
  beforeEach(() => { configState.language = 'zh'; });

  const cases: Array<[string, Error, string, RegExp, RegExp]> = [
    ['-1743', execError('Not authorized to send Apple events to Mail. (-1743)'), 'not_authorized', /系统设置.*自动化/, /System Settings > Privacy & Security > Automation/],
    ['-1728', execError('Mail got an error: Can\'t get mailbox "INBOX". (-1728)'), 'not_found', /检查对应账户/, /Check that the account/],
    ['timeout', execError('', { killed: true, signal: 'SIGTERM' }), 'timeout', /稍后重试/, /try again later/],
    ['unknown', execError('syntax error (-2741)', { code: 1 }), 'read_failed', /读取失败，请稍后重试/, /Read failed, please try again later/],
  ];

  it.each(cases)('maps %s to a distinct plain reason (zh + en)', (_n, err, code, zh, en) => {
    const a = describeAppleScriptFailure('Mail', err);
    expect(a.code).toBe(code);
    expect(a.message).toMatch(zh);
    expect(a.message).not.toMatch(FORBIDDEN);
    configState.language = 'en';
    const b = describeAppleScriptFailure('Mail', err);
    expect(b.message).toMatch(en);
    expect(b.message).not.toMatch(FORBIDDEN);
    expect(b.message).not.toBe(a.message);
  });

  it('treats ETIMEDOUT code as timeout', () => {
    expect(describeAppleScriptFailure('Mail', Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).code).toBe('timeout');
  });

  it.runIf(process.platform === 'darwin')('stays clean for a genuine osascript exception', async () => {
    let caught: unknown;
    try {
      await promisify(execFile)('osascript', ['-e', 'this is not valid applescript (((']);
    } catch (e) { caught = e; }
    expect((caught as Error).message).toMatch(/Command failed/);
    const r = describeAppleScriptFailure('Mail', caught);
    expect(r.message).not.toMatch(/osascript|Command failed|tell application|applescript \(\(\(/i);
  });
});
