import { describe, expect, it, vi } from 'vitest';

const osascriptMocks = vi.hoisted(() => ({
  runAppleScript: vi.fn(async () => 'Work\nPersonal'),
}));

vi.mock('../../../src/host/connectors/native/osascript', async (importOriginal) => ({
  ...(await (async () => {
    const real = await importOriginal<typeof import('../../../src/host/connectors/native/osascript')>();
    return { describeAppleScriptFailure: real.describeAppleScriptFailure, isAppleScriptFailure: real.isAppleScriptFailure };
  })()),
  runAppleScript: osascriptMocks.runAppleScript,
  escapeAppleScriptString: (value: string) => value,
  parseAppleScriptDate: () => null,
  buildAppleScriptDateVar: () => [],
  sharedAppleScriptHandlers: () => [],
}));

import { mailConnector } from '../../../src/host/connectors/native/mail';
import { remindersConnector } from '../../../src/host/connectors/native/reminders';
import { calendarConnector } from '../../../src/host/connectors/native/calendar';
import { ConnectorRegistry } from '../../../src/host/connectors/registry';

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
      // 平台过滤注册：非 macOS 上 configure 不注册原生 connector（windows-support.md §1.5）
      const registry = new ConnectorRegistry();
      registry.configure(['mail']);
      expect(registry.get('mail')).toBeUndefined();
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

  it('flags ready-but-empty listings on the status itself (repairPermission discards the execute summary)', async () => {
    osascriptMocks.runAppleScript.mockClear();

    if (process.platform !== 'darwin') {
      await expect(remindersConnector.execute('repair_permissions', {})).rejects.toThrow('仅在 macOS 可用');
      return;
    }

    // 授权通过但列表为空：osascript 正常返回空输出（不是抛错）
    osascriptMocks.runAppleScript.mockResolvedValue('');
    await remindersConnector.execute('repair_permissions', {});

    // repairPermission 的 IPC 回执是 handleListStatuses() → getStatus()，「没有找到可访问…」
    // 只在被丢弃的 execute summary 里；空列表信号必须挂在状态上，否则渲染层永远看不到
    expect(await remindersConnector.getStatus()).toMatchObject({
      connected: true,
      readiness: 'ready',
      noAccessibleItems: true,
    });

    // 非空列表不许误报
    osascriptMocks.runAppleScript.mockResolvedValue('Work\nPersonal');
    await calendarConnector.execute('repair_permissions', {});
    expect(await calendarConnector.getStatus()).toMatchObject({
      connected: true,
      readiness: 'ready',
      noAccessibleItems: false,
    });
  });

  it.runIf(process.platform === 'darwin')('keeps script text out of the failed status detail (session_1793802444569_5eb4b15b shape)', async () => {
    const script = 'tell application "Calendar"\nset outputLines to {}\nreturn my joinLines(outputLines)\nend tell';
    const raw = Object.assign(
      new Error(`Command failed: osascript -e ${script}\n0:5: execution error: Calendar got an error: Not authorized to send Apple events to Calendar. (-1743)`),
      { code: 1 },
    );
    for (const connector of [calendarConnector, mailConnector, remindersConnector]) {
      osascriptMocks.runAppleScript.mockRejectedValueOnce(raw);
      await expect(connector.execute('repair_permissions', {})).rejects.toBe(raw);
      const status = await connector.getStatus();
      expect(status.readiness).toBe('failed');
      const text = `${status.detail}\n${status.error}`;
      expect(text).not.toMatch(/osascript|Command failed|tell application|outputLines/);
      expect(status.detail).toContain('检查失败');
      expect(status.detail).toContain('自动化');
    }
  });
});
