import { describe, expect, it, vi } from 'vitest';

const osascriptMocks = vi.hoisted(() => ({
  runAppleScript: vi.fn(async () => 'should not be called'),
}));

vi.mock('../../../src/main/connectors/native/osascript', () => ({
  runAppleScript: osascriptMocks.runAppleScript,
  escapeAppleScriptString: (value: string) => value,
  parseAppleScriptDate: () => null,
  buildAppleScriptDateVar: () => [],
  sharedAppleScriptHandlers: () => [],
}));

import { mailConnector } from '../../../src/main/connectors/native/mail';
import { remindersConnector } from '../../../src/main/connectors/native/reminders';
import { calendarConnector } from '../../../src/main/connectors/native/calendar';

describe('native office connector lazy status', () => {
  it('keeps mail status side-effect free on startup', async () => {
    const status = await mailConnector.getStatus();

    expect(status).toMatchObject({
      connected: process.platform === 'darwin',
      capabilities: mailConnector.capabilities,
    });
    expect(status.detail).toContain('避免启动时拉起 Mail');
    expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
  });

  it('keeps reminders status side-effect free on startup', async () => {
    const status = await remindersConnector.getStatus();

    expect(status).toMatchObject({
      connected: process.platform === 'darwin',
      capabilities: remindersConnector.capabilities,
    });
    expect(status.detail).toContain('避免启动时拉起 Reminders');
    expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
  });

  it('keeps calendar status side-effect free on startup', async () => {
    const status = await calendarConnector.getStatus();

    expect(status).toMatchObject({
      connected: process.platform === 'darwin',
      capabilities: calendarConnector.capabilities,
    });
    expect(status.detail).toContain('避免启动时拉起 Calendar');
    expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
  });
});
