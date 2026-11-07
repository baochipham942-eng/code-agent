// ============================================================================
// sessionReplayFormatters 时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1）：
// 会话回放摘要（SessionReplaySummaryDialog）的 run/task 元信息与 event 兜底时间
// 改走 utils/formatDateTime(value, lang)，lang 由调用方（dialog）传入；
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { ScriptRunSnapshot } from '../../../src/shared/contract/scriptRun';
import type { Task, TaskEvent } from '../../../src/shared/contract/backgroundTask';
import {
  formatBackgroundTaskMeta,
  formatTaskEventDetail,
  formatWorkflowRunMeta,
} from '../../../src/renderer/components/features/sidebar/sessionReplayFormatters';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const STARTED = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const FINISHED = new Date(2026, 10, 9, 17, 30, 0).getTime(); // 2026-11-09 17:30

const SNAPSHOT: ScriptRunSnapshot = {
  runId: 'run-1',
  status: 'completed',
  phases: [],
  logs: [],
  agents: [],
  runningCount: 0,
  doneCount: 1,
  errorCount: 0,
  startedAt: STARTED,
  finishedAt: FINISHED,
};

const TASK: Task = {
  id: 'task-1',
  source: 'test',
  title: 'Background task',
  status: 'completed',
  createdAt: STARTED,
  updatedAt: FINISHED,
  startedAt: STARTED,
  events: [],
  outputRefs: [],
};

// 无 message/data 的 event 走时间兜底分支（原裸 toLocaleTimeString）。
const EVENT: TaskEvent = {
  id: 'event-1',
  taskId: 'task-1',
  type: 'log',
  timestamp: STARTED,
};

describe('sessionReplayFormatters 时间口径（跟随 UI language）', () => {
  it('zh：run 元信息 24 小时制带年份，无 AM/PM', () => {
    const line = formatWorkflowRunMeta(SNAPSHOT, zh.sessionReplay, 'zh');
    expect(line).toContain('开始 2026/11/09 16:05');
    expect(line).toContain('结束 2026/11/09 17:30');
    expect(line).not.toMatch(/AM|PM/);
  });

  it('en：维持 en-US 原样（英文 UI 行为不变）', () => {
    const line = formatWorkflowRunMeta(SNAPSHOT, en.sessionReplay, 'en');
    expect(line).toContain('started 11/9/2026, 4:05:00 PM');
    expect(line).toContain('finished 11/9/2026, 5:30:00 PM');
  });

  it('zh：task 元信息同样走 24 小时制', () => {
    const line = formatBackgroundTaskMeta(TASK, zh.sessionReplay, 'zh');
    expect(line).toContain('task task-1');
    expect(line).toContain('开始 2026/11/09 16:05');
    expect(line).toContain('更新 2026/11/09 17:30');
    expect(line).not.toMatch(/AM|PM/);
  });

  it('event 兜底时间：zh 24 小时制 / en en-US，跟 lang 参数走', () => {
    expect(formatTaskEventDetail(EVENT, 'zh')).toBe('2026/11/09 16:05');
    expect(formatTaskEventDetail(EVENT, 'en')).toBe('11/9/2026, 4:05:00 PM');
  });
});
