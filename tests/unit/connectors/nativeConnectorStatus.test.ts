import { describe, expect, it, vi } from 'vitest';

const osascriptMocks = vi.hoisted(() => ({
  runAppleScript: vi.fn(async () => 'Work\nPersonal'),
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
import { ConnectorRegistry } from '../../../src/main/connectors/registry';

describe('native office connector lazy status', () => {
  const platformReadiness = process.platform === 'darwin' ? 'unchecked' : 'unavailable';

  it('keeps mail status side-effect free on startup', async () => {
    const status = await mailConnector.getStatus();

    expect(status).toMatchObject({
      connected: false,
      readiness: platformReadiness,
      capabilities: mailConnector.capabilities,
    });
    if (process.platform === 'darwin') {
      expect(status.actions).toEqual(['repair_permissions', 'disconnect', 'remove']);
    }
    expect(status.detail).toContain(process.platform === 'darwin' ? '还未检查本地授权' : '仅在 macOS 可用');
    expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
  });

  it('keeps reminders status side-effect free on startup', async () => {
    const status = await remindersConnector.getStatus();

    expect(status).toMatchObject({
      connected: false,
      readiness: platformReadiness,
      capabilities: remindersConnector.capabilities,
    });
    if (process.platform === 'darwin') {
      expect(status.actions).toEqual(['repair_permissions', 'disconnect', 'remove']);
    }
    expect(status.detail).toContain(process.platform === 'darwin' ? '还未检查本地授权' : '仅在 macOS 可用');
    expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
  });

  it('keeps calendar status side-effect free on startup', async () => {
    const status = await calendarConnector.getStatus();

    expect(status).toMatchObject({
      connected: false,
      readiness: platformReadiness,
      capabilities: calendarConnector.capabilities,
    });
    if (process.platform === 'darwin') {
      expect(status.actions).toEqual(['repair_permissions', 'disconnect', 'remove']);
    }
    expect(status.detail).toContain(process.platform === 'darwin' ? '还未检查本地授权' : '仅在 macOS 可用');
    expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
  });

  it('runs the real native probe only when explicitly requested', async () => {
    osascriptMocks.runAppleScript.mockClear();

    if (process.platform !== 'darwin') {
      await expect(mailConnector.execute('probe_access', {})).rejects.toThrow('仅在 macOS 可用');
      expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
      return;
    }

    const result = await mailConnector.execute('probe_access', {});
    const status = result.data as Awaited<ReturnType<typeof mailConnector.getStatus>>;

    expect(osascriptMocks.runAppleScript).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      connected: true,
      readiness: 'ready',
    });
    expect(result.summary).toContain('检查通过');
  });

  it('routes native permission repair through an explicit lifecycle action', async () => {
    osascriptMocks.runAppleScript.mockClear();

    if (process.platform !== 'darwin') {
      await expect(calendarConnector.execute('repair_permissions', {})).rejects.toThrow('仅在 macOS 可用');
      expect(osascriptMocks.runAppleScript).not.toHaveBeenCalled();
      return;
    }

    const result = await calendarConnector.execute('repair_permissions', {});
    const status = result.data as Awaited<ReturnType<typeof calendarConnector.getStatus>>;

    expect(osascriptMocks.runAppleScript).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      connected: true,
      readiness: 'ready',
      actions: ['disconnect', 'remove'],
    });
    expect(result.summary).toContain('权限修复检查通过');
  });

  it('resets cached native readiness when the connector is disabled', async () => {
    osascriptMocks.runAppleScript.mockClear();

    if (process.platform !== 'darwin') {
      const registry = new ConnectorRegistry();
      registry.configure(['mail']);
      expect(await registry.get('mail')?.getStatus()).toMatchObject({ readiness: 'unavailable' });
      return;
    }

    const registry = new ConnectorRegistry();
    registry.configure(['mail']);

    await mailConnector.execute('probe_access', {});
    expect(await registry.get('mail')?.getStatus()).toMatchObject({
      connected: true,
      readiness: 'ready',
    });

    registry.configure([]);
    registry.configure(['mail']);

    expect(await registry.get('mail')?.getStatus()).toMatchObject({
      connected: false,
      readiness: 'unchecked',
    });
    expect(osascriptMocks.runAppleScript).toHaveBeenCalledTimes(1);
  });
});
