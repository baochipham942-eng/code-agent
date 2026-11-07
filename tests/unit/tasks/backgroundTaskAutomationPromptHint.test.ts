import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  error: undefined as Error | undefined,
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => {
      if (configMock.error) throw configMock.error;
      return { ui: { language: configMock.language } };
    },
  }),
}));

import { BackgroundTaskLedger } from '../../../src/host/task/backgroundTaskLedger';
import type { BackgroundTaskRecoveryPlan } from '../../../src/host/task/backgroundTaskRecoveryPlan';
import { syncShellTaskSnapshotToLedger } from '../../../src/host/task/backgroundTaskSnapshotAdapters';
import { shutdownEventBus } from '../../../src/host/services/eventing/bus';
import type { TaskInfo } from '../../../src/host/tools/modules/shell/backgroundTaskSources';

interface ProjectedFailure {
  summary: string;
  notification: string;
}

function projectFailure(task: TaskInfo): ProjectedFailure {
  const ledger = new BackgroundTaskLedger();
  syncShellTaskSnapshotToLedger(task, ledger);
  const projected = ledger.getTask(`shell:${task.taskId}`);
  const plan = projected?.metadata?.recoveryPlan as BackgroundTaskRecoveryPlan | undefined;
  const notification = task.sessionId
    ? ledger.drainNotifications(task.sessionId)[0]
    : undefined;
  if (!plan || !notification) throw new Error('failed shell fixture was not projected');
  return { summary: plan.summary, notification: notification.message };
}

function failedFixture(overrides: Partial<TaskInfo>): TaskInfo {
  return {
    taskId: 'realrun36-shell',
    status: 'failed',
    command: 'osascript -e \'error "AppleEvent timed out. (-1712)" number -1712\'',
    cwd: '/repo',
    sessionId: 'realrun36-session',
    startTime: 1_000,
    endTime: 121_000,
    duration: 120_000,
    exitCode: 1,
    outputFile: '',
    ...overrides,
  };
}

describe.each([
  {
    locale: 'zh' as const,
    cause: '可能一直在等待无人处理的 macOS「自动化」授权框，随后超时',
    action: '「系统设置」>「隐私与安全性」>「自动化」中允许 Agent Neo',
    dismiss: '系统授权框可能还在屏幕上，请手动点掉或点「不允许」。',
  },
  {
    locale: 'en' as const,
    cause: 'probably waited for an unanswered macOS Automation prompt and timed out',
    action: 'System Settings > Privacy & Security > Automation, allow Agent Neo',
    dismiss: 'A system permission prompt may still be on screen; dismiss it or choose Don\'t Allow.',
  },
])('background shell Automation prompt hint in $locale', ({ locale, cause, action, dismiss }) => {
  let tempDir: string;

  beforeEach(async () => {
    configMock.language = locale;
    configMock.error = undefined;
    tempDir = await mkdtemp(path.join(tmpdir(), `automation-prompt-${locale}-`));
  });

  afterEach(async () => {
    shutdownEventBus();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('flags the named -1712 exit-1 fixture and adds the cause plus next steps', async () => {
    const outputFile = path.join(tempDir, 'appleevent-timeout.log');
    await writeFile(
      outputFile,
      `${'old output\n'.repeat(600)}execution error: AppleEvent timed out. (-1712)\n`,
      'utf8',
    );

    const result = projectFailure(failedFixture({ outputFile }));

    for (const text of [result.summary, result.notification]) {
      expect(text).toContain(cause);
      expect(text).toContain(action);
      expect(text).toContain(dismiss);
    }
  });

  it('flags the 629-second no-exit empty-log fixture because that abrupt shape has no contrary signal', async () => {
    const outputFile = path.join(tempDir, 'empty-after-timeout.log');
    await writeFile(outputFile, '', 'utf8');

    const result = projectFailure(failedFixture({
      taskId: 'realrun36-long-shell',
      endTime: 630_000,
      duration: 629_000,
      exitCode: undefined,
      outputFile,
    }));

    expect(result.summary).toContain(cause);
    expect(result.notification).toContain(action);
  });

  it('keeps syntax and unrelated exit-1 failures byte-identical', async () => {
    const syntaxLog = path.join(tempDir, 'syntax-error.log');
    const unrelatedLog = path.join(tempDir, 'unrelated-error.log');
    await writeFile(syntaxLog, 'execution error: Expected expression. (-2741)\n', 'utf8');
    await writeFile(unrelatedLog, 'npm ERR! test failed\n', 'utf8');
    const originalSummary = '任务失败，退出码 1，可打开日志后重跑。';

    const syntax = projectFailure(failedFixture({
      taskId: 'osascript-syntax',
      command: 'osascript -e \'foo\'',
      outputFile: syntaxLog,
    }));
    const unrelated = projectFailure(failedFixture({
      taskId: 'plain-failure',
      command: 'npm test',
      outputFile: unrelatedLog,
    }));

    expect(syntax.summary).toBe(originalSummary);
    expect(unrelated.summary).toBe(originalSummary);
    expect(syntax.notification).toBe(
      `osascript -e 'foo' 失败，退出码 1，耗时 2 分钟，日志 ${syntaxLog}`,
    );
    expect(unrelated.notification).toBe(
      `npm test 失败，退出码 1，耗时 2 分钟，日志 ${unrelatedLog}`,
    );
  });
});

describe('background shell Automation prompt hint fallbacks', () => {
  let tempDir: string;

  beforeEach(async () => {
    configMock.language = 'en';
    configMock.error = undefined;
    tempDir = await mkdtemp(path.join(tmpdir(), 'automation-prompt-fallback-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    shutdownEventBus();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('treats an unreadable log as no signal and records a distinguishable warning', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = projectFailure(failedFixture({
      taskId: 'unreadable-log',
      exitCode: undefined,
      outputFile: path.join(tempDir, 'does-not-exist.log'),
    }));

    expect(result.summary).toBe('任务失败，可打开日志后重跑。');
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Could not inspect shell log for a macOS Automation timeout'),
      expect.objectContaining({ reason: 'automation_prompt_log_tail_read_failed' }),
    );
  });

  it('falls back to the Chinese hint and warns when the UI locale cannot be read', async () => {
    const outputFile = path.join(tempDir, 'appleevent-timeout.log');
    await writeFile(outputFile, 'AppleEvent timed out. (-1712)\n', 'utf8');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    configMock.error = new Error('settings unavailable');

    const result = projectFailure(failedFixture({ taskId: 'locale-fallback', outputFile }));

    expect(result.summary).toContain('这条命令可能一直在等待无人处理的 macOS「自动化」授权框');
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read UI locale for macOS Automation failure hint'),
      expect.objectContaining({ reason: 'automation_prompt_locale_read_failed' }),
    );
  });
});
