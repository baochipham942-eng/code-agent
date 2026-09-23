// 自动档限流：同一会话连续或窗口内自动拦截达阈值后，免确认档钳到 default，
// 无人值守审批从 60s 终态改为停车挂起。阈值来自 AUTO_MODE_RATE_LIMIT，不读设置。

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { AUTO_MODE_RATE_LIMIT } from '../../../src/shared/constants/timeouts';

const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() }),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    appendPermissionDecision: () => {},
    appendToolExecutionBegin: () => {},
    appendToolExecutionComplete: () => {},
  }),
}));

import {
  getPermissionModeManager,
  resetPermissionModeManager,
} from '../../../src/host/permissions/modes';
import {
  getDecisionHistory,
  resetDecisionHistory,
  isAutoDenyOutcome,
  type DecisionOutcome,
} from '../../../src/host/security/decisionHistory';
import { recordDecision } from '../../../src/host/tools/toolExecutorDecisionTrace';

const tmpDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'auto-mode-rate-limit-'));
const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
process.env.CODE_AGENT_DATA_DIR = tmpDataDir;
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

const SESSION = 'session-s';
const OTHER = 'session-t';

function push(sessionId: string | undefined, outcome: DecisionOutcome): void {
  recordDecision('Bash', { command: 'rm -rf /tmp/auto-mode-rate-limit' }, outcome, outcome, Date.now(), undefined, sessionId);
}

function deny(sessionId: string, outcome: DecisionOutcome = 'policy-deny'): void {
  push(sessionId, outcome);
}

describe('自动档限流', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    resetDecisionHistory();
    warn.mockClear();
    fs.rmSync(nodePath.join(tmpDataDir, 'session-permission-modes.json'), { force: true });
  });
  afterEach(() => resetPermissionModeManager());

  it('acceptEdits 连续 3 次自动拦截后，第 4 次 getModeForSession 返回 default', () => {
    const manager = getPermissionModeManager();
    manager.setSessionMode(SESSION, 'acceptEdits');
    expect(manager.getModeForSession(SESSION)).toBe('acceptEdits');
    deny(SESSION, 'policy-deny');
    expect(manager.getModeForSession(SESSION)).toBe('acceptEdits');
    deny(SESSION, 'classifier-deny');
    expect(manager.getModeForSession(SESSION)).toBe('acceptEdits');
    deny(SESSION, 'hook-blocked');
    expect(manager.getModeForSession(SESSION)).toBe('default');
    expect(getDecisionHistory().getRecent(1)[0]?.sessionId).toBe(SESSION);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `AUTO_MODE_RATE_LIMITED sessionId=${SESSION} reason=consecutive count=${AUTO_MODE_RATE_LIMIT.CONSECUTIVE}`,
    );
    deny(SESSION, 'monitor-blocked');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(manager.getModeForSession(SESSION)).toBe('default');
  });

  it('bypassPermissions 连续 3 次自动拦截后同样钳到 default', () => {
    const manager = getPermissionModeManager();
    manager.setSessionMode(SESSION, 'bypassPermissions', true);
    expect(manager.getModeForSession(SESSION)).toBe('bypassPermissions');
    deny(SESSION);
    expect(manager.getModeForSession(SESSION)).toBe('bypassPermissions');
    deny(SESSION);
    expect(manager.getModeForSession(SESSION)).toBe('bypassPermissions');
    deny(SESSION);
    expect(manager.getModeForSession(SESSION)).toBe('default');
  });

  it('窗口内累计 19 次不触发，第 20 次触发', () => {
    const manager = getPermissionModeManager();
    manager.setSessionMode(SESSION, 'acceptEdits');
    const target = AUTO_MODE_RATE_LIMIT.WINDOW_COUNT;
    let denies = 0;
    while (denies < target - 1) {
      deny(SESSION, 'monitor-blocked');
      denies += 1;
      if (denies % 2 === 0) push(SESSION, 'ask-denied');
    }
    expect(getDecisionHistory().countConsecutiveAutoDenies(SESSION)).toBeLessThan(AUTO_MODE_RATE_LIMIT.CONSECUTIVE);
    expect(getDecisionHistory().countWindowAutoDenies(SESSION, AUTO_MODE_RATE_LIMIT.WINDOW_MS)).toBe(target - 1);
    expect(manager.getModeForSession(SESSION)).toBe('acceptEdits');
    expect(warn).not.toHaveBeenCalled();
    deny(SESSION, 'policy-deny');
    expect(getDecisionHistory().countWindowAutoDenies(SESSION, AUTO_MODE_RATE_LIMIT.WINDOW_MS)).toBe(target);
    expect(manager.getModeForSession(SESSION)).toBe('default');
    expect(warn).toHaveBeenCalledWith(
      `AUTO_MODE_RATE_LIMITED sessionId=${SESSION} reason=window count=${target}`,
    );
  });

  it('ask-denied 与 auto-approve 打断连续计数，且不计入窗口累计', () => {
    const manager = getPermissionModeManager();
    manager.setSessionMode(SESSION, 'acceptEdits');
    const history = getDecisionHistory();
    deny(SESSION);
    deny(SESSION);
    push(SESSION, 'ask-denied');
    expect(history.countConsecutiveAutoDenies(SESSION)).toBe(0);
    expect(history.countWindowAutoDenies(SESSION, AUTO_MODE_RATE_LIMIT.WINDOW_MS)).toBe(2);
    deny(SESSION);
    deny(SESSION);
    expect(history.countConsecutiveAutoDenies(SESSION)).toBe(2);
    expect(history.countWindowAutoDenies(SESSION, AUTO_MODE_RATE_LIMIT.WINDOW_MS)).toBe(4);
    expect(manager.getModeForSession(SESSION)).toBe('acceptEdits');
    push(SESSION, 'auto-approve');
    expect(history.countConsecutiveAutoDenies(SESSION)).toBe(0);
    expect(history.countWindowAutoDenies(SESSION, AUTO_MODE_RATE_LIMIT.WINDOW_MS)).toBe(4);
    push(SESSION, 'ask-approved');
    push(SESSION, 'policy-allow');
    expect(history.countWindowAutoDenies(SESSION, AUTO_MODE_RATE_LIMIT.WINDOW_MS)).toBe(4);
    expect(manager.getModeForSession(SESSION)).toBe('acceptEdits');
    expect(warn).not.toHaveBeenCalled();
  });

  it('会话 T 不受会话 S 的限流影响', () => {
    const manager = getPermissionModeManager();
    manager.setSessionMode(SESSION, 'acceptEdits');
    manager.setSessionMode(OTHER, 'bypassPermissions', true);
    deny(SESSION);
    deny(OTHER);
    push(undefined, 'policy-deny');
    deny(SESSION);
    deny(SESSION, 'classifier-deny');
    expect(getDecisionHistory().countConsecutiveAutoDenies(SESSION)).toBe(AUTO_MODE_RATE_LIMIT.CONSECUTIVE);
    expect(getDecisionHistory().countWindowAutoDenies(OTHER, AUTO_MODE_RATE_LIMIT.WINDOW_MS)).toBe(1);
    expect(getDecisionHistory().countConsecutiveAutoDenies(OTHER)).toBe(1);
    expect(manager.getModeForSession(SESSION)).toBe('default');
    expect(manager.getModeForSession(OTHER)).toBe('bypassPermissions');
  });

  it('无人值守会话触发后不再 60s 终态，且档位钳到 default', () => {
    const manager = getPermissionModeManager();
    manager.markUnattendedSession(SESSION);
    manager.markUnattendedApprovalTerminal(SESSION);
    manager.setSessionMode(SESSION, 'bypassPermissions', true);
    expect(manager.isUnattendedSession(SESSION)).toBe(true);
    expect(manager.isUnattendedApprovalTerminal(SESSION)).toBe(true);
    expect(manager.getModeForSession(SESSION)).toBe('acceptEdits');
    deny(SESSION);
    deny(SESSION);
    deny(SESSION, 'hook-blocked');
    expect(manager.isUnattendedApprovalTerminal(SESSION)).toBe(false);
    expect(manager.getModeForSession(SESSION)).toBe('default');
    expect(manager.isUnattendedSession(SESSION)).toBe(true);
  });

  it('readOnly 已更严，限流后原样；plan / dontAsk / delegate / default 同样不动', () => {
    const manager = getPermissionModeManager();
    manager.setSessionMode(SESSION, 'readOnly');
    deny(SESSION);
    deny(SESSION);
    deny(SESSION);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(manager.getModeForSession(SESSION)).toBe('readOnly');
    for (const mode of ['plan', 'dontAsk', 'delegate', 'default'] as const) {
      manager.setSessionMode(SESSION, mode);
      expect(manager.getModeForSession(SESSION)).toBe(mode);
    }
    manager.setSessionMode(SESSION, 'acceptEdits');
    expect(manager.getModeForSession(SESSION)).toBe('default');
    manager.setSessionMode(SESSION, 'bypassPermissions', true);
    expect(manager.getModeForSession(SESSION)).toBe('default');
  });

  it('窗口外的自动拦截不计入累计，history.record 本身不触发限流', () => {
    const manager = getPermissionModeManager();
    manager.setSessionMode(SESSION, 'acceptEdits');
    const history = getDecisionHistory();
    const stale = Date.now() - AUTO_MODE_RATE_LIMIT.WINDOW_MS - 1;
    for (let i = 0; i < AUTO_MODE_RATE_LIMIT.WINDOW_COUNT; i++) {
      history.record({
        timestamp: stale,
        toolName: 'Bash',
        summary: 'stale',
        outcome: 'policy-deny',
        reason: 'stale',
        durationMs: 1,
        sessionId: SESSION,
      });
    }
    expect(history.countWindowAutoDenies(SESSION, AUTO_MODE_RATE_LIMIT.WINDOW_MS)).toBe(0);
    expect(history.countConsecutiveAutoDenies(SESSION)).toBe(AUTO_MODE_RATE_LIMIT.WINDOW_COUNT);
    expect(manager.getModeForSession(SESSION)).toBe('acceptEdits');
    expect(warn).not.toHaveBeenCalled();
  });

  it('四种自动拦截计入，人拒和放行不计', () => {
    for (const outcome of ['policy-deny', 'classifier-deny', 'hook-blocked', 'monitor-blocked'] as const) {
      expect(isAutoDenyOutcome(outcome)).toBe(true);
    }
    for (const outcome of ['ask-denied', 'auto-approve', 'ask-approved', 'policy-allow'] as const) {
      expect(isAutoDenyOutcome(outcome)).toBe(false);
    }
  });
});
